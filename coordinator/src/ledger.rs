//! The usage ledger.
//!
//! Usage is counted in one place, at the edge, and reaches the ledger only as
//! batches from an edge meter. A meter is one edge process's counter: it picks
//! a random `meter_id` when it starts and numbers its batches 1, 2, 3 and so on.
//!
//! # Contract
//!
//! [`ingest`] handles one batch in one database transaction and answers:
//!
//! - [`Outcome::Applied`]: `seq` is exactly one more than the last batch
//!   applied for this meter (1 for a meter never seen) and `batch_id` is new.
//!   The batch and its lines are stored.
//! - [`Outcome::AlreadyApplied`]: this exact batch (same meter, `seq`,
//!   `batch_id` and the same lines in the same order) was applied before.
//!   Nothing changes. The sender treats it as acknowledged.
//! - [`Refusal::Gap`]: `seq` is beyond the next expected one, so an earlier
//!   batch never arrived. Nothing is stored. The sender resends from
//!   `expected_seq`.
//! - [`Refusal::Conflict`]: this `seq` or this `batch_id` was already used by
//!   a batch with different content. Nothing changes.
//! - [`Refusal::Invalid`]: `seq` is 0 or above `i64::MAX`, there are no lines or more than
//!   [`MAX_LINES_PER_BATCH`], a counter is above `i64::MAX`, a line has all
//!   three counters at zero, or two lines share an account and device.
//!
//! When several connections submit the same new batch at the same moment,
//! exactly one is answered `Applied` and the rest `AlreadyApplied`. That is
//! enforced by the database (a row lock or a unique index), never by state in
//! this process, so it holds across any number of coordinator processes.
//!
//! Every counter is stored as `bigint`. No float or numeric column exists in
//! the ledger, and [`totals`] is computed from the stored lines on each call,
//! never read from a running counter.

use std::collections::HashSet;
use std::fmt;

use sha2::{Digest, Sha256};
use sqlx::postgres::PgRow;
use sqlx::{PgConnection, PgPool, Row};
use uuid::Uuid;

/// The most lines one batch may carry.
pub const MAX_LINES_PER_BATCH: usize = 10_000;

/// What one meter counted for one account through one device since its last batch.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UsageLine {
    pub account_id: Uuid,
    pub device_id: Uuid,
    pub requests: u64,
    /// Bytes the buyer sent toward the target.
    pub bytes_up: u64,
    /// Bytes the target sent back to the buyer.
    pub bytes_down: u64,
}

/// One flush of a meter's counters.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct UsageBatch {
    pub meter_id: Uuid,
    pub seq: u64,
    pub batch_id: Uuid,
    pub lines: Vec<UsageLine>,
}

/// A batch the ledger accepts as recorded.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Outcome {
    Applied,
    AlreadyApplied,
}

/// A batch the ledger will not record. See the module contract.
#[derive(Debug, Clone, PartialEq, Eq, thiserror::Error)]
pub enum Refusal {
    #[error("batch {expected_seq} from this meter has not arrived yet")]
    Gap { expected_seq: u64 },
    #[error("this sequence number or batch id was already used by a different batch")]
    Conflict,
    #[error("{cause}")]
    Invalid { cause: String },
}

impl Refusal {
    /// A stable name for programs.
    pub fn code(&self) -> &'static str {
        match self {
            Refusal::Gap { .. } => "gap",
            Refusal::Conflict => "conflict",
            Refusal::Invalid { .. } => "invalid",
        }
    }

    /// What the sender should do next.
    pub fn fix(&self) -> String {
        match self {
            Refusal::Gap { expected_seq } => {
                format!("resend this meter's batches in order, starting at seq {expected_seq}")
            }
            // Sending the same usage again under a new id could count it twice,
            // so a conflict is never something the sender repairs by itself.
            Refusal::Conflict => "do not send this batch again or under another id: \
                stop this meter, keep the batch and report it to the operator"
                .to_owned(),
            Refusal::Invalid { .. } => {
                "nothing was stored: correct the batch as the cause says, then send it again"
                    .to_owned()
            }
        }
    }
}

