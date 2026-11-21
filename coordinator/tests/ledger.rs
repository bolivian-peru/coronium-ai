//! The usage ledger against a real Postgres.
//!
//! `#[sqlx::test]` gives every test a database of its own, with the migrations
//! applied, and panics when `DATABASE_URL` is not set: without a database
//! these tests fail, they are never skipped.

use std::time::Duration;

use coronium_coordinator::ledger::{
    self, IngestError, MAX_LINES_PER_BATCH, Outcome, Refusal, Totals, UsageBatch, UsageLine,
};
use sqlx::postgres::{PgConnectOptions, PgPoolOptions};
use sqlx::{AssertSqlSafe, PgPool, Postgres, Transaction};
use uuid::Uuid;

/// The largest count a bigint column holds.
const MOST: u64 = i64::MAX.unsigned_abs();

const LOCK_METER: &str = "select from usage_meter where meter_id = $1 for update";

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

async fn apply(pool: &PgPool, batch: &UsageBatch) {
    assert_eq!(ledger::ingest(pool, batch).await.unwrap(), Outcome::Applied);
}

/// The refusal an ingest ends in. Anything else, a database error included,
/// fails the test.
async fn refusal(pool: &PgPool, batch: &UsageBatch) -> Refusal {
    match ledger::ingest(pool, batch).await {
        Err(IngestError::Refused(refusal)) => refusal,
        other => panic!("expected a refusal, got {other:?}"),
    }
}

/// How many meters, batches and lines are stored.
async fn stored_rows(pool: &PgPool) -> (i64, i64, i64) {
    sqlx::query_as(
        r#"
        select
            (select count(*) from usage_meter),
            (select count(*) from usage_batch),
            (select count(*) from usage_line)
        "#,
    )
    .fetch_one(pool)
    .await
    .unwrap()
}

