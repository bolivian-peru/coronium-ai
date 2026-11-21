//! Fault scenarios for the usage ledger: a batch that is lost, repeated,
//! contradicted or raced must never lose usage or count it twice.
//!
//! The expectations come from the contract at the top of `src/ledger.rs`, not
//! from how `ingest` is written, and every expected total is summed here from
//! the batches themselves. `#[sqlx::test]` gives each scenario a database of
//! its own with the migrations applied, and panics when `DATABASE_URL` is not
//! set: without a database these tests fail, they are never skipped.

use std::cmp::Ordering;
use std::sync::Arc;
use std::time::Duration;

use coronium_coordinator::ledger::{
    self, IngestError, MAX_LINES_PER_BATCH, Outcome, Refusal, Totals, UsageBatch, UsageLine,
};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use sqlx::{AssertSqlSafe, PgPool};
use tokio::sync::{Barrier, Mutex};
use uuid::Uuid;

/// The largest count a bigint column holds.
const MOST: u64 = i64::MAX.unsigned_abs();

/// Long enough for a busy machine, far shorter than a wait on a lock that is
/// never released.
const SOON: Duration = Duration::from_secs(5);

const RACERS: u32 = 32;
const ROUNDS: u64 = 20;

/// The server allows a limited number of connections and other test binaries
/// use it at the same time, so the scenarios that open many take turns.
static MANY_CONNECTIONS: Mutex<()> = Mutex::const_new(());

/// The lock an ingest takes on its meter and keeps until it ends.
const HOLD_METER: &str = "select from usage_meter where meter_id = $1 for update";

fn line(requests: u64, bytes_up: u64, bytes_down: u64) -> UsageLine {
    UsageLine {
        account_id: Uuid::new_v4(),
        device_id: Uuid::new_v4(),
        requests,
        bytes_up,
        bytes_down,
    }
}

fn batch(meter_id: Uuid, seq: u64, lines: Vec<UsageLine>) -> UsageBatch {
    UsageBatch {
        meter_id,
        seq,
        batch_id: Uuid::new_v4(),
        lines,
    }
}

/// A batch whose counters follow its sequence number, so that a wrong total
/// points at the batch that is missing or counted twice.
fn numbered(meter_id: Uuid, seq: u64) -> UsageBatch {
    let lines = vec![line(seq, 1_000 * seq, 1_000_000 * seq), line(1, 2, 3)];
    batch(meter_id, seq, lines)
}

/// A copy of `batch` with its first line changed.
fn with_first_line(batch: &UsageBatch, change: impl FnOnce(&mut UsageLine)) -> UsageBatch {
    let mut changed = batch.clone();
    change(&mut changed.lines[0]);
    changed
}

/// Three copies of `batch`, each with a different counter of its first line
/// set to `value`.
fn each_counter_set_to(batch: &UsageBatch, value: u64) -> [(&'static str, UsageBatch); 3] {
    [
        (
            "requests too large",
            with_first_line(batch, |line| line.requests = value),
        ),
        (
            "bytes_up too large",
            with_first_line(batch, |line| line.bytes_up = value),
        ),
        (
            "bytes_down too large",
            with_first_line(batch, |line| line.bytes_down = value),
        ),
    ]
}

/// What the ledger must total once it has applied exactly these batches, each
/// once. Summed from the batches, never from what the ledger answered.
fn sum_of<'a>(batches: impl IntoIterator<Item = &'a UsageBatch>) -> Totals {
    let mut sum = Totals::default();
    for batch in batches {
        sum.batches += 1;
        for line in &batch.lines {
            sum.lines += 1;
            sum.requests += line.requests;
            sum.bytes_up += line.bytes_up;
            sum.bytes_down += line.bytes_down;
        }
    }
    sum
}

async fn totals(pool: &PgPool) -> Totals {
    ledger::totals(pool).await.unwrap()
}

/// What the ledger answered. A database error is not an answer a sender can
/// act on, so it fails the test.
async fn answer(pool: &PgPool, batch: &UsageBatch) -> Result<Outcome, Refusal> {
    match ledger::ingest(pool, batch).await {
        Ok(outcome) => Ok(outcome),
        Err(IngestError::Refused(refusal)) => Err(refusal),
        Err(IngestError::Database(error)) => {
            panic!("the ledger failed instead of answering: {error:?}")
        }
    }
}

