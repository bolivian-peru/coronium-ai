//! An open-loop load generator against an HTTP proxy endpoint.
//!
//! Open loop means the clock decides when a request starts, not the answers:
//! request `i` is due `i / rate` seconds after the run begins whether or not
//! earlier requests have finished, and its latency is measured from the
//! moment it was due. A system that falls behind is therefore shown falling
//! behind, where a generator that waited for answers would slow down with it
//! and report good latency.
//!
//! There is a cap on requests in flight. A request that was due while the cap
//! was reached is not sent late and not skipped quietly: it is counted as not
//! started.
//!
//! Each request opens a connection to the proxy, sends CONNECT, and through
//! the tunnel asks a simulated device for the body of `(seed, length)`, where
//! the seed is the request's number in the run. Every request so expects a
//! different body, and one that is answered with another request's bytes
//! fails its hash. Tunnel bytes are counted at the socket, as they are
//! written and read, so the totals are exact even for a request that fails
//! half-way. They are what a correct meter at the edge counts as DATA.

use std::collections::BTreeMap;
use std::fmt;
use std::io;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use serde::Serialize;
use sha2::{Digest, Sha256};
use sysinfo::{CpuRefreshKind, System};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::TcpStream;
use tokio::sync::{OwnedSemaphorePermit, Semaphore};
use tokio::time::{Instant, sleep_until, timeout};

use crate::Refusal;
use crate::guard::TestAddr;
use crate::http;
use crate::payload;

/// The longest response head a request reads before it gives up on it.
const MAX_HEAD: usize = 4096;

/// The value of the `Proxy-Authorization` header, sent exactly as given. It
/// is a secret: `Debug` does not print it and nothing in this crate does.
pub struct Authorization(String);

impl Authorization {
    pub fn new(value: String) -> Result<Self, Refusal> {
        // A line break in the value would let it add headers of its own.
        let fits_a_header = !value.is_empty() && value.chars().all(|c| (' '..='~').contains(&c));
        if fits_a_header {
            return Ok(Self(value));
        }
        Err(Refusal {
            cause: "the Proxy-Authorization value is empty or is not printable ASCII".to_owned(),
            fix: "give the header value on one line, for example a scheme and a token".to_owned(),
        })
    }
}

impl fmt::Debug for Authorization {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Authorization({} bytes)", self.0.len())
    }
}

/// One run of the load generator.
#[derive(Debug)]
pub struct Config {
    pub proxy: TestAddr,
    pub authorization: Authorization,
    /// Requests per second.
    pub rate: u32,
    /// How long requests are started for.
    pub seconds: u32,
    /// The cap on requests in flight.
    pub max_in_flight: u32,
    /// The body lengths to ask for. Request `i` asks for entry `i` modulo the
    /// number of entries.
    pub body_bytes: Vec<u64>,
    /// How long one request may take from its start. Every request ends, so
    /// a run ends.
    pub timeout: Duration,
    /// How many nodes the system under test runs on. The generator cannot
    /// see that, so whoever runs it says so.
    pub nodes: u32,
}

/// The result of a run. Every figure this project reports names its
/// hardware, node count and test length, so they are part of it.
#[derive(Debug, Serialize)]
pub struct Report {
    pub target_rate_per_second: u32,
    pub test_length_seconds: u32,
    /// The nodes of the system under test, as stated by whoever ran the test.
    pub node_count: u32,
    /// The machine the generator ran on.
    pub hardware: Hardware,
    pub max_in_flight: u32,
    pub body_bytes: Vec<u64>,
    /// `rate * seconds`: every request is either started or not started.
    pub requests_scheduled: u64,
    pub requests_started: u64,
    /// Due while the cap on requests in flight was reached, so never sent.
    pub requests_not_started: u64,
    /// Started and ended, in any way: ok, a hash mismatch or a failure. It
    /// equals `requests_started` unless the generator itself lost a request.
    pub requests_completed: u64,
    /// A whole response of the right length whose SHA-256 matched.
    pub requests_ok: u64,
    /// A whole response of the right length whose SHA-256 did not match.
    pub hash_mismatches: u64,
    /// Requests that got no whole response, by cause.
    pub failures: BTreeMap<String, u64>,
    /// Bytes written into tunnels and read from them, counted at the socket.
    /// The CONNECT exchange with the proxy is not part of either.
    pub tunnel_bytes_written: u64,
    pub tunnel_bytes_read: u64,
    /// Latency of the ok requests, from the moment each was due to the last
    /// byte of its body. `None` when no request was ok.
    pub ok_latency_us: Option<Latency>,
}

