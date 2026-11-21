//! Stress test for the usage ledger.
//!
//! Several pools stand in for several coordinator processes. Many meters run
//! at once. For every sequence number of a meter there are one or more
//! contenders (different batches that claim the same slot), and every volley
//! sends each contender of the next slot from several tasks at the same
//! moment, mixed with resends of old batches, batches ahead of the next one,
//! altered copies of applied batches, batch ids taken from other meters,
//! invalid batches and batches for meters that never apply anything. Some
//! requests are cancelled mid-flight and a killer ends random server sessions
//! mid-transaction.
//!
//! What has to hold at the end: every slot has exactly one winner, every
//! contender that was ever answered Applied is that winner, no slot was
//! answered Applied twice, the stored rows are the winners' rows line by line,
//! and the totals are the sum of every winner exactly once.
//!
//! Environment: LEDGER_STRESS_RUNS (default 1), LEDGER_STRESS_SEED (default: clock),
//! LEDGER_STRESS_KILLS=0 turns the killer off, LEDGER_STRESS_METERS, LEDGER_STRESS_SLOTS.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::str::FromStr;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use coronium_coordinator::ledger::{
    self, IngestError, Outcome, Refusal, Totals, UsageBatch, UsageLine,
};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use sqlx::{AssertSqlSafe, PgPool};
use uuid::Uuid;

const POOLS: usize = 4;
const CONNECTIONS_PER_POOL: u32 = 6;
const MOST: u64 = i64::MAX as u64;
const TWIN_ROUNDS: usize = 40;

struct Rng(u64);