async fn apply(pool: &PgPool, batch: &UsageBatch) {
    assert_eq!(answer(pool, batch).await, Ok(Outcome::Applied));
}

async fn assert_invalid(pool: &PgPool, batch: &UsageBatch, case: &str) {
    match answer(pool, batch).await {
        // The sender corrects the batch from the cause, so there has to be one.
        Err(Refusal::Invalid { cause }) => assert!(!cause.is_empty(), "{case}: no cause given"),
        other => panic!("{case}: expected Invalid, got {other:?}"),
    }
}

/// Everything the ledger holds, as far as it shows without naming a table:
/// the totals and the number of rows in each table.
#[derive(Debug, PartialEq)]
struct Stored {
    totals: Totals,
    rows: Vec<(String, i64)>,
}

async fn stored(pool: &PgPool) -> Stored {
    let tables: Vec<(String, String)> = sqlx::query_as(
        r#"
        select table_name::text, format('select count(*) from %I.%I', table_schema, table_name)
        from information_schema.tables
        where table_schema not in ('pg_catalog', 'information_schema')
          and table_type = 'BASE TABLE'
        order by table_schema, table_name
        "#,
    )
    .fetch_all(pool)
    .await
    .unwrap();
    assert!(!tables.is_empty(), "the ledger has no tables");

    let mut rows = Vec::new();
    for (table, count_rows) in tables {
        let count: i64 = sqlx::query_scalar(AssertSqlSafe(count_rows))
            .fetch_one(pool)
            .await
            .unwrap();
        rows.push((table, count));
    }
    Stored {
        totals: totals(pool).await,
        rows,
    }
}

/// A second pool on the test's database with every connection already open,
/// so that racers start level instead of queueing behind connection setup.
/// The pool `#[sqlx::test]` hands out cannot grow to the sizes needed here.
async fn warm_pool(database: &PgPool, connections: u32) -> PgPool {
    let pool = PgPoolOptions::new()
        .max_connections(connections)
        .connect_with(PgConnectOptions::clone(&database.connect_options()))
        .await
        .unwrap();
    let mut open = Vec::new();
    for _ in 0..connections {
        open.push(pool.acquire().await.unwrap());
    }
    pool
}

fn count_of(answers: &[Result<Outcome, Refusal>], outcome: Outcome) -> usize {
    answers
        .iter()
        .filter(|answer| **answer == Ok(outcome))
        .count()
}

/// Sends one new batch from every racer at the same moment and checks that
/// exactly one of them applied it and that it was counted once. `counted` is
/// every batch the ledger should hold.
async fn race_once(
    reader: &PgPool,
    racers: &[PgPool],
    batch: UsageBatch,
    counted: &mut Vec<UsageBatch>,
) {
    assert_eq!(totals(reader).await, sum_of(&*counted));

    let barrier = Arc::new(Barrier::new(racers.len()));
    let mut sending = Vec::new();
    for pool in racers {
        let (pool, batch, barrier) = (pool.clone(), batch.clone(), barrier.clone());
        sending.push(tokio::spawn(async move {
            barrier.wait().await;
            answer(&pool, &batch).await
        }));
    }
    let mut answers = Vec::new();
    for racer in sending {
        answers.push(racer.await.unwrap());
    }

    let applied = count_of(&answers, Outcome::Applied);
    let acknowledged = count_of(&answers, Outcome::AlreadyApplied);
    assert_eq!(
        (applied, acknowledged),
        (1, racers.len() - 1),
        "{answers:?}"
    );
    counted.push(batch);
    assert_eq!(totals(reader).await, sum_of(&*counted));
}

/// Each round is two races: the first batch of a meter never seen, where
/// there is nothing of the meter yet for the racers to queue on, and the next
/// batch of a meter with history.
async fn race_rounds(reader: &PgPool, racers: &[PgPool]) {
    let established = Uuid::new_v4();
    let mut counted = Vec::new();
    for round in 1..=ROUNDS {
        race_once(reader, racers, numbered(Uuid::new_v4(), 1), &mut counted).await;
        race_once(reader, racers, numbered(established, round), &mut counted).await;
    }
}