/// Percentiles by nearest rank, in whole microseconds.
#[derive(Debug, PartialEq, Eq, Serialize)]
pub struct Latency {
    pub p50: u64,
    pub p90: u64,
    pub p99: u64,
    pub max: u64,
}

impl Latency {
    fn of(mut samples: Vec<u64>) -> Option<Self> {
        samples.sort_unstable();
        let max = *samples.last()?;
        Some(Self {
            p50: nearest_rank(&samples, 50),
            p90: nearest_rank(&samples, 90),
            p99: nearest_rank(&samples, 99),
            max,
        })
    }
}

/// The smallest sample that `percent` of the samples do not exceed. The
/// samples are sorted and there is at least one.
fn nearest_rank(sorted: &[u64], percent: usize) -> u64 {
    sorted[(sorted.len() * percent).div_ceil(100) - 1]
}

/// The machine a figure was measured on.
#[derive(Debug, Serialize)]
pub struct Hardware {
    pub cpu_model: String,
    pub cpu_cores: usize,
    pub memory_bytes: u64,
    pub os: String,
}

impl Hardware {
    fn detect() -> Self {
        let mut system = System::new();
        system.refresh_cpu_list(CpuRefreshKind::nothing());
        system.refresh_memory();
        // Some systems list their CPUs without a model name.
        let cpu_model = system.cpus().first().map(|cpu| cpu.brand().trim());
        let cpu_model = cpu_model.filter(|model| !model.is_empty());
        let os = System::long_os_version().unwrap_or_else(|| "unknown".to_owned());
        Self {
            cpu_model: cpu_model.unwrap_or("unknown").to_owned(),
            cpu_cores: system.cpus().len(),
            memory_bytes: system.total_memory(),
            os: format!("{os} ({})", System::cpu_arch()),
        }
    }
}

/// Where a request failed.
#[derive(Debug, thiserror::Error)]
enum Failure {
    #[error("connect: {0}")]
    Connect(io::ErrorKind),
    /// The CONNECT exchange with the proxy.
    #[error("proxy: {0}")]
    Proxy(Fault),
    /// The request and response through the tunnel.
    #[error("tunnel: {0}")]
    Tunnel(Fault),
    #[error("timeout")]
    Timeout,
}

/// What went wrong in one exchange.
#[derive(Debug, thiserror::Error)]
enum Fault {
    #[error("{0}")]
    Io(io::ErrorKind),
    #[error("closed early")]
    Closed,
    #[error("malformed response")]
    Malformed,
    #[error("status {0}")]
    Status(u16),
}

impl From<io::Error> for Fault {
    fn from(error: io::Error) -> Self {
        Self::Io(error.kind())
    }
}

/// How one started request ended.
enum Outcome {
    Ok { latency: Duration },
    HashMismatch,
    Failed(Failure),
}

/// What the requests of a run have added up to so far.
#[derive(Default)]
struct Tally {
    completed: u64,
    ok: u64,
    hash_mismatches: u64,
    failures: BTreeMap<String, u64>,
    ok_latencies_us: Vec<u64>,
}

impl Tally {
    fn record(&mut self, outcome: Outcome) {
        self.completed += 1;
        match outcome {
            Outcome::Ok { latency } => {
                self.ok += 1;
                let latency = u64::try_from(latency.as_micros()).unwrap_or(u64::MAX);
                self.ok_latencies_us.push(latency);
            }
            Outcome::HashMismatch => self.hash_mismatches += 1,
            Outcome::Failed(failure) => *self.failures.entry(failure.to_string()).or_default() += 1,
        }
    }
}

/// What every request of a run shares.
struct Run {
    config: Config,
    tally: Mutex<Tally>,
    tunnel_bytes_written: AtomicU64,
    tunnel_bytes_read: AtomicU64,
}