#[derive(Debug, thiserror::Error)]
pub enum IngestError {
    #[error(transparent)]
    Refused(#[from] Refusal),
    #[error(transparent)]
    Database(#[from] sqlx::Error),
}

/// Sums over every batch the ledger has applied.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Default)]
pub struct Totals {
    pub batches: u64,
    pub lines: u64,
    pub requests: u64,
    pub bytes_up: u64,
    pub bytes_down: u64,
}

/// How every ingest transaction starts, sent as one message.
///
/// Read committed is asked for by name, not left to the server default: each
/// statement in `apply` has to see what the last holder of the meter lock
/// committed, which a transaction-wide snapshot would hide.
///
/// The lock timeout ends a wait for a lock held by another session. An ingest
/// holds its meter for milliseconds, so a wait this long means the holder is
/// stuck. Without a limit the ingests behind it never end, a caller that
/// gives up leaves its connection waiting all the same, and the pool runs out
/// for every other meter. Postgres times each wait on its own, and an ingest
/// queued behind another waits twice (for its turn, then for the holder), so
/// it can take about twice this long. A wait that is given up ends the ingest
/// with the database error SQLSTATE 55P03 and nothing stored.
const BEGIN: &str = "begin isolation level read committed; set local lock_timeout = '2s'";

/// Brings the database schema up to date.
pub async fn migrate(pool: &PgPool) -> Result<(), sqlx::migrate::MigrateError> {
    sqlx::migrate!().run(pool).await
}

/// Records one usage batch, or says why not. See the module contract.
pub async fn ingest(pool: &PgPool, batch: &UsageBatch) -> Result<Outcome, IngestError> {
    let checked = check(batch)?;
    let digest = digest(batch);
    let mut tx = pool.begin_with(BEGIN).await?;
    let result = apply(&mut tx, batch, &checked, &digest).await;
    // Only an applied batch has anything to keep. Everything else is rolled
    // back here and not on drop, so the meter lock is free, and the meter row
    // made for a refused first batch is gone, before the caller has its answer.
    if matches!(result, Ok(Outcome::Applied)) {
        tx.commit().await?;
    } else {
        tx.rollback().await?;
    }
    result
}

/// Totals computed from the stored lines.
pub async fn totals(pool: &PgPool) -> Result<Totals, sqlx::Error> {
    // Postgres sums bigint exactly at any size, which can be more than a
    // bigint holds, so each figure crosses as text and `total` decides
    // whether it fits.
    let row = sqlx::query(
        r#"
        select
            count(distinct batch_id)::text as batches,
            count(*)::text as lines,
            coalesce(sum(requests), 0)::text as requests,
            coalesce(sum(bytes_up), 0)::text as bytes_up,
            coalesce(sum(bytes_down), 0)::text as bytes_down
        from usage_line
        "#,
    )
    .fetch_one(pool)
    .await?;
    Ok(Totals {
        batches: total(&row, "batches")?,
        lines: total(&row, "lines")?,
        requests: total(&row, "requests")?,
        bytes_up: total(&row, "bytes_up")?,
        bytes_down: total(&row, "bytes_down")?,
    })
}

/// Reads one total. A figure too large for `u64` is an error, never a wrapped number.
fn total(row: &PgRow, column: &str) -> Result<u64, sqlx::Error> {
    let digits: String = row.try_get(column)?;
    digits.parse().map_err(|source| sqlx::Error::ColumnDecode {
        index: column.to_owned(),
        source: Box::new(source),
    })
}

/// A batch that passed every `Invalid` rule, in the types its columns hold.
/// The lines are one array per column so that one statement writes them all.
struct Checked {
    seq: i64,
    account_ids: Vec<Uuid>,
    device_ids: Vec<Uuid>,
    requests: Vec<i64>,
    bytes_up: Vec<i64>,
    bytes_down: Vec<i64>,
}

/// Applies every `Invalid` rule without touching the database.
fn check(batch: &UsageBatch) -> Result<Checked, Refusal> {
    if batch.seq == 0 {
        return Err(invalid(
            "seq is 0: a meter numbers its batches from 1".to_owned(),
        ));
    }
    let line_count = batch.lines.len();
    if line_count == 0 {
        return Err(invalid("the batch has no lines".to_owned()));
    }
    if line_count > MAX_LINES_PER_BATCH {
        return Err(invalid(format!(
            "the batch has {line_count} lines: the most is {MAX_LINES_PER_BATCH}"
        )));
    }

    let mut checked = Checked {
        seq: to_bigint(batch.seq, format_args!("seq"))?,
        account_ids: Vec::with_capacity(line_count),
        device_ids: Vec::with_capacity(line_count),
        requests: Vec::with_capacity(line_count),
        bytes_up: Vec::with_capacity(line_count),
        bytes_down: Vec::with_capacity(line_count),
    };
    let mut seen = HashSet::with_capacity(line_count);
    for (index, line) in batch.lines.iter().enumerate() {
        // Lines are numbered from 1, as they are stored.
        let line_no = index + 1;
        if line.requests == 0 && line.bytes_up == 0 && line.bytes_down == 0 {
            return Err(invalid(format!(
                "line {line_no} counts nothing: requests, bytes_up and bytes_down are all 0"
            )));
        }
        if !seen.insert((line.account_id, line.device_id)) {
            return Err(invalid(format!(
                "line {line_no} repeats the account and device of an earlier line"
            )));
        }
        checked.account_ids.push(line.account_id);
        checked.device_ids.push(line.device_id);
        checked.requests.push(to_bigint(
            line.requests,
            format_args!("requests on line {line_no}"),
        )?);
        checked.bytes_up.push(to_bigint(
            line.bytes_up,
            format_args!("bytes_up on line {line_no}"),
        )?);
        checked.bytes_down.push(to_bigint(
            line.bytes_down,
            format_args!("bytes_down on line {line_no}"),
        )?);
    }
    Ok(checked)
}

fn invalid(cause: String) -> Refusal {
    Refusal::Invalid { cause }
}

/// Converts a count to the type of its column, or refuses it by name. The
/// name is only formatted when the count is refused.
fn to_bigint(value: u64, name: fmt::Arguments<'_>) -> Result<i64, Refusal> {
    i64::try_from(value)
        .map_err(|_| invalid(format!("{name} is {value}: the most is {}", i64::MAX)))
}

/// SHA-256 over the batch exactly as it was sent. Every field has a fixed
/// width (an id is 16 bytes, a count is 8 bytes big-endian) and the lines
/// follow in order, so two batches share an encoding only when they are the
/// same batch.
fn digest(batch: &UsageBatch) -> [u8; 32] {
    let mut hasher = Sha256::new();
    hasher.update(batch.meter_id.as_bytes());
    hasher.update(batch.seq.to_be_bytes());
    hasher.update(batch.batch_id.as_bytes());
    for line in &batch.lines {
        hasher.update(line.account_id.as_bytes());
        hasher.update(line.device_id.as_bytes());
        hasher.update(line.requests.to_be_bytes());
        hasher.update(line.bytes_up.to_be_bytes());
        hasher.update(line.bytes_down.to_be_bytes());
    }
    hasher.finalize().into()
}

/// Decides one checked batch inside the caller's transaction, and stores it
/// when the answer is `Applied`.
async fn apply(
    conn: &mut PgConnection,
    batch: &UsageBatch,
    checked: &Checked,
    digest: &[u8; 32],
) -> Result<Outcome, IngestError> {
    lock_meter(conn, batch.meter_id).await?;

    let stored: Vec<Vec<u8>> = sqlx::query_scalar(
        "select digest from usage_batch where (meter_id = $1 and seq = $2) or batch_id = $3",
    )
    .bind(batch.meter_id)
    .bind(checked.seq)
    .bind(batch.batch_id)
    .fetch_all(&mut *conn)
    .await?;
    // The digest covers the meter, the seq and the batch id, so an equal one
    // can only be this very batch.
    if stored.iter().any(|other| other.as_slice() == digest) {
        return Ok(Outcome::AlreadyApplied);
    }
    if !stored.is_empty() {
        return Err(Refusal::Conflict.into());
    }

    let last_seq: i64 =
        sqlx::query_scalar("select coalesce(max(seq), 0) from usage_batch where meter_id = $1")
            .bind(batch.meter_id)
            .fetch_one(&mut *conn)
            .await?;
    // A stored seq is 1 or more, so the unsigned value is the same number and
    // one more always fits.
    let expected_seq = last_seq.unsigned_abs() + 1;
    // Every seq up to the last one is stored and was answered above, so a seq
    // that is not the next one is ahead of it.
    if batch.seq != expected_seq {
        return Err(Refusal::Gap { expected_seq }.into());
    }

    let inserted = sqlx::query(
        r#"
        insert into usage_batch (meter_id, seq, batch_id, digest)
        values ($1, $2, $3, $4)
        on conflict (batch_id) do nothing
        "#,
    )
    .bind(batch.meter_id)
    .bind(checked.seq)
    .bind(batch.batch_id)
    .bind(digest.as_slice())
    .execute(&mut *conn)
    .await?
    .rows_affected();
    // The lookup above found this batch id free, so it was taken since then,
    // and only an ingest for another meter could have done that: this meter
    // is locked.
    if inserted == 0 {
        return Err(Refusal::Conflict.into());
    }

    sqlx::query(
        r#"
        insert into usage_line
            (batch_id, line_no, account_id, device_id, requests, bytes_up, bytes_down)
        select $1, line_no, account_id, device_id, requests, bytes_up, bytes_down
        from unnest($2::uuid[], $3::uuid[], $4::bigint[], $5::bigint[], $6::bigint[])
            with ordinality
            as line (account_id, device_id, requests, bytes_up, bytes_down, line_no)
        "#,
    )
    .bind(batch.batch_id)
    .bind(&checked.account_ids)
    .bind(&checked.device_ids)
    .bind(&checked.requests)
    .bind(&checked.bytes_up)
    .bind(&checked.bytes_down)
    .execute(&mut *conn)
    .await?;
    Ok(Outcome::Applied)
}

/// Takes the row lock that makes ingests for one meter run one at a time,
/// creating the row for a meter never seen. Other meters are not touched.
async fn lock_meter(conn: &mut PgConnection, meter_id: Uuid) -> Result<(), sqlx::Error> {
    // Two first batches of one meter meet here: the second waits for the
    // first to commit or roll back, then finds the row or inserts it.
    sqlx::query("insert into usage_meter (meter_id) values ($1) on conflict (meter_id) do nothing")
        .bind(meter_id)
        .execute(&mut *conn)
        .await?;
    // The lock is a statement of its own and reads nothing else. A statement
    // sees the database as it was when it started, so anything read in the
    // same statement as the wait would miss what the lock holder committed.
    sqlx::query("select from usage_meter where meter_id = $1 for update")
        .bind(meter_id)
        .execute(&mut *conn)
        .await?;
    Ok(())
}