#[sqlx::test]
async fn a_lost_batch_holds_back_the_ones_after_it_until_it_arrives(pool: PgPool) {
    let meter = Uuid::new_v4();
    let sent: Vec<UsageBatch> = (1..=4).map(|seq| numbered(meter, seq)).collect();
    apply(&pool, &sent[0]).await;
    apply(&pool, &sent[1]).await;
    let before = stored(&pool).await;
    assert_eq!(before.totals, sum_of(&sent[..2]));

    // Batch 3 is lost in transit and batch 4 arrives.
    assert_eq!(
        answer(&pool, &sent[3]).await,
        Err(Refusal::Gap { expected_seq: 3 })
    );
    assert_eq!(stored(&pool).await, before);

    // The sender resends from 3. Batch 4 goes again under the id it was
    // refused with: had anything of it been kept, it could not be new now.
    apply(&pool, &sent[2]).await;
    apply(&pool, &sent[3]).await;
    assert_eq!(totals(&pool).await, sum_of(&sent));
}

#[sqlx::test]
async fn a_batch_delivered_again_is_acknowledged_and_counted_once(pool: PgPool) {
    let meter = Uuid::new_v4();
    let mut sent: Vec<UsageBatch> = (1..=3).map(|seq| numbered(meter, seq)).collect();
    for batch in &sent {
        apply(&pool, batch).await;
    }
    let before = stored(&pool).await;
    assert_eq!(before.totals, sum_of(&sent));

    // The latest batch and older ones: a sender may repeat any batch whose
    // acknowledgement it never saw.
    for again in [&sent[2], &sent[0], &sent[2], &sent[1]] {
        let copy = again.clone();
        assert_eq!(answer(&pool, &copy).await, Ok(Outcome::AlreadyApplied));
        assert_eq!(stored(&pool).await, before);
    }

    // A repeat did not use up a sequence number either.
    sent.push(numbered(meter, 4));
    apply(&pool, &sent[3]).await;
    assert_eq!(totals(&pool).await, sum_of(&sent));
}

#[sqlx::test]
async fn a_seq_or_batch_id_reused_for_other_content_is_a_conflict(pool: PgPool) {
    let (meter, stranger) = (Uuid::new_v4(), Uuid::new_v4());
    let first = batch(meter, 1, vec![line(1, 10, 100), line(2, 20, 200)]);
    let second = batch(meter, 2, vec![line(3, 30, 300)]);
    apply(&pool, &first).await;
    apply(&pool, &second).await;
    let before = stored(&pool).await;

    // Where a batch id is reused under another sequence number it is the next
    // one the meter expects, so that Conflict is the only answer that fits.
    let conflicts = [
        (
            // Every counter differs, so writing over the batch would show in the totals.
            "a used seq with other counters",
            with_first_line(&second, |line| {
                line.requests = 4;
                line.bytes_up = 40;
                line.bytes_down = 400;
            }),
        ),
        // One field of one line differs and everything else is as it was
        // applied: the smallest change that still makes it another batch.
        (
            "a used seq with one more request on one line",
            with_first_line(&second, |line| line.requests += 1),
        ),
        (
            "a used seq with one more byte up on one line",
            with_first_line(&second, |line| line.bytes_up += 1),
        ),
        (
            "a used seq with one more byte down on one line",
            with_first_line(&second, |line| line.bytes_down += 1),
        ),
        (
            "a used seq with one line under another account",
            with_first_line(&second, |line| line.account_id = Uuid::new_v4()),
        ),
        (
            "a used seq with one line through another device",
            with_first_line(&second, |line| line.device_id = Uuid::new_v4()),
        ),
        (
            "a used seq with the same lines in another order",
            UsageBatch {
                lines: first.lines.iter().rev().cloned().collect(),
                ..first.clone()
            },
        ),
        (
            "a used seq with one line fewer",
            UsageBatch {
                lines: first.lines[..1].to_vec(),
                ..first.clone()
            },
        ),
        (
            "a used seq with other lines under a new batch id",
            batch(meter, 2, vec![line(5, 50, 500)]),
        ),
        (
            "a used seq with the same lines under a new batch id",
            UsageBatch {
                batch_id: Uuid::new_v4(),
                ..second.clone()
            },
        ),
        (
            "a used batch id under another seq with the same lines",
            UsageBatch {
                seq: 3,
                ..first.clone()
            },
        ),
        (
            "a used batch id under another seq with other lines",
            UsageBatch {
                seq: 3,
                lines: vec![line(6, 60, 600)],
                ..second.clone()
            },
        ),
        (
            "a used batch id under another meter with the same lines",
            UsageBatch {
                meter_id: stranger,
                ..first.clone()
            },
        ),
        (
            "a used batch id under another meter with other lines",
            UsageBatch {
                meter_id: stranger,
                seq: 1,
                lines: vec![line(7, 70, 700)],
                ..second.clone()
            },
        ),
    ];
    for (case, conflict) in &conflicts {
        assert_eq!(
            answer(&pool, conflict).await,
            Err(Refusal::Conflict),
            "{case}"
        );
        assert_eq!(stored(&pool).await, before, "{case}");
    }

    // The batches on record are still the originals, and neither meter lost
    // its place in the sequence.
    for original in [&first, &second] {
        assert_eq!(answer(&pool, original).await, Ok(Outcome::AlreadyApplied));
    }
    let third = numbered(meter, 3);
    let strangers_first = numbered(stranger, 1);
    apply(&pool, &third).await;
    apply(&pool, &strangers_first).await;
    assert_eq!(
        totals(&pool).await,
        sum_of([&first, &second, &third, &strangers_first])
    );
}