/// Runs the load and reports what happened.
pub async fn run(config: Config) -> Result<Report, Refusal> {
    if config.rate == 0 || config.max_in_flight == 0 || config.body_bytes.is_empty() {
        return Err(Refusal {
            cause: "the rate, the cap on requests in flight or the list of body lengths is empty"
                .to_owned(),
            fix: "give a rate and a cap of at least 1, and at least one body length".to_owned(),
        });
    }
    let rate = u64::from(config.rate);
    let scheduled = rate * u64::from(config.seconds);
    let cap = config.max_in_flight;
    let run = Arc::new(Run {
        config,
        tally: Mutex::default(),
        tunnel_bytes_written: AtomicU64::new(0),
        tunnel_bytes_read: AtomicU64::new(0),
    });
    let in_flight = Arc::new(Semaphore::new(cap as usize));

    let begin = Instant::now();
    let mut started = 0;
    for number in 0..scheduled {
        let due = begin + Duration::from_nanos(number * 1_000_000_000 / rate);
        // A generator that is behind does not sleep: it starts everything
        // that is due, and the lateness shows in the latency.
        if Instant::now() < due {
            sleep_until(due).await;
        }
        if let Ok(permit) = in_flight.clone().try_acquire_owned() {
            started += 1;
            tokio::spawn(request(run.clone(), number, due, permit));
        }
    }
    // Every permit back means every request has ended, and each one is
    // bounded by the timeout.
    let _all = in_flight.acquire_many(cap).await;

    let tally = std::mem::take(&mut *run.tally.lock().unwrap());
    let config = &run.config;
    Ok(Report {
        target_rate_per_second: config.rate,
        test_length_seconds: config.seconds,
        node_count: config.nodes,
        hardware: Hardware::detect(),
        max_in_flight: cap,
        body_bytes: config.body_bytes.clone(),
        requests_scheduled: scheduled,
        requests_started: started,
        requests_not_started: scheduled - started,
        requests_completed: tally.completed,
        requests_ok: tally.ok,
        hash_mismatches: tally.hash_mismatches,
        failures: tally.failures,
        tunnel_bytes_written: run.tunnel_bytes_written.load(Ordering::Relaxed),
        tunnel_bytes_read: run.tunnel_bytes_read.load(Ordering::Relaxed),
        ok_latency_us: Latency::of(tally.ok_latencies_us),
    })
}

/// Carries out request `number` of a run and records how it ended. The
/// permit is its place under the cap, given back when the request is over.
async fn request(run: Arc<Run>, number: u64, due: Instant, _permit: OwnedSemaphorePermit) {
    let lengths = &run.config.body_bytes;
    let length = lengths[(number % lengths.len() as u64) as usize];
    let outcome = match timeout(run.config.timeout, exchange(&run, number, length)).await {
        Ok(Ok(digest)) => {
            // The clock stops at the last byte. Working out the expected hash
            // is the generator's cost, not the latency of what it measures.
            let latency = due.elapsed();
            if digest == payload::sha256(number, length) {
                Outcome::Ok { latency }
            } else {
                Outcome::HashMismatch
            }
        }
        Ok(Err(failure)) => Outcome::Failed(failure),
        Err(_) => Outcome::Failed(Failure::Timeout),
    };
    run.tally.lock().unwrap().record(outcome);
}

/// One request through the proxy: the SHA-256 of the body that came back.
async fn exchange(run: &Run, seed: u64, length: u64) -> Result<[u8; 32], Failure> {
    let config = &run.config;
    let connected = config.proxy.connect().await;
    let mut stream = connected.map_err(|error| Failure::Connect(error.kind()))?;
    // What has been read from the socket and not used yet.
    let mut received = Vec::new();
    open_tunnel(&mut stream, &mut received, &config.authorization)
        .await
        .map_err(Failure::Proxy)?;
    // Anything behind the proxy's answer has already come through the tunnel.
    run.tunnel_bytes_read
        .fetch_add(received.len() as u64, Ordering::Relaxed);
    fetch(run, &mut stream, received, seed, length)
        .await
        .map_err(Failure::Tunnel)
}

/// Sends CONNECT and takes the proxy's answer off the front of `received`.
async fn open_tunnel(
    stream: &mut TcpStream,
    received: &mut Vec<u8>,
    authorization: &Authorization,
) -> Result<(), Fault> {
    let target = http::TARGET;
    let authorization = &authorization.0;
    let connect = format!(
        "CONNECT {target} HTTP/1.1\r\nHost: {target}\r\nProxy-Authorization: {authorization}\r\n\r\n"
    );
    stream.write_all(connect.as_bytes()).await?;
    let head = read_head(stream, received, None).await?;
    let status = http::status(&received[..head]).ok_or(Fault::Malformed)?;
    if status != 200 {
        return Err(Fault::Status(status));
    }
    received.drain(..head);
    Ok(())
}