impl Rng {
    fn draw(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut mixed = self.0;
        mixed = (mixed ^ (mixed >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        mixed = (mixed ^ (mixed >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        mixed ^ (mixed >> 31)
    }

    fn below(&mut self, bound: u64) -> u64 {
        self.draw() % bound
    }

    fn chance(&mut self, percent: u64) -> bool {
        self.below(100) < percent
    }

    fn uuid(&mut self) -> Uuid {
        Uuid::from_u128((u128::from(self.draw()) << 64) | u128::from(self.draw()))
    }
}

#[derive(Debug, Clone, PartialEq)]
enum Answer {
    Applied,
    AlreadyApplied,
    Gap(u64),
    Conflict,
    Invalid,
    /// The request ended without an answer: cancelled, or a database error.
    Unknown(String),
}

/// What a request is, which decides the answers it may get.
#[derive(Debug, Clone)]
enum Kind {
    Contender {
        slot: usize,
        index: usize,
    },
    /// An applied batch with something changed: always Conflict.
    Altered(&'static str),
    /// A batch id another meter already used, at the next seq or an old one: always Conflict.
    Stolen,
    /// The same, at a seq beyond the next: Conflict or Gap both fit the contract.
    StolenAhead,
    Invalid(&'static str),
    /// A meter that never applies anything, seq 2 or more: always Gap(1).
    Ghost,
    /// A meter that never applies anything, with a used batch id at seq 1: always Conflict.
    GhostStolen,
}

struct Request {
    kind: Kind,
    batch: UsageBatch,
    cancel_after: Option<Duration>,
}

struct Plan {
    meter_id: Uuid,
    /// slots[i] holds the contenders for seq i + 1. Contender 0 has an id of
    /// its own and is resent until the slot is settled.
    slots: Vec<Vec<UsageBatch>>,
}

#[derive(Default)]
struct Stats {
    counts: Mutex<BTreeMap<String, u64>>,
    failures: Mutex<Vec<String>>,
    kills: AtomicU64,
}

impl Stats {
    fn count(&self, key: &str) {
        *self
            .counts
            .lock()
            .unwrap()
            .entry(key.to_owned())
            .or_default() += 1;
    }

    fn fail(&self, message: String) {
        let mut failures = self.failures.lock().unwrap();
        if failures.len() < 40 {
            failures.push(message);
        }
    }
}

fn random_lines(rng: &mut Rng) -> Vec<UsageLine> {
    let count = 1 + rng.below(4);
    (0..count)
        .map(|device| {
            let mut line = UsageLine {
                // A few accounts shared by every meter; the device differs
                // within a batch, so no two lines share account and device.
                account_id: Uuid::from_u128(1 + u128::from(rng.below(6))),
                device_id: Uuid::from_u128(1_000 + u128::from(device)),
                requests: rng.below(1_000),
                bytes_up: rng.below(1 << 30),
                bytes_down: if rng.chance(10) {
                    (1 << 50) + rng.below(1 << 20)
                } else {
                    rng.below(1 << 40)
                },
            };
            if rng.chance(15) {
                line.requests = 0;
            }
            if rng.chance(10) {
                line.bytes_up = 0;
            }
            if line.requests == 0 && line.bytes_up == 0 && line.bytes_down == 0 {
                line.bytes_down = 1;
            }
            line
        })
        .collect()
}

fn make_plans(rng: &mut Rng, meters: usize, slots: usize) -> Vec<Plan> {
    let mut plans: Vec<Plan> = (0..meters)
        .map(|_| {
            let meter_id = rng.uuid();
            let slots = (0..slots)
                .map(|slot| {
                    let seq = slot as u64 + 1;
                    let clean = UsageBatch {
                        meter_id,
                        seq,
                        batch_id: rng.uuid(),
                        lines: random_lines(rng),
                    };
                    let mut contenders = vec![clean.clone()];
                    if rng.chance(25) {
                        // A rival: another batch with its own id for the same seq.
                        contenders.push(UsageBatch {
                            batch_id: rng.uuid(),
                            lines: random_lines(rng),
                            ..clean.clone()
                        });
                    }
                    if rng.chance(10) {
                        // A rival under the same batch id with other lines.
                        let mut lines = random_lines(rng);
                        lines[0].requests += 1_000_000;
                        contenders.push(UsageBatch {
                            lines,
                            ..clean.clone()
                        });
                    }
                    contenders
                })
                .collect();
            Plan { meter_id, slots }
        })
        .collect();

    // Twins: one batch id offered by two different meters.
    if meters >= 2 {
        for _ in 0..(meters * slots / 8).max(1) {
            let shared = rng.uuid();
            let first = rng.below(meters as u64) as usize;
            let mut second = rng.below(meters as u64) as usize;
            if second == first {
                second = (first + 1) % meters;
            }
            for meter in [first, second] {
                let slot = rng.below(slots as u64) as usize;
                let twin = UsageBatch {
                    meter_id: plans[meter].meter_id,
                    seq: slot as u64 + 1,
                    batch_id: shared,
                    lines: random_lines(rng),
                };
                plans[meter].slots[slot].push(twin);
            }
        }
    }
    plans
}

fn describe(error: &sqlx::Error) -> String {
    if let Some(database) = error.as_database_error() {
        let code = database
            .code()
            .map(|code| code.into_owned())
            .unwrap_or_default();
        return format!("db:{code}");
    }
    let text = format!("{error:?}");
    let name: String = text.chars().take_while(|c| c.is_alphanumeric()).collect();
    format!("sqlx:{name}")
}

/// What an ingest ends with when it gives up waiting for a lock. It is no
/// answer: nothing was stored, and the sender sends the batch again.
const GAVE_UP_WAITING: &str = "db:55P03";

/// An error that only a killed or cancelled connection explains.
fn excusable(description: &str) -> bool {
    description == "cancelled"
        || description.starts_with("db:57P")
        || description.starts_with("db:08")
        || description == "sqlx:Io"
        || description == "sqlx:Protocol"
        || description == "sqlx:PoolTimedOut"
        || description == "sqlx:WorkerCrashed"
}

async fn send(pool: PgPool, batch: UsageBatch, cancel_after: Option<Duration>) -> Answer {
    let task = tokio::spawn(async move { ledger::ingest(&pool, &batch).await });
    if let Some(after) = cancel_after {
        let abort = task.abort_handle();
        tokio::spawn(async move {
            tokio::time::sleep(after).await;
            abort.abort();
        });
    }
    match task.await {
        Ok(Ok(Outcome::Applied)) => Answer::Applied,
        Ok(Ok(Outcome::AlreadyApplied)) => Answer::AlreadyApplied,
        Ok(Err(IngestError::Refused(Refusal::Gap { expected_seq }))) => Answer::Gap(expected_seq),
        Ok(Err(IngestError::Refused(Refusal::Conflict))) => Answer::Conflict,
        Ok(Err(IngestError::Refused(Refusal::Invalid { .. }))) => Answer::Invalid,
        Ok(Err(IngestError::Database(error))) => Answer::Unknown(describe(&error)),
        Err(join) if join.is_cancelled() => Answer::Unknown("cancelled".to_owned()),
        Err(join) => Answer::Unknown(format!("panic:{join}")),
    }
}

struct Meter {
    plan: Plan,
    /// The ledger holds seqs 1..=settled: proved by an answer, never assumed.
    settled: u64,
    /// Per slot and contender: was it ever answered Applied or AlreadyApplied.
    accepted: Vec<Vec<bool>>,
    /// Per slot and contender: was it ever answered Conflict.
    refused: Vec<Vec<bool>>,
    /// Per slot: how many requests were answered Applied.
    applied_answers: Vec<u32>,
}

impl Meter {
    fn new(plan: Plan) -> Self {
        let accepted: Vec<Vec<bool>> = plan.slots.iter().map(|c| vec![false; c.len()]).collect();
        Meter {
            settled: 0,
            refused: accepted.clone(),
            applied_answers: vec![0; plan.slots.len()],
            accepted,
            plan,
        }
    }

    fn winner(&self, slot: usize) -> Option<usize> {
        self.accepted[slot].iter().position(|accepted| *accepted)
    }
}

fn altered(rng: &mut Rng, original: &UsageBatch) -> (&'static str, UsageBatch) {
    let mut batch = original.clone();
    let line = rng.below(batch.lines.len() as u64) as usize;
    let many = batch.lines.len() >= 2;
    let what = match rng.below(9) {
        0 => {
            batch.lines[line].requests += 1;
            "requests+1"
        }
        1 => {
            batch.lines[line].bytes_up += 1;
            "bytes_up+1"
        }
        2 => {
            batch.lines[line].bytes_down += 1;
            "bytes_down+1"
        }
        3 => {
            batch.lines[line].account_id = rng.uuid();
            "other account"
        }
        4 => {
            batch.lines[line].device_id = rng.uuid();
            "other device"
        }
        5 if many => {
            batch.lines.swap(0, 1);
            "two lines swapped"
        }
        6 if many => {
            batch.lines.pop();
            "one line fewer"
        }
        7 => {
            batch.batch_id = rng.uuid();
            "new batch id"
        }
        _ => {
            batch.lines.push(UsageLine {
                account_id: rng.uuid(),
                device_id: rng.uuid(),
                requests: 1,
                bytes_up: 1,
                bytes_down: 1,
            });
            "one line more"
        }
    };
    (what, batch)
}

fn invalid(rng: &mut Rng, meter_id: Uuid, seq: u64) -> (&'static str, UsageBatch) {
    let mut batch = UsageBatch {
        meter_id,
        seq,
        batch_id: rng.uuid(),
        lines: random_lines(rng),
    };
    let what = match rng.below(6) {
        0 => {
            batch.seq = 0;
            "seq 0"
        }
        1 => {
            batch.lines.clear();
            "no lines"
        }
        2 => {
            batch.lines[0].requests = 0;
            batch.lines[0].bytes_up = 0;
            batch.lines[0].bytes_down = 0;
            "all-zero line"
        }
        3 => {
            let repeat = batch.lines[0].clone();
            batch.lines.push(repeat);
            "repeated account and device"
        }
        4 => {
            batch.lines[0].bytes_down = MOST + 1 + rng.below(1000);
            "counter above i64::MAX"
        }
        _ => {
            batch.seq = MOST + 1;
            "seq above i64::MAX"
        }
    };
    (what, batch)
}

/// Builds one volley for a meter.
fn volley(
    meter: &Meter,
    rng: &mut Rng,
    used_ids: &Mutex<Vec<(Uuid, Uuid)>>,
    cancels: bool,
) -> Vec<Request> {
    let mut requests = Vec::new();
    let slots = meter.plan.slots.len();
    let next = meter.settled as usize;
    let cancel = |rng: &mut Rng| {
        (cancels && rng.chance(25)).then(|| Duration::from_micros(rng.below(30_000)))
    };

    if next < slots {
        for (index, contender) in meter.plan.slots[next].iter().enumerate() {
            // One copy that is never cancelled, then up to three more.
            requests.push(Request {
                kind: Kind::Contender { slot: next, index },
                batch: contender.clone(),
                cancel_after: None,
            });
            for _ in 0..rng.below(4) {
                requests.push(Request {
                    kind: Kind::Contender { slot: next, index },
                    batch: contender.clone(),
                    cancel_after: cancel(rng),
                });
            }
        }
        if rng.chance(50) {
            let ahead = next + 1 + rng.below(3) as usize;
            if ahead < slots {
                for _ in 0..1 + rng.below(2) {
                    requests.push(Request {
                        kind: Kind::Contender {
                            slot: ahead,
                            index: 0,
                        },
                        batch: meter.plan.slots[ahead][0].clone(),
                        cancel_after: cancel(rng),
                    });
                }
            }
        }
    }
    if next > 0 && rng.chance(60) {
        let old = rng.below(next as u64) as usize;
        for (index, contender) in meter.plan.slots[old].iter().enumerate() {
            requests.push(Request {
                kind: Kind::Contender { slot: old, index },
                batch: contender.clone(),
                cancel_after: cancel(rng),
            });
        }
    }
    if next > 0 && rng.chance(50) {
        let old = rng.below(next as u64) as usize;
        if let Some(winner) = meter.winner(old) {
            for _ in 0..1 + rng.below(2) {
                let (what, batch) = altered(rng, &meter.plan.slots[old][winner]);
                requests.push(Request {
                    kind: Kind::Altered(what),
                    batch,
                    cancel_after: cancel(rng),
                });
            }
        }
    }
    let stolen = {
        let used = used_ids.lock().unwrap();
        let others: Vec<Uuid> = used
            .iter()
            .filter(|(meter_id, _)| *meter_id != meter.plan.meter_id)
            .map(|(_, batch_id)| *batch_id)
            .collect();
        (!others.is_empty()).then(|| others[rng.below(others.len() as u64) as usize])
    };
    if let Some(batch_id) = stolen {
        if rng.chance(35) {
            let (kind, seq) = match rng.below(3) {
                0 => (Kind::Stolen, meter.settled + 1),
                1 if meter.settled > 0 => (Kind::Stolen, 1 + rng.below(meter.settled)),
                _ => (Kind::StolenAhead, meter.settled + 2 + rng.below(3)),
            };
            requests.push(Request {
                kind,
                batch: UsageBatch {
                    meter_id: meter.plan.meter_id,
                    seq,
                    batch_id,
                    lines: random_lines(rng),
                },
                cancel_after: cancel(rng),
            });
        }
        if rng.chance(10) {
            requests.push(Request {
                kind: Kind::GhostStolen,
                batch: UsageBatch {
                    meter_id: rng.uuid(),
                    seq: 1,
                    batch_id,
                    lines: random_lines(rng),
                },
                cancel_after: None,
            });
        }
    }
    if rng.chance(15) {
        let (what, batch) = invalid(rng, meter.plan.meter_id, meter.settled + 1);
        requests.push(Request {
            kind: Kind::Invalid(what),
            batch,
            cancel_after: None,
        });
    }
    if rng.chance(15) {
        let ghost = rng.uuid();
        for _ in 0..1 + rng.below(3) {
            requests.push(Request {
                kind: Kind::Ghost,
                batch: UsageBatch {
                    meter_id: ghost,
                    seq: 2 + rng.below(5),
                    batch_id: rng.uuid(),
                    lines: random_lines(rng),
                },
                cancel_after: cancel(rng),
            });
        }
    }
    // Shuffle, so that the order of sending says nothing about the kind.
    for i in (1..requests.len()).rev() {
        requests.swap(i, rng.below(i as u64 + 1) as usize);
    }
    requests
}

/// Checks one answer against what its request may get, and records it.
fn judge(
    meter: &mut Meter,
    settled_before: u64,
    kind: &Kind,
    batch: &UsageBatch,
    answer: &Answer,
    stats: &Stats,
) {
    let wrong = |why: &str| {
        stats.fail(format!(
            "meter {} seq {} {kind:?} was answered {answer:?} with {settled_before} settled: {why}",
            batch.meter_id, batch.seq
        ));
    };
    if let Answer::Unknown(description) = answer {
        stats.count(&format!("unknown {description}"));
        if description != GAVE_UP_WAITING && !excusable(description) {
            wrong("a database error that no killed or cancelled connection explains");
        }
        return;
    }
    match kind {
        Kind::Contender { slot, index } => {
            let (slot, index) = (*slot, *index);
            let seq = slot as u64 + 1;
            match answer {
                Answer::Applied => {
                    stats.count("applied");
                    if seq <= settled_before {
                        wrong("a slot already known to be stored was applied again");
                    }
                    meter.applied_answers[slot] += 1;
                    meter.accepted[slot][index] = true;
                }
                Answer::AlreadyApplied => {
                    stats.count("already applied");
                    meter.accepted[slot][index] = true;
                }
                Answer::Conflict => {
                    stats.count("conflict between contenders");
                    if meter.plan.slots[slot].len() < 2 {
                        wrong("the only contender of its slot, with an id of its own");
                    }
                    if index == 0 && seq > settled_before + 1 {
                        wrong("no rival of this slot was ever sent before it");
                    }
                    meter.refused[slot][index] = true;
                }
                Answer::Gap(expected) => {
                    stats.count("gap");
                    if seq <= settled_before + 1 {
                        wrong("everything before this seq was already stored");
                    } else if !(settled_before < *expected && *expected < seq) {
                        wrong("expected_seq is outside what could be stored");
                    } else {
                        meter.settled = meter.settled.max(*expected - 1);
                    }
                }
                _ => wrong("not an answer a valid contender can get"),
            }
            if meter.accepted[slot][index] {
                meter.settled = meter.settled.max(seq);
            }
        }
        Kind::Altered(what) => {
            if *answer == Answer::Conflict {
                stats.count("conflict");
            } else {
                wrong(&format!("an applied batch with {what} must be Conflict"));
            }
        }
        Kind::Stolen | Kind::GhostStolen => {
            if *answer == Answer::Conflict {
                stats.count("conflict");
            } else {
                wrong("must be Conflict");
            }
        }
        Kind::StolenAhead => match answer {
            Answer::Conflict => stats.count("used batch id ahead of next: conflict"),
            Answer::Gap(_) => stats.count("used batch id ahead of next: gap"),
            _ => wrong("must be Conflict or Gap"),
        },
        Kind::Invalid(what) => {
            if *answer == Answer::Invalid {
                stats.count("invalid");
            } else {
                wrong(&format!("{what} must be Invalid"));
            }
        }
        Kind::Ghost => {
            if *answer == Answer::Gap(1) {
                stats.count("gap on a meter never seen");
            } else {
                wrong("must be Gap(1)");
            }
        }
    }
}

fn check_slots(meter: &Meter, stats: &Stats) {
    for slot in 0..meter.plan.slots.len() {
        let accepted = meter.accepted[slot].iter().filter(|a| **a).count();
        if accepted > 1 {
            stats.fail(format!(
                "meter {} seq {}: {accepted} different contenders were accepted",
                meter.plan.meter_id,
                slot + 1
            ));
        }
        if meter.applied_answers[slot] > 1 {
            stats.fail(format!(
                "meter {} seq {}: answered Applied {} times",
                meter.plan.meter_id,
                slot + 1,
                meter.applied_answers[slot]
            ));
        }
        for index in 0..meter.plan.slots[slot].len() {
            if meter.accepted[slot][index] && meter.refused[slot][index] {
                stats.fail(format!(
                    "meter {} seq {} contender {index}: both accepted and refused",
                    meter.plan.meter_id,
                    slot + 1
                ));
            }
        }
    }
}

async fn drive(
    plan: Plan,
    pools: Arc<Vec<PgPool>>,
    mut rng: Rng,
    stats: Arc<Stats>,
    used_ids: Arc<Mutex<Vec<(Uuid, Uuid)>>>,
) -> Meter {
    let mut meter = Meter::new(plan);
    let slots = meter.plan.slots.len() as u64;
    let mut volleys = 0u64;
    while meter.settled < slots {
        volleys += 1;
        if volleys > 400 * slots {
            stats.fail(format!(
                "meter {} stopped at {} of {slots}",
                meter.plan.meter_id, meter.settled
            ));
            break;
        }
        let settled_before = meter.settled;
        let requests = volley(&meter, &mut rng, &used_ids, true);
        let mut sent = Vec::new();
        for request in requests {
            let pool = pools[rng.below(pools.len() as u64) as usize].clone();
            if request.cancel_after.is_some() {
                stats.count("sent with a cancel timer");
            }
            let handle = tokio::spawn(send(pool, request.batch.clone(), request.cancel_after));
            sent.push((request, handle));
        }
        stats.count("volleys");
        for (request, handle) in sent {
            let answer = handle.await.unwrap();
            judge(
                &mut meter,
                settled_before,
                &request.kind,
                &request.batch,
                &answer,
                &stats,
            );
        }
        check_slots(&meter, &stats);
        // Tell the other meters which ids are certainly stored.
        let mut used = used_ids.lock().unwrap();
        for slot in settled_before as usize..meter.settled as usize {
            if let Some(winner) = meter.winner(slot) {
                used.push((meter.plan.meter_id, meter.plan.slots[slot][winner].batch_id));
            }
        }
    }
    meter
}

async fn kill_sessions(admin: PgPool, stop: Arc<AtomicBool>, stats: Arc<Stats>, mut rng: Rng) {
    while !stop.load(Ordering::Relaxed) {
        tokio::time::sleep(Duration::from_millis(1 + rng.below(8))).await;
        let killed: Option<bool> = sqlx::query_scalar(
            r#"
            select pg_terminate_backend(pid) from pg_stat_activity
            where datname = current_database() and application_name = 'ledger-stress-coordinator'
              and state in ('active', 'idle in transaction')
            order by random() limit 1
            "#,
        )
        .fetch_optional(&admin)
        .await
        .unwrap();
        if killed == Some(true) {
            stats.kills.fetch_add(1, Ordering::Relaxed);
        }
    }
}

async fn run_once(seed: u64, meters: usize, slots: usize, kills: bool) -> Result<String, String> {
    let url = std::env::var("DATABASE_URL").expect("DATABASE_URL must be set");
    let master = PgConnectOptions::from_str(&url).unwrap();
    let database = format!("ledger_stress_{seed:016x}_{}", std::process::id());
    let admin = PgPoolOptions::new()
        .max_connections(2)
        .connect_with(master.clone())
        .await
        .unwrap();
    // The name is lower-case letters, digits and underscores: it needs no quoting.
    sqlx::query(AssertSqlSafe(format!("create database {database}")))
        .execute(&admin)
        .await
        .unwrap();
    let inside = master.clone().database(&database);
    let reader = PgPoolOptions::new()
        .max_connections(3)
        .connect_with(inside.clone().application_name("ledger-stress-reader"))
        .await
        .unwrap();
    ledger::migrate(&reader).await.unwrap();

    let mut pools = Vec::new();
    for _ in 0..POOLS {
        pools.push(
            PgPoolOptions::new()
                .max_connections(CONNECTIONS_PER_POOL)
                .acquire_timeout(Duration::from_secs(60))
                .connect_with(inside.clone().application_name("ledger-stress-coordinator"))
                .await
                .unwrap(),
        );
    }
    let pools = Arc::new(pools);

    let mut rng = Rng(seed);
    let plans = make_plans(&mut rng, meters, slots);
    let mut meter_ids: HashSet<Uuid> = plans.iter().map(|plan| plan.meter_id).collect();
    let stats = Arc::new(Stats::default());
    let used_ids = Arc::new(Mutex::new(Vec::new()));
    let stop = Arc::new(AtomicBool::new(false));
    let killer = kills.then(|| {
        tokio::spawn(kill_sessions(
            reader.clone(),
            stop.clone(),
            stats.clone(),
            Rng(seed ^ 0xDEAD_BEEF),
        ))
    });

    let started = Instant::now();
    let mut drivers = Vec::new();
    for (number, plan) in plans.into_iter().enumerate() {
        drivers.push(tokio::spawn(drive(
            plan,
            pools.clone(),
            Rng(seed.wrapping_add(1 + number as u64)),
            stats.clone(),
            used_ids.clone(),
        )));
    }
    let mut done = Vec::new();
    for driver in drivers {
        done.push(driver.await.unwrap());
    }
    stop.store(true, Ordering::Relaxed);
    if let Some(killer) = killer {
        killer.await.unwrap();
    }
    let chaos_time = started.elapsed();

    // No request is in flight now. Nothing may be left holding a transaction open.
    let mut lingering = -1i64;
    for _ in 0..100 {
        lingering = sqlx::query_scalar(
            "select count(*) from pg_stat_activity where datname = current_database() and (state like 'idle in transaction%' or wait_event_type = 'Lock')",
        )
        .fetch_one(&reader)
        .await
        .unwrap();
        if lingering == 0 {
            break;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    if lingering != 0 {
        stats.fail(format!(
            "{lingering} sessions still hold a transaction open or wait on a lock"
        ));
    }

    let mut expected_batches: HashMap<(Uuid, i64), UsageBatch> = HashMap::new();
    let mut expected_totals = [0u128; 5];

    // Twin races: two meters never seen offer the same new batch id at the
    // same moment, each from two connections. One meter gets it, applied
    // once; the other is a conflict and leaves nothing behind.
    for _ in 0..TWIN_ROUNDS {
        let shared = rng.uuid();
        let twins: Vec<UsageBatch> = (0..2)
            .map(|_| UsageBatch {
                meter_id: rng.uuid(),
                seq: 1,
                batch_id: shared,
                lines: random_lines(&mut rng),
            })
            .collect();
        let mut sent = Vec::new();
        for copy in 0..4 {
            let twin = copy % 2;
            let pool = pools[(copy + twin) % POOLS].clone();
            sent.push((twin, tokio::spawn(send(pool, twins[twin].clone(), None))));
        }
        let mut answers: [Vec<Answer>; 2] = [Vec::new(), Vec::new()];
        for (twin, handle) in sent {
            answers[twin].push(handle.await.unwrap());
        }
        let applied = |twin: usize| {
            answers[twin]
                .iter()
                .filter(|a| **a == Answer::Applied)
                .count()
        };
        let acknowledged = |twin: usize| {
            answers[twin]
                .iter()
                .filter(|a| **a == Answer::AlreadyApplied)
                .count()
        };
        let conflicts = |twin: usize| {
            answers[twin]
                .iter()
                .filter(|a| **a == Answer::Conflict)
                .count()
        };
        let winner = match (applied(0), applied(1)) {
            (1, 0) => 0,
            (0, 1) => 1,
            _ => {
                stats.fail(format!("twin race for batch id {shared}: {answers:?}"));
                continue;
            }
        };
        if acknowledged(winner) != 1 || conflicts(1 - winner) != 2 {
            stats.fail(format!("twin race for batch id {shared}: {answers:?}"));
        }
        stats.count("twin races");
        let batch = twins[winner].clone();
        meter_ids.insert(batch.meter_id);
        expected_totals[0] += 1;
        for line in &batch.lines {
            expected_totals[1] += 1;
            expected_totals[2] += u128::from(line.requests);
            expected_totals[3] += u128::from(line.bytes_up);
            expected_totals[4] += u128::from(line.bytes_down);
        }
        expected_batches.insert((batch.meter_id, 1), batch);
    }

    // Quiet pass: every contender of every slot once more, nothing killed or
    // cancelled. Exactly one per slot is on record; the rest are conflicts.
    for meter in &mut done {
        for slot in 0..meter.plan.slots.len() {
            let mut on_record = Vec::new();
            for index in 0..meter.plan.slots[slot].len() {
                let contender = meter.plan.slots[slot][index].clone();
                match send(pools[index % POOLS].clone(), contender, None).await {
                    Answer::AlreadyApplied => on_record.push(index),
                    Answer::Conflict => {
                        if meter.accepted[slot][index] {
                            stats.fail(format!(
                                "meter {} seq {} contender {index} was accepted before and is a conflict now",
                                meter.plan.meter_id,
                                slot + 1
                            ));
                        }
                    }
                    other => stats.fail(format!(
                        "quiet pass: meter {} seq {} contender {index} was answered {other:?}",
                        meter.plan.meter_id,
                        slot + 1
                    )),
                }
            }
            if on_record.len() != 1 {
                stats.fail(format!(
                    "meter {} seq {}: {} contenders are on record: {on_record:?}",
                    meter.plan.meter_id,
                    slot + 1,
                    on_record.len()
                ));
                continue;
            }
            let winner = on_record[0];
            if let Some(earlier) = meter.winner(slot)
                && earlier != winner
            {
                stats.fail(format!(
                    "meter {} seq {}: contender {earlier} was accepted, contender {winner} is on record",
                    meter.plan.meter_id,
                    slot + 1
                ));
            }
            if meter.applied_answers[slot] == 0 {
                stats.count("slots applied by a request whose answer was lost");
            }
            let batch = meter.plan.slots[slot][winner].clone();
            expected_totals[0] += 1;
            for line in &batch.lines {
                expected_totals[1] += 1;
                expected_totals[2] += u128::from(line.requests);
                expected_totals[3] += u128::from(line.bytes_up);
                expected_totals[4] += u128::from(line.bytes_down);
            }
            expected_batches.insert((meter.plan.meter_id, slot as i64 + 1), batch);
        }
        check_slots(meter, &stats);
    }

    // The stored rows are the winners, row by row.
    let stored_batches: Vec<(Uuid, i64, Uuid)> =
        sqlx::query_as("select meter_id, seq, batch_id from usage_batch")
            .fetch_all(&reader)
            .await
            .unwrap();
    if stored_batches.len() != expected_batches.len() {
        stats.fail(format!(
            "{} batches stored, {} expected",
            stored_batches.len(),
            expected_batches.len()
        ));
    }
    let mut by_id: HashMap<Uuid, &UsageBatch> = HashMap::new();
    for (meter_id, seq, batch_id) in &stored_batches {
        match expected_batches.get(&(*meter_id, *seq)) {
            Some(batch) if batch.batch_id == *batch_id => {
                if by_id.insert(*batch_id, batch).is_some() {
                    stats.fail(format!("batch id {batch_id} is stored twice"));
                }
            }
            Some(batch) => stats.fail(format!(
                "meter {meter_id} seq {seq}: stored batch id {batch_id}, winner is {}",
                batch.batch_id
            )),
            None => stats.fail(format!(
                "meter {meter_id} seq {seq} is stored and was never a winner"
            )),
        }
    }
    type StoredLine = (Uuid, i64, Uuid, Uuid, i64, i64, i64);
    let stored_lines: Vec<StoredLine> = sqlx::query_as(
        "select batch_id, line_no, account_id, device_id, requests, bytes_up, bytes_down from usage_line order by batch_id, line_no",
    )
    .fetch_all(&reader)
    .await
    .unwrap();
    let mut lines_by_batch: HashMap<Uuid, Vec<StoredLine>> = HashMap::new();
    for stored in stored_lines {
        lines_by_batch.entry(stored.0).or_default().push(stored);
    }
    if lines_by_batch.len() != by_id.len() {
        stats.fail(format!(
            "lines stored for {} batches, {} batches stored",
            lines_by_batch.len(),
            by_id.len()
        ));
    }
    for (batch_id, batch) in &by_id {
        let stored = lines_by_batch.remove(batch_id).unwrap_or_default();
        let same = stored.len() == batch.lines.len()
            && stored
                .iter()
                .zip(&batch.lines)
                .enumerate()
                .all(|(index, (stored, sent))| {
                    stored.1 == index as i64 + 1
                        && stored.2 == sent.account_id
                        && stored.3 == sent.device_id
                        && stored.4 as u64 == sent.requests
                        && stored.5 as u64 == sent.bytes_up
                        && stored.6 as u64 == sent.bytes_down
                });
        if !same {
            stats.fail(format!(
                "batch {batch_id}: stored lines differ from the lines sent"
            ));
        }
    }
    let stored_meters: Vec<Uuid> = sqlx::query_scalar("select meter_id from usage_meter")
        .fetch_all(&reader)
        .await
        .unwrap();
    let stored_meters: HashSet<Uuid> = stored_meters.into_iter().collect();
    if stored_meters != meter_ids {
        stats.fail(format!(
            "{} meter rows stored for {} meters that applied batches",
            stored_meters.len(),
            meter_ids.len()
        ));
    }
    match ledger::totals(&reader).await {
        Ok(Totals {
            batches,
            lines,
            requests,
            bytes_up,
            bytes_down,
        }) => {
            let got = [batches, lines, requests, bytes_up, bytes_down].map(u128::from);
            if got != expected_totals {
                stats.fail(format!(
                    "totals are {got:?}, the winners sum to {expected_totals:?}"
                ));
            }
        }
        Err(error) => stats.fail(format!("totals failed: {error:?}")),
    }

    for pool in pools.iter() {
        pool.close().await;
    }
    reader.close().await;
    let failures = stats.failures.lock().unwrap().clone();
    let summary = format!(
        "seed {seed:#018x}: {meters} meters x {slots} slots and {TWIN_ROUNDS} twin races, {} batches stored, {} kills, {:?} under chaos, {:?}",
        expected_batches.len(),
        stats.kills.load(Ordering::Relaxed),
        chaos_time,
        stats.counts.lock().unwrap()
    );
    if failures.is_empty() {
        sqlx::query(AssertSqlSafe(format!(
            "drop database {database} with (force)"
        )))
        .execute(&admin)
        .await
        .unwrap();
        admin.close().await;
        Ok(summary)
    } else {
        admin.close().await;
        Err(format!(
            "{summary}; database kept: {database}; failures: {failures:#?}"
        ))
    }
}

fn env_number(name: &str, default: u64) -> u64 {
    match std::env::var(name) {
        Ok(text) => {
            let text = text.trim();
            match text.strip_prefix("0x") {
                Some(hex) => u64::from_str_radix(hex, 16).unwrap(),
                None => text.parse().unwrap(),
            }
        }
        Err(_) => default,
    }
}

#[test]
fn stress() {
    let clock = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_nanos() as u64;
    let first_seed = env_number("LEDGER_STRESS_SEED", clock);
    let runs = env_number("LEDGER_STRESS_RUNS", 1);
    let meters = env_number("LEDGER_STRESS_METERS", 12) as usize;
    let slots = env_number("LEDGER_STRESS_SLOTS", 20) as usize;
    let kills = env_number("LEDGER_STRESS_KILLS", 1) != 0;

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(4)
        .enable_all()
        .build()
        .unwrap();
    let mut failed = Vec::new();
    for run in 0..runs {
        let seed = first_seed.wrapping_add(run.wrapping_mul(0x9E37_79B9_7F4A_7C15));
        match runtime.block_on(run_once(seed, meters, slots, kills)) {
            Ok(summary) => println!("STRESS ok   {summary}"),
            Err(report) => {
                println!("STRESS FAIL {report}");
                failed.push(seed);
            }
        }
    }
    assert!(failed.is_empty(), "failed seeds: {failed:x?}");
}