#[sqlx::test]
async fn one_batch_from_32_connections_at_once_is_applied_once(pool: PgPool) {
    let _turn = MANY_CONNECTIONS.lock().await;
    let connections = warm_pool(&pool, RACERS).await;
    let racers: Vec<PgPool> = (0..RACERS).map(|_| connections.clone()).collect();

    race_rounds(&pool, &racers).await;
    connections.close().await;
}

#[sqlx::test]
async fn two_coordinators_racing_one_batch_apply_it_once(pool: PgPool) {
    let _turn = MANY_CONNECTIONS.lock().await;
    // Two pools built apart share no connection, no pool state and no
    // transaction: only the database can pick the one that applies. They still
    // share this process, so a lock in a process-wide static would go unseen
    // here.
    let coordinators = [warm_pool(&pool, 8).await, warm_pool(&pool, 8).await];
    let racers: Vec<PgPool> = coordinators.iter().cycle().take(16).cloned().collect();

    race_rounds(&pool, &racers).await;
    for coordinator in coordinators {
        coordinator.close().await;
    }
}

const METERS: u64 = 32;
const BATCHES_PER_METER: u64 = 50;
const CHANNEL_SEED: u64 = 0x00C0_FFEE;

/// How far past the last acknowledged batch a sender transmits before it
/// hears back. Without a window nothing could arrive out of order.
const WINDOW: u64 = 4;

/// Out of a hundred: how often the channel drops a batch, delivers it twice,
/// shuffles a burst, or loses the ledger's answer on the way back.
const DROPPED: u64 = 20;
const DUPLICATED: u64 = 20;
const REORDERED: u64 = 50;
const ANSWER_LOST: u64 = 20;

/// A sender still going after this many bursts is stuck, and the test should
/// fail instead of hanging.
const MOST_BURSTS: u64 = 100 * BATCHES_PER_METER;

/// SplitMix64: small enough to keep here, and the same faults on every run.
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
}

/// What the channel did to the traffic and how the ledger answered.
#[derive(Debug, Default)]
struct Faults {
    dropped: u64,
    duplicated: u64,
    reordered: u64,
    answers_lost: u64,
    gaps: u64,
    already_applied: u64,
}

impl Faults {
    fn add(&mut self, other: &Faults) {
        self.dropped += other.dropped;
        self.duplicated += other.duplicated;
        self.reordered += other.reordered;
        self.answers_lost += other.answers_lost;
        self.gaps += other.gaps;
        self.already_applied += other.already_applied;
    }