/// Asks for the body of `(seed, length)` through an open tunnel and hashes
/// what comes back.
async fn fetch(
    run: &Run,
    stream: &mut TcpStream,
    mut received: Vec<u8>,
    seed: u64,
    length: u64,
) -> Result<[u8; 32], Fault> {
    let request = http::bytes_request(seed, length);
    let mut unsent = request.as_bytes();
    while !unsent.is_empty() {
        let count = stream.write(unsent).await?;
        if count == 0 {
            return Err(Fault::Closed);
        }
        run.tunnel_bytes_written
            .fetch_add(count as u64, Ordering::Relaxed);
        unsent = &unsent[count..];
    }

    let head = read_head(stream, &mut received, Some(&run.tunnel_bytes_read)).await?;
    let status = http::status(&received[..head]).ok_or(Fault::Malformed)?;
    if status != 200 {
        return Err(Fault::Status(status));
    }
    // The body starts with whatever arrived behind the head.
    let body_so_far = (received.len() - head) as u64;
    if http::content_length(&received[..head]) != Some(length) || body_so_far > length {
        return Err(Fault::Malformed);
    }
    let mut hasher = Sha256::new();
    hasher.update(&received[head..]);
    let mut left = length - body_so_far;
    let mut piece = [0; 16384];
    while left > 0 {
        // Never past the end of the body, so nothing is read that is not counted.
        let want = usize::try_from(left).map_or(piece.len(), |left| left.min(piece.len()));
        let count = stream.read(&mut piece[..want]).await?;
        if count == 0 {
            return Err(Fault::Closed);
        }
        run.tunnel_bytes_read
            .fetch_add(count as u64, Ordering::Relaxed);
        hasher.update(&piece[..count]);
        left -= count as u64;
    }
    Ok(hasher.finalize().into())
}

/// Reads until `received` holds a whole HTTP head and returns the head's
/// length. Bytes read are added to `counter` as they arrive.
async fn read_head(
    stream: &mut TcpStream,
    received: &mut Vec<u8>,
    counter: Option<&AtomicU64>,
) -> Result<usize, Fault> {
    let mut piece = [0; 512];
    loop {
        if let Some(end) = http::head_end(received) {
            return Ok(end);
        }
        if received.len() > MAX_HEAD {
            return Err(Fault::Malformed);
        }
        let count = stream.read(&mut piece).await?;
        if count == 0 {
            return Err(Fault::Closed);
        }
        if let Some(counter) = counter {
            counter.fetch_add(count as u64, Ordering::Relaxed);
        }
        received.extend_from_slice(&piece[..count]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn percentiles_are_by_nearest_rank() {
        let latency = Latency::of((1..=100).rev().collect()).unwrap();
        assert_eq!(
            (latency.p50, latency.p90, latency.p99, latency.max),
            (50, 90, 99, 100)
        );

        let latency = Latency::of(vec![7]).unwrap();
        assert_eq!(
            (latency.p50, latency.p90, latency.p99, latency.max),
            (7, 7, 7, 7)
        );

        let latency = Latency::of(vec![10, 20, 30]).unwrap();
        assert_eq!(
            (latency.p50, latency.p90, latency.p99, latency.max),
            (20, 30, 30, 30)
        );

        assert_eq!(Latency::of(Vec::new()), None);
    }

    #[test]
    fn the_authorization_is_one_header_value_and_is_never_shown() {
        let authorization = Authorization::new("Bearer made-up-token".to_owned()).unwrap();
        assert_eq!(format!("{authorization:?}"), "Authorization(20 bytes)");

        for value in ["", "Bearer a\r\nX-Other: b", "Bearer \u{e9}", "tab\tbed"] {
            assert!(Authorization::new(value.to_owned()).is_err(), "{value:?}");
        }
    }

    #[test]
    fn the_hardware_is_named() {
        let hardware = Hardware::detect();
        assert!(!hardware.cpu_model.is_empty());
        assert!(hardware.cpu_cores > 0);
        assert!(hardware.memory_bytes > 0);
        assert!(!hardware.os.is_empty());
    }

    #[test]
    fn a_failure_is_named_by_where_and_what() {
        let refused = Failure::Connect(io::ErrorKind::ConnectionRefused);
        assert_eq!(refused.to_string(), "connect: connection refused");
        assert_eq!(
            Failure::Proxy(Fault::Status(407)).to_string(),
            "proxy: status 407"
        );
        assert_eq!(
            Failure::Tunnel(Fault::Closed).to_string(),
            "tunnel: closed early"
        );
    }
}