/// Waits until `count` sessions of this database are waiting on a lock, so a
/// test lets go of a lock only when every racer is truly queued behind it.
async fn wait_for_blocked(pool: &PgPool, count: usize) {
    let count = i64::try_from(count).unwrap();
    for _ in 0..200 {
        let blocked: i64 = sqlx::query_scalar(
            r#"
            select count(*) from pg_stat_activity
            where datname = current_database() and wait_event_type = 'Lock'
            "#,
        )
        .fetch_one(pool)
        .await
        .unwrap();
        if blocked == count {
            return;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    panic!("{count} sessions did not end up waiting on a lock");
}

/// Sends `batch` from two connections of each of two pools at once and
/// returns the answers. Two pools share nothing in this process, so they
/// stand in for two coordinator processes. `gate` is an open transaction
/// holding what the racers have to wait for: it is rolled back once all of
/// them wait on it, which lets them go at the same moment.
async fn race(
    pool: &PgPool,
    options: &PgPoolOptions,
    connect: &PgConnectOptions,
    gate: Transaction<'static, Postgres>,
    batch: &UsageBatch,
) -> Vec<Outcome> {
    let mut racer_pools = Vec::new();
    let mut racers = Vec::new();
    for _ in 0..2 {
        let racer_pool = options
            .clone()
            .max_connections(2)
            .connect_with(connect.clone())
            .await
            .unwrap();
        for _ in 0..2 {
            let (racer_pool, batch) = (racer_pool.clone(), batch.clone());
            racers.push(tokio::spawn(async move {
                ledger::ingest(&racer_pool, &batch).await
            }));
        }
        racer_pools.push(racer_pool);
    }
    wait_for_blocked(pool, racers.len()).await;
    gate.rollback().await.unwrap();

    let mut outcomes = Vec::new();
    for racer in racers {
        outcomes.push(racer.await.unwrap().unwrap());
    }
    for racer_pool in racer_pools {
        racer_pool.close().await;
    }
    outcomes
}

fn applied_count(outcomes: &[Outcome]) -> usize {
    outcomes
        .iter()
        .filter(|outcome| **outcome == Outcome::Applied)
        .count()
}

#[sqlx::test(migrations = false)]
async fn migrate_builds_the_schema_and_can_run_again(pool: PgPool) {
    ledger::migrate(&pool).await.unwrap();
    ledger::migrate(&pool).await.unwrap();
    apply(&pool, &batch(Uuid::new_v4(), 1, vec![line(1, 2, 3)])).await;

    // The files are counted on disk now and compared with what was applied:
    // a build that embedded an older set of them stops here.
    let on_disk = std::fs::read_dir(concat!(env!("CARGO_MANIFEST_DIR"), "/migrations"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .filter(|path| path.extension().is_some_and(|extension| extension == "sql"))
        .count();
    let applied: i64 = sqlx::query_scalar("select count(*) from _sqlx_migrations")
        .fetch_one(&pool)
        .await
        .unwrap();
    assert_eq!(usize::try_from(applied).unwrap(), on_disk);
}

#[sqlx::test]
async fn batches_apply_in_order_and_totals_are_their_sum(pool: PgPool) {
    assert_eq!(ledger::totals(&pool).await.unwrap(), Totals::default());

    let meter = Uuid::new_v4();
    let first = batch(meter, 1, vec![line(3, 100, 2000), line(1, 0, 7)]);
    apply(&pool, &first).await;
    apply(&pool, &batch(meter, 2, vec![line(5, 40, 0)])).await;
    apply(&pool, &batch(Uuid::new_v4(), 1, vec![line(0, 0, 1)])).await;

    assert_eq!(
        ledger::totals(&pool).await.unwrap(),
        Totals {
            batches: 3,
            lines: 4,
            requests: 9,
            bytes_up: 140,
            bytes_down: 2008,
        }
    );

    // The lines are stored as sent: numbered from 1 in the order sent, each
    // under its own account and device, with its own counts.
    let stored: Vec<(i64, Uuid, Uuid, i64, i64, i64)> = sqlx::query_as(
        r#"
        select line_no, account_id, device_id, requests, bytes_up, bytes_down
        from usage_line where batch_id = $1 order by line_no
        "#,
    )
    .bind(first.batch_id)
    .fetch_all(&pool)
    .await
    .unwrap();
    let (one, two) = (&first.lines[0], &first.lines[1]);
    let sent = [
        (1, one.account_id, one.device_id, 3, 100, 2000),
        (2, two.account_id, two.device_id, 1, 0, 7),
    ];
    assert_eq!(stored, sent);
}

#[sqlx::test]
async fn a_resent_batch_is_acknowledged_and_changes_nothing(pool: PgPool) {
    let meter = Uuid::new_v4();
    let first = batch(meter, 1, vec![line(1, 10, 20)]);
    let second = batch(meter, 2, vec![line(2, 30, 40), line(1, 1, 1)]);
    apply(&pool, &first).await;
    apply(&pool, &second).await;
    let before = (
        stored_rows(&pool).await,
        ledger::totals(&pool).await.unwrap(),
    );

    // The latest batch and an older one are both acknowledged.
    for resent in [&second, &first] {
        assert_eq!(
            ledger::ingest(&pool, resent).await.unwrap(),
            Outcome::AlreadyApplied
        );
    }
    let after = (
        stored_rows(&pool).await,
        ledger::totals(&pool).await.unwrap(),
    );
    assert_eq!(after, before);
}

#[sqlx::test]
async fn a_batch_ahead_of_the_next_one_is_a_gap_and_is_not_stored(pool: PgPool) {
    // A meter never seen starts at 1, and its refused batch leaves no meter behind.
    let unseen = batch(Uuid::new_v4(), 2, vec![line(1, 1, 1)]);
    assert_eq!(
        refusal(&pool, &unseen).await,
        Refusal::Gap { expected_seq: 1 }
    );
    assert_eq!(stored_rows(&pool).await, (0, 0, 0));

    let meter = Uuid::new_v4();
    apply(&pool, &batch(meter, 1, vec![line(1, 1, 1)])).await;
    let third = batch(meter, 3, vec![line(1, 1, 1)]);
    assert_eq!(
        refusal(&pool, &third).await,
        Refusal::Gap { expected_seq: 2 }
    );
    assert_eq!(stored_rows(&pool).await, (1, 1, 1));

    // Once the lost batch arrives, the refused one is accepted as it was.
    apply(&pool, &batch(meter, 2, vec![line(1, 1, 1)])).await;
    apply(&pool, &third).await;
}

#[sqlx::test]
async fn a_used_seq_or_batch_id_with_other_content_is_a_conflict(pool: PgPool) {
    let first = batch(Uuid::new_v4(), 1, vec![line(1, 10, 20), line(2, 30, 40)]);
    apply(&pool, &first).await;
    let before = (
        stored_rows(&pool).await,
        ledger::totals(&pool).await.unwrap(),
    );

    let mut reordered = first.clone();
    reordered.lines.reverse();
    let conflicting = [
        UsageBatch {
            lines: vec![line(1, 10, 21)],
            ..first.clone()
        },
        reordered,
        UsageBatch {
            batch_id: Uuid::new_v4(),
            ..first.clone()
        },
        UsageBatch {
            seq: 2,
            ..first.clone()
        },
        // A used batch id is a conflict whatever its seq, even past a gap.
        UsageBatch {
            seq: 9,
            ..first.clone()
        },
        UsageBatch {
            meter_id: Uuid::new_v4(),
            ..first.clone()
        },
    ];
    for batch in &conflicting {
        assert_eq!(refusal(&pool, batch).await, Refusal::Conflict);
    }
    let after = (
        stored_rows(&pool).await,
        ledger::totals(&pool).await.unwrap(),
    );
    assert_eq!(after, before);
}

#[sqlx::test]
async fn a_batch_id_taken_by_another_meter_mid_ingest_is_a_conflict(pool: PgPool) {
    // Another meter's ingest that has stored its batch row and not committed yet.
    let (other_meter, batch_id) = (Uuid::new_v4(), Uuid::new_v4());
    let mut in_flight = pool.begin().await.unwrap();
    sqlx::query("insert into usage_meter (meter_id) values ($1)")
        .bind(other_meter)
        .execute(&mut *in_flight)
        .await
        .unwrap();
    sqlx::query("insert into usage_batch (meter_id, seq, batch_id, digest) values ($1, 1, $2, $3)")
        .bind(other_meter)
        .bind(batch_id)
        .bind([0u8; 32].as_slice())
        .execute(&mut *in_flight)
        .await
        .unwrap();

    let late = UsageBatch {
        batch_id,
        ..batch(Uuid::new_v4(), 1, vec![line(1, 1, 1)])
    };
    let racer_pool = pool.clone();
    let racer = tokio::spawn(async move { ledger::ingest(&racer_pool, &late).await });
    wait_for_blocked(&pool, 1).await;
    in_flight.commit().await.unwrap();

    // A refusal, not the unique violation the database would raise.
    assert!(matches!(
        racer.await.unwrap(),
        Err(IngestError::Refused(Refusal::Conflict))
    ));
    // Only the other meter and its batch remain.
    assert_eq!(stored_rows(&pool).await, (1, 1, 0));
}

#[sqlx::test]
async fn invalid_batches_are_refused_without_reaching_the_database(pool: PgPool) {
    // On a closed pool any attempt to run SQL is a database error.
    pool.close().await;
    let meter = Uuid::new_v4();
    assert!(matches!(
        ledger::ingest(&pool, &batch(meter, 1, vec![line(1, 1, 1)])).await,
        Err(IngestError::Database(_))
    ));

    let repeated = line(1, 1, 1);
    let invalid = [
        batch(meter, 0, vec![line(1, 1, 1)]),
        batch(meter, MOST + 1, vec![line(1, 1, 1)]),
        batch(meter, 1, vec![]),
        batch(
            meter,
            1,
            (0..=MAX_LINES_PER_BATCH).map(|_| line(1, 1, 1)).collect(),
        ),
        batch(meter, 1, vec![line(MOST + 1, 0, 0)]),
        batch(meter, 1, vec![line(0, MOST + 1, 0)]),
        batch(meter, 1, vec![line(0, 0, MOST + 1)]),
        batch(meter, 1, vec![line(1, 1, 1), line(0, 0, 0)]),
        batch(meter, 1, vec![repeated.clone(), line(1, 1, 1), repeated]),
    ];
    for batch in &invalid {
        let refusal = refusal(&pool, batch).await;
        assert_eq!(refusal.code(), "invalid", "{refusal}");
    }
}

#[sqlx::test]
async fn racing_connections_apply_a_new_batch_once(
    options: PgPoolOptions,
    connect: PgConnectOptions,
) {
    let pool = options.clone().connect_with(connect.clone()).await.unwrap();
    let meter = Uuid::new_v4();
    apply(&pool, &batch(meter, 1, vec![line(1, 1, 1)])).await;

    // The racers queue on the meter's row lock.
    let mut gate = pool.begin().await.unwrap();
    sqlx::query(LOCK_METER)
        .bind(meter)
        .execute(&mut *gate)
        .await
        .unwrap();
    let second = batch(meter, 2, vec![line(2, 20, 200)]);
    let outcomes = race(&pool, &options, &connect, gate, &second).await;

    assert_eq!((applied_count(&outcomes), outcomes.len()), (1, 4));
    assert_eq!(stored_rows(&pool).await, (1, 2, 2));
    pool.close().await;
}

#[sqlx::test]
async fn racing_connections_apply_the_first_batch_of_a_meter_once(
    options: PgPoolOptions,
    connect: PgConnectOptions,
) {
    let pool = options.clone().connect_with(connect.clone()).await.unwrap();
    let first = batch(Uuid::new_v4(), 1, vec![line(1, 10, 100), line(2, 20, 200)]);

    // There is no meter row to lock yet. The racers queue on a row for this
    // meter that never commits, then race to insert their own.
    let mut gate = pool.begin().await.unwrap();
    sqlx::query("insert into usage_meter (meter_id) values ($1)")
        .bind(first.meter_id)
        .execute(&mut *gate)
        .await
        .unwrap();
    let outcomes = race(&pool, &options, &connect, gate, &first).await;

    assert_eq!((applied_count(&outcomes), outcomes.len()), (1, 4));
    assert_eq!(stored_rows(&pool).await, (1, 1, 2));
    pool.close().await;
}

#[sqlx::test]
async fn racers_apply_once_where_the_database_defaults_to_repeatable_read(pool: PgPool) {
    // Sessions opened from here on start their transactions in repeatable
    // read unless they ask for something else by name.
    let database: String = sqlx::query_scalar("select current_database()::text")
        .fetch_one(&pool)
        .await
        .unwrap();
    let repeatable_read = format!(
        r#"alter database "{database}" set default_transaction_isolation = 'repeatable read'"#
    );
    sqlx::query(AssertSqlSafe(repeatable_read))
        .execute(&pool)
        .await
        .unwrap();
    let racers = PgPoolOptions::new()
        .max_connections(8)
        .connect_with(PgConnectOptions::clone(&pool.connect_options()))
        .await
        .unwrap();
    let level: String = sqlx::query_scalar("show default_transaction_isolation")
        .fetch_one(&racers)
        .await
        .unwrap();
    assert_eq!(level, "repeatable read");

    // The first batch of a meter never seen, then batches of a meter with history.
    let meter = Uuid::new_v4();
    for seq in 1..=5 {
        let next = batch(meter, seq, vec![line(1, 1, 1)]);
        let mut sending = Vec::new();
        for _ in 0..8 {
            let (racers, next) = (racers.clone(), next.clone());
            sending.push(tokio::spawn(
                async move { ledger::ingest(&racers, &next).await },
            ));
        }
        let mut outcomes = Vec::new();
        for racer in sending {
            // A racer working from a snapshot taken before the winner
            // committed would end in a serialization failure here.
            outcomes.push(racer.await.unwrap().unwrap());
        }
        assert_eq!((applied_count(&outcomes), outcomes.len()), (1, 8));
    }
    racers.close().await;
}

#[sqlx::test]
async fn the_keys_the_contract_leans_on_are_in_the_schema(pool: PgPool) {
    let keys: Vec<String> = sqlx::query_scalar(
        r#"
        select conrelid::regclass::text || ' ' || pg_get_constraintdef(oid)
        from pg_constraint
        where contype in ('p', 'u') and connamespace = 'public'::regnamespace
        "#,
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    // Ingest takes the meter lock and checks a batch before it stores it, so
    // it never runs into most of these and no answer would change if one
    // were dropped. They are what still holds when a later change gets the
    // locking wrong.
    for key in [
        "usage_batch PRIMARY KEY (meter_id, seq)",
        "usage_batch UNIQUE (batch_id)",
        "usage_line PRIMARY KEY (batch_id, account_id, device_id)",
        "usage_line UNIQUE (batch_id, line_no)",
    ] {
        assert!(keys.iter().any(|found| found == key), "{key}: {keys:?}");
    }
}

#[sqlx::test]
async fn a_meter_in_flight_holds_up_only_itself(pool: PgPool) {
    let busy = Uuid::new_v4();
    apply(&pool, &batch(busy, 1, vec![line(1, 1, 1)])).await;

    // An ingest for this meter that has taken the meter lock and not finished.
    let mut in_flight = pool.begin().await.unwrap();
    sqlx::query(LOCK_METER)
        .bind(busy)
        .execute(&mut *in_flight)
        .await
        .unwrap();
    let (waiting_pool, next) = (pool.clone(), batch(busy, 2, vec![line(1, 1, 1)]));
    let waiting = tokio::spawn(async move { ledger::ingest(&waiting_pool, &next).await });
    wait_for_blocked(&pool, 1).await;

    let other = batch(Uuid::new_v4(), 1, vec![line(1, 1, 1)]);
    let answer = tokio::time::timeout(Duration::from_secs(10), ledger::ingest(&pool, &other))
        .await
        .expect("another meter waited for this one");
    assert_eq!(answer.unwrap(), Outcome::Applied);
    assert!(!waiting.is_finished());

    in_flight.rollback().await.unwrap();
    assert_eq!(waiting.await.unwrap().unwrap(), Outcome::Applied);
}

#[sqlx::test]
async fn a_meter_that_stays_held_is_given_up_on_and_does_not_use_up_the_pool(pool: PgPool) {
    // One coordinator's whole pool: four ingests left waiting would use it up.
    let coordinator = PgPoolOptions::new()
        .max_connections(4)
        .acquire_timeout(Duration::from_secs(30))
        .connect_with(PgConnectOptions::clone(&pool.connect_options()))
        .await
        .unwrap();
    let stuck = Uuid::new_v4();
    apply(&coordinator, &batch(stuck, 1, vec![line(1, 1, 1)])).await;

    // A session that holds the meter and never lets go.
    let mut holder = pool.begin().await.unwrap();
    sqlx::query(LOCK_METER)
        .bind(stuck)
        .execute(&mut *holder)
        .await
        .unwrap();

    // One sender waits for its answer. Three more give up while their ingest
    // waits on the meter, which leaves the connection waiting without them.
    let next = batch(stuck, 2, vec![line(1, 1, 1)]);
    let mut senders = Vec::new();
    for waiting in 1..=4 {
        let (coordinator, next) = (coordinator.clone(), next.clone());
        senders.push(tokio::spawn(async move {
            ledger::ingest(&coordinator, &next).await
        }));
        wait_for_blocked(&pool, waiting).await;
    }
    let patient = senders.remove(0);
    for impatient in senders {
        impatient.abort();
    }

    // Every connection of the pool is behind the held meter. Another meter is
    // answered all the same, as soon as the first wait is given up.
    let other = batch(Uuid::new_v4(), 1, vec![line(1, 1, 1)]);
    assert_eq!(
        ledger::ingest(&coordinator, &other).await.unwrap(),
        Outcome::Applied
    );

    // The sender that waited is told the lock was not available (SQLSTATE
    // 55P03), nothing of its batch is stored, and no session waits any more.
    let error = match patient.await.unwrap() {
        Err(IngestError::Database(error)) => error,
        other => panic!("expected a lock timeout, got {other:?}"),
    };
    let code = error.as_database_error().and_then(|error| error.code());
    assert_eq!(code.as_deref(), Some("55P03"), "{error}");
    wait_for_blocked(&pool, 0).await;
    assert_eq!(stored_rows(&pool).await, (2, 2, 2));

    // Once the holder ends, the same batch is applied as it was.
    holder.rollback().await.unwrap();
    apply(&coordinator, &next).await;
    coordinator.close().await;
}

#[sqlx::test]
async fn the_largest_batch_is_stored_whole(pool: PgPool) {
    let lines = (0..MAX_LINES_PER_BATCH).map(|_| line(1, 2, 3)).collect();
    let largest = batch(Uuid::new_v4(), 1, lines);
    apply(&pool, &largest).await;

    assert_eq!(
        ledger::totals(&pool).await.unwrap(),
        Totals {
            batches: 1,
            lines: 10_000,
            requests: 10_000,
            bytes_up: 20_000,
            bytes_down: 30_000,
        }
    );
    assert_eq!(
        ledger::ingest(&pool, &largest).await.unwrap(),
        Outcome::AlreadyApplied
    );
}

#[sqlx::test]
async fn totals_too_large_for_u64_are_an_error_and_never_wrap(pool: PgPool) {
    let meter = Uuid::new_v4();
    let two_of_the_most = vec![line(MOST, MOST, MOST), line(MOST, MOST, MOST)];
    apply(&pool, &batch(meter, 1, two_of_the_most)).await;
    apply(&pool, &batch(meter, 2, vec![line(1, 1, 1)])).await;

    // Past what a bigint holds and still exact, up to the last number a u64 holds.
    let totals = ledger::totals(&pool).await.unwrap();
    assert_eq!(
        (totals.requests, totals.bytes_up, totals.bytes_down),
        (u64::MAX, u64::MAX, u64::MAX)
    );

    apply(&pool, &batch(meter, 3, vec![line(0, 1, 0)])).await;
    let error = ledger::totals(&pool).await.unwrap_err();
    assert!(
        matches!(&error, sqlx::Error::ColumnDecode { index, .. } if index == "bytes_up"),
        "{error}"
    );
}

#[sqlx::test]
async fn every_count_is_a_bigint_that_cannot_go_negative(pool: PgPool) {
    let inexact: Vec<(String, String)> = sqlx::query_as(
        r#"
        select table_name::text, column_name::text from information_schema.columns
        where table_schema not in ('pg_catalog', 'information_schema')
            and data_type in ('real', 'double precision', 'numeric', 'money')
        "#,
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    assert!(inexact.is_empty(), "{inexact:?}");

    apply(&pool, &batch(Uuid::new_v4(), 1, vec![line(1, 1, 1)])).await;
    let columns: Vec<(String, String, String)> = sqlx::query_as(
        r#"
        select table_name::text, column_name::text, data_type::text
        from information_schema.columns
        where table_name in ('usage_meter', 'usage_batch', 'usage_line')
        "#,
    )
    .fetch_all(&pool)
    .await
    .unwrap();
    let mut counts = 0;
    for (table, column, data_type) in columns {
        match data_type.as_str() {
            "uuid" | "bytea" => {}
            "bigint" => {
                let negative = format!("update {table} set {column} = -1");
                let error = sqlx::query(AssertSqlSafe(negative))
                    .execute(&pool)
                    .await
                    .unwrap_err();
                let refused_by_check = error
                    .as_database_error()
                    .is_some_and(|error| error.is_check_violation());
                assert!(refused_by_check, "{table}.{column}: {error}");
                counts += 1;
            }
            other => panic!("{table}.{column} is {other}"),
        }
    }
    // seq, line_no, requests, bytes_up and bytes_down.
    assert_eq!(counts, 5);
}

#[test]
fn every_refusal_has_a_stable_code_and_a_fix() {
    let gap = Refusal::Gap { expected_seq: 7 };
    assert_eq!(gap.code(), "gap");
    assert!(gap.fix().contains("seq 7"));

    assert_eq!(Refusal::Conflict.code(), "conflict");
    assert!(!Refusal::Conflict.fix().is_empty());

    let invalid = Refusal::Invalid {
        cause: "the batch has no lines".to_owned(),
    };
    assert_eq!(invalid.code(), "invalid");
    assert_eq!(invalid.to_string(), "the batch has no lines");
    assert!(!invalid.fix().is_empty());
}