    fn every_kind_happened(&self) -> bool {
        let kinds = [
            self.dropped,
            self.duplicated,
            self.reordered,
            self.answers_lost,
            self.gaps,
            self.already_applied,
        ];
        kinds.iter().all(|count| *count > 0)
    }
}

/// One meter's batches, the same on every run.
fn meter_batches(meter: u64, rng: &mut Rng) -> Vec<UsageBatch> {
    let meter_number = u128::from(meter) + 1;
    (1..=BATCHES_PER_METER)
        .map(|seq| UsageBatch {
            meter_id: Uuid::from_u128(meter_number),
            seq,
            batch_id: Uuid::from_u128(meter_number << 64 | u128::from(seq)),
            lines: (0..1 + rng.below(3))
                .map(|device| UsageLine {
                    // A few accounts shared by every meter, as one buyer's
                    // traffic crosses many edges. The device differs within a
                    // batch, so no two of its lines share an account and device.
                    account_id: Uuid::from_u128(u128::from(rng.below(5))),
                    device_id: Uuid::from_u128(u128::from(device)),
                    requests: 1 + rng.below(1_000),
                    bytes_up: rng.below(1 << 20),
                    bytes_down: rng.below(1 << 32),
                })
                .collect(),
        })
        .collect()
}

/// One meter's sender. It puts a window of unacknowledged batches on the
/// wire; the channel drops, repeats and shuffles them and loses some answers;
/// the sender goes on until the ledger has acknowledged every batch.
async fn send_through_faults(pool: PgPool, batches: Vec<UsageBatch>, mut rng: Rng) -> Faults {
    let mut faults = Faults::default();
    // The ledger holds this meter's batches 1..=applied. Every answer is
    // checked against that, so a wrong one fails at the batch it happens on.
    let mut applied = 0;
    // What the sender has been told: the ledger holds 1..=acknowledged.
    let mut acknowledged = 0;

    for _ in 0..MOST_BURSTS {
        if acknowledged == BATCHES_PER_METER {
            return faults;
        }
        let window_end = acknowledged + 1 + rng.below(WINDOW);
        let mut wire = Vec::new();
        for batch in &batches {
            if batch.seq <= acknowledged || batch.seq > window_end {
                continue;
            }
            if rng.chance(DROPPED) {
                faults.dropped += 1;
                continue;
            }
            wire.push(batch);
            if rng.chance(DUPLICATED) {
                faults.duplicated += 1;
                wire.push(batch);
            }
        }
        if rng.chance(REORDERED) {
            wire.sort_by_cached_key(|_| rng.draw());
        }
        if wire.windows(2).any(|pair| pair[0].seq > pair[1].seq) {
            faults.reordered += 1;
        }

        for batch in wire {
            // The ledger applies in order, so an acknowledged batch tells the
            // sender that all before it are held, and a Gap tells it the same
            // of all before `expected_seq`: that is where it resends from.
            let held = match (batch.seq.cmp(&(applied + 1)), answer(&pool, batch).await) {
                (Ordering::Equal, Ok(Outcome::Applied)) => {
                    applied = batch.seq;
                    batch.seq
                }
                (Ordering::Less, Ok(Outcome::AlreadyApplied)) => {
                    faults.already_applied += 1;
                    batch.seq
                }
                (Ordering::Greater, Err(Refusal::Gap { expected_seq }))
                    if expected_seq == applied + 1 =>
                {
                    faults.gaps += 1;
                    applied
                }
                (_, wrong) => panic!(
                    "meter {} batch {} was answered {wrong:?} with {applied} batches applied",
                    batch.meter_id, batch.seq
                ),
            };
            if rng.chance(ANSWER_LOST) {
                faults.answers_lost += 1;
            } else {
                acknowledged = acknowledged.max(held);
            }
        }
    }
    panic!(
        "meter {} stopped at batch {acknowledged} of {BATCHES_PER_METER}",
        batches[0].meter_id
    );
}

#[sqlx::test]
async fn an_unreliable_channel_neither_loses_nor_repeats_usage(pool: PgPool) {
    let _turn = MANY_CONNECTIONS.lock().await;
    let connections = warm_pool(&pool, 8).await;

    let mut sent = Vec::new();
    let mut senders = Vec::new();
    for meter in 0..METERS {
        let mut rng = Rng(CHANNEL_SEED + meter);
        let batches = meter_batches(meter, &mut rng);
        sent.extend(batches.iter().cloned());
        senders.push(tokio::spawn(send_through_faults(
            connections.clone(),
            batches,
            rng,
        )));
    }
    let mut faults = Faults::default();
    for sender in senders {
        faults.add(&sender.await.unwrap());
    }

    // A run in which some kind of fault never happened would prove less than
    // it claims.
    assert!(faults.every_kind_happened(), "{faults:?}");
    assert_eq!(totals(&pool).await, sum_of(&sent));
    connections.close().await;
}

#[sqlx::test]
async fn every_invalid_batch_is_refused_and_stores_nothing(pool: PgPool) {
    let meter = Uuid::new_v4();
    let first = numbered(meter, 1);
    apply(&pool, &first).await;
    let before = stored(&pool).await;

    // Each case is one fault away from the batch the ledger would apply next.
    let good = batch(meter, 2, vec![line(2, 20, 200), line(3, 30, 300)]);
    let mut cases = vec![
        (
            "seq 0",
            UsageBatch {
                seq: 0,
                ..good.clone()
            },
        ),
        (
            "no lines",
            UsageBatch {
                lines: Vec::new(),
                ..good.clone()
            },
        ),
        (
            "one line more than the limit",
            UsageBatch {
                lines: (0..=MAX_LINES_PER_BATCH).map(|_| line(1, 1, 1)).collect(),
                ..good.clone()
            },
        ),
        (
            "a line with every counter at zero",
            UsageBatch {
                lines: vec![good.lines[0].clone(), line(0, 0, 0)],
                ..good.clone()
            },
        ),
        (
            "two lines for one account and device",
            UsageBatch {
                lines: vec![
                    good.lines[0].clone(),
                    UsageLine {
                        requests: 9,
                        ..good.lines[0].clone()
                    },
                ],
                ..good.clone()
            },
        ),
    ];
    cases.extend(each_counter_set_to(&good, MOST + 1));
    for (case, invalid) in &cases {
        assert_invalid(&pool, invalid, case).await;
        assert_eq!(stored(&pool).await, before, "{case}");
    }

    // The sequence number and the batch id the refused batches carried are
    // still free for the corrected batch.
    apply(&pool, &good).await;
    assert_eq!(totals(&pool).await, sum_of([&first, &good]));
}

#[sqlx::test]
async fn a_line_with_one_counter_and_a_batch_of_the_most_lines_are_applied(pool: PgPool) {
    let meter = Uuid::new_v4();
    // One counter above zero is enough for a line, whichever counter it is:
    // bytes that crossed with no request counted are still usage.
    let sparse = batch(meter, 1, vec![line(1, 0, 0), line(0, 1, 0), line(0, 0, 1)]);
    // Exactly the most lines a batch may carry.
    let full = batch(
        meter,
        2,
        (0..MAX_LINES_PER_BATCH).map(|_| line(1, 2, 3)).collect(),
    );

    apply(&pool, &sparse).await;
    apply(&pool, &full).await;
    assert_eq!(totals(&pool).await, sum_of([&sparse, &full]));
}

#[sqlx::test]
async fn no_column_can_hold_a_fraction_and_every_usage_counter_is_a_bigint(pool: PgPool) {
    // `udt_name` shows the element type of an array and the base type of a
    // domain, which `data_type` alone would hide.
    let inexact: Vec<(String, String, String)> = sqlx::query_as(
        r#"
        select table_name::text, column_name::text, data_type::text
        from information_schema.columns
        where table_schema not in ('pg_catalog', 'information_schema')
          and (data_type in ('real', 'double precision', 'numeric', 'money')
            or ltrim(udt_name, '_') in ('float4', 'float8', 'numeric', 'money'))
        "#,
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert!(inexact.is_empty(), "{inexact:?}");

    let counters: Vec<(String, String, String)> = sqlx::query_as(
        r#"
        select table_name::text, column_name::text, data_type::text
        from information_schema.columns
        where table_schema not in ('pg_catalog', 'information_schema')
          and (column_name like '%requests%' or column_name like '%bytes%')
        "#,
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    // A renamed counter must fail here, not slip past the type check below.
    for counter in ["requests", "bytes_up", "bytes_down"] {
        assert!(
            counters.iter().any(|(_, column, _)| column == counter),
            "no column named {counter} in {counters:?}"
        );
    }
    for (table, column, data_type) in &counters {
        assert_eq!(data_type, "bigint", "{table}.{column}");
    }
}

#[sqlx::test]
async fn counters_up_to_the_largest_bigint_are_exact_and_larger_ones_are_refused(pool: PgPool) {
    let meter = Uuid::new_v4();
    // One line alone in the database, so the totals read back are these very
    // numbers and not a sum. A double cannot hold MOST - 1 or 2^53 + 1.
    let largest = batch(meter, 1, vec![line(MOST, MOST - 1, (1 << 53) + 1)]);
    apply(&pool, &largest).await;
    let before = stored(&pool).await;
    assert_eq!(
        before.totals,
        Totals {
            batches: 1,
            lines: 1,
            requests: MOST,
            bytes_up: MOST - 1,
            bytes_down: (1 << 53) + 1,
        }
    );

    // As a bigint the first would wrap to the most negative number and the
    // second to minus one.
    let next = numbered(meter, 2);
    for value in [MOST + 1, u64::MAX] {
        for (case, too_large) in &each_counter_set_to(&next, value) {
            assert_invalid(&pool, too_large, case).await;
            assert_eq!(stored(&pool).await, before, "{case}: {value}");
        }
    }

    // One more batch takes two of the totals past what a bigint holds. They
    // still fit the totals' own type, so they are still exact.
    apply(&pool, &next).await;
    assert_eq!(totals(&pool).await, sum_of([&largest, &next]));
}

async fn blocked_sessions(pool: &PgPool) -> i64 {
    sqlx::query_scalar(
        "select count(*) from pg_stat_activity \
        where datname = current_database() and wait_event_type = 'Lock'",
    )
    .fetch_one(pool)
    .await
    .unwrap()
}

/// Waits until a session in this database is queued behind a lock.
async fn wait_for_a_blocked_session(pool: &PgPool) {
    let blocked = async {
        while blocked_sessions(pool).await == 0 {
            tokio::time::sleep(Duration::from_millis(20)).await;
        }
    };
    tokio::time::timeout(SOON, blocked)
        .await
        .expect("nothing waited on the held meter, so the scenario held nothing open");
}

#[sqlx::test]
async fn a_meter_held_open_does_not_hold_up_other_meters(pool: PgPool) {
    let (busy, idle) = (Uuid::new_v4(), Uuid::new_v4());
    let mut counted = vec![numbered(busy, 1), numbered(idle, 1)];
    for batch in &counted {
        apply(&pool, batch).await;
    }

    let mut holder = pool.begin().await.unwrap();
    sqlx::query(HOLD_METER)
        .bind(busy)
        .execute(&mut *holder)
        .await
        .unwrap();
    // The busy meter's next batch has to be seen waiting. Otherwise nothing
    // was held and the answers below would prove nothing.
    let held_up = numbered(busy, 2);
    let waiting = tokio::spawn({
        let (pool, batch) = (pool.clone(), held_up.clone());
        async move { answer(&pool, &batch).await }
    });
    wait_for_a_blocked_session(&pool).await;

    // A meter with history and a meter never seen are both answered meanwhile.
    for other in [numbered(idle, 2), numbered(Uuid::new_v4(), 1)] {
        let answered = tokio::time::timeout(SOON, answer(&pool, &other))
            .await
            .expect("a batch for another meter waited on the held meter");
        assert_eq!(answered, Ok(Outcome::Applied));
        counted.push(other);
    }
    assert!(!waiting.is_finished());
    assert_eq!(totals(&pool).await, sum_of(&counted));

    holder.rollback().await.unwrap();
    let released = tokio::time::timeout(SOON, waiting)
        .await
        .expect("the held meter's batch did not finish after the release");
    assert_eq!(released.unwrap(), Ok(Outcome::Applied));
    counted.push(held_up);
    assert_eq!(totals(&pool).await, sum_of(&counted));
}
