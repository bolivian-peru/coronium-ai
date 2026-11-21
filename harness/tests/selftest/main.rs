//! The harness tested against itself, before the system it will test exists.
//!
//! [`standin`] plays the edge and the relay between the two tools. What is
//! proved here is that the checks can pass and can fail: a clean run is
//! delivered by hash and metered to the byte, one corrupted byte is reported,
//! and neither tool will connect to a public address.

mod device;
mod standin;

use std::collections::BTreeMap;
use std::net::SocketAddr;
use std::process::{Command, Output};
use std::time::Duration;

use coronium_harness::guard::TestAddr;
use coronium_harness::loadgen::{self, Authorization, Config};
use coronium_harness::simdevice::{self, End};
use coronium_proto::frame::Credential;
use tokio::net::TcpListener;
use tokio::task::{JoinHandle, spawn_blocking};
use tokio::time::timeout;

use standin::{AUTHORIZATION, Standin};

/// Longer than anything here takes, so a fault fails and never hangs.
const WAIT: Duration = Duration::from_secs(30);

type Device = JoinHandle<Result<End, simdevice::Error>>;

fn start_device(relay: SocketAddr, index: u32, max_streams: u16) -> Device {
    tokio::spawn(simdevice::run(simdevice::Config {
        relay: TestAddr::new(relay).unwrap(),
        id: simdevice::device_id(index),
        max_streams,
        credential: Credential(b"made-up".to_vec()),
    }))
}

async fn start_devices(standin: &Standin, count: u32, max_streams: u16) -> Vec<Device> {
    let devices = (0..count)
        .map(|index| start_device(standin.relay, index, max_streams))
        .collect();
    let connected = timeout(WAIT, standin.devices(count as usize)).await;
    connected.expect("the devices did not connect");
    devices
}

fn load(proxy: SocketAddr, rate: u32, seconds: u32, body_bytes: &[u64]) -> Config {
    Config {
        proxy: TestAddr::new(proxy).unwrap(),
        authorization: Authorization::new(AUTHORIZATION.to_owned()).unwrap(),
        rate,
        seconds,
        // Room for every request of the run at once, so that a slow machine
        // shows as latency here and never as requests not started.
        max_in_flight: rate * seconds,
        body_bytes: body_bytes.to_vec(),
        timeout: WAIT,
        nodes: 1,
    }
}

/// The bytes one request puts into its tunnel and takes out of it, worked
/// out from the two messages alone.
fn tunnel_bytes(seed: u64, length: u64) -> (u64, u64) {
    let request =
        format!("GET /bytes/{length}?seed={seed} HTTP/1.1\r\nHost: simdevice.invalid:80\r\n\r\n");
    let head = format!("HTTP/1.1 200 OK\r\nContent-Length: {length}\r\nConnection: close\r\n\r\n");
    (request.len() as u64, head.len() as u64 + length)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn load_through_simulated_devices_is_delivered_by_hash_and_metered_to_the_byte() {
    // Bodies on both sides of the first window. The window is 16384 bytes
    // and the head of these answers 61, so 16323 is the longest body that
    // needs no WINDOW, 16324 waits for one and 33000 waits twice.
    const BODIES: [u64; 6] = [0, 1, 1500, 16323, 16324, 33000];
    let standin = Standin::start().await;
    // 20 devices of 1024 streams hold more than the whole run at once.
    let devices = start_devices(&standin, 20, 1024).await;

    let report = loadgen::run(load(standin.proxy, 750, 4, &BODIES))
        .await
        .unwrap();

    assert_eq!(report.requests_scheduled, 3000);
    assert_eq!(report.requests_started, 3000);
    assert_eq!(report.requests_not_started, 0);
    assert_eq!(report.requests_completed, 3000);
    assert_eq!(report.requests_ok, 3000, "{:?}", report.failures);
    assert_eq!(report.hash_mismatches, 0);
    assert_eq!(report.failures, BTreeMap::new());

    // The generator's count, the meter's count and the count worked out from
    // the messages are three separate sums, and they agree to the byte.
    let mut expected = (0, 0);
    for number in 0..3000 {
        let (up, down) = tunnel_bytes(number, BODIES[number as usize % BODIES.len()]);
        expected = (expected.0 + up, expected.1 + down);
    }
    let counted = (report.tunnel_bytes_written, report.tunnel_bytes_read);
    assert_eq!(counted, expected);
    assert_eq!(standin.metered(), expected);

    let latency = report.ok_latency_us.expect("ok requests have a latency");
    assert!(0 < latency.p50 && latency.p50 <= latency.p90);
    assert!(latency.p90 <= latency.p99 && latency.p99 <= latency.max);
    assert_eq!((report.node_count, report.test_length_seconds), (1, 4));
    assert!(!report.hardware.cpu_model.is_empty());

    standin.hang_up();
    for device in devices {
        let end = timeout(WAIT, device).await.unwrap().unwrap();
        assert!(matches!(end, Ok(End::Closed)), "{end:?}");
    }
    let nothing: Vec<String> = Vec::new();
    let (violations, faults) = standin.violations();
    assert_eq!(violations, nothing, "rules broken by simulated devices");
    assert_eq!(faults, nothing, "rules broken by the stand-in");
}

/// The check must be able to fail, or passing it proves nothing.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn one_corrupted_byte_is_reported_as_a_hash_mismatch() {
    let standin = Standin::start().await;
    let _devices = start_devices(&standin, 2, 64).await;
    standin.corrupt_one_byte();

    let report = loadgen::run(load(standin.proxy, 100, 1, &[20_000]))
        .await
        .unwrap();

    assert_eq!(report.hash_mismatches, 1);
    assert_eq!(report.requests_ok, 99);
    assert_eq!(report.requests_completed, 100);
    assert_eq!(report.failures, BTreeMap::new());
    // The length was right, so the byte counts still agree. Only the hash
    // can tell.
    let counted = (report.tunnel_bytes_written, report.tunnel_bytes_read);
    assert_eq!(counted, standin.metered());
}

#[tokio::test]
async fn a_refused_credential_is_a_failure_with_its_cause() {
    let standin = Standin::start().await;
    let mut config = load(standin.proxy, 50, 1, &[100]);
    config.authorization = Authorization::new("Bearer not-the-one".to_owned()).unwrap();

    let report = loadgen::run(config).await.unwrap();

    let failures = BTreeMap::from([("proxy: status 407".to_owned(), 50)]);
    assert_eq!(report.failures, failures);
    assert_eq!((report.requests_completed, report.requests_ok), (50, 0));
    assert_eq!(report.ok_latency_us, None);
    // Nothing was put into a tunnel, and the meter saw nothing.
    assert_eq!(
        (report.tunnel_bytes_written, report.tunnel_bytes_read),
        (0, 0)
    );
    assert_eq!(standin.metered(), (0, 0));
}

#[tokio::test]
async fn a_request_held_back_by_the_cap_is_counted_and_never_sent() {
    // A proxy that takes connections and never answers keeps requests in flight.
    let silent = TcpListener::bind("127.0.0.1:0").await.unwrap();
    let mut config = load(silent.local_addr().unwrap(), 50, 1, &[100]);
    config.max_in_flight = 2;
    config.timeout = Duration::from_millis(300);

    let report = loadgen::run(config).await.unwrap();

    assert_eq!(report.requests_scheduled, 50);
    assert_eq!(report.requests_started + report.requests_not_started, 50);
    // Each of the 2 places is held for 300 ms at a time, so within the
    // second of the test it can serve 4 requests at most.
    assert!((2..=8).contains(&report.requests_started), "{report:?}");
    assert_eq!(report.requests_completed, report.requests_started);
    let failures = BTreeMap::from([("timeout".to_owned(), report.requests_started)]);
    assert_eq!(report.failures, failures);
}

fn run_tool(tool: &str, args: &[&str], secret_name: &str, secret: &str) -> Output {
    let output = Command::new(tool)
        .args(args)
        .env(secret_name, secret)
        .output()
        .unwrap();
    // Whatever a tool prints, it never prints its credential.
    let printed = [output.stdout.as_slice(), output.stderr.as_slice()].concat();
    assert!(!String::from_utf8_lossy(&printed).contains(secret));
    output
}

fn run_simdevice(args: &[&str]) -> Output {
    let tool = env!("CARGO_BIN_EXE_simdevice");
    run_tool(
        tool,
        args,
        "CORONIUM_DEVICE_CREDENTIAL",
        "made-up-device-credential",
    )
}

fn run_loadgen(args: &[&str]) -> Output {
    let tool = env!("CARGO_BIN_EXE_loadgen");
    run_tool(tool, args, "CORONIUM_PROXY_AUTHORIZATION", AUTHORIZATION)
}

/// The addresses are from the documentation ranges, which stand for public
/// ones. A tool that tried them would hang or fail differently.
#[test]
fn both_tools_refuse_a_public_address() {
    for address in ["192.0.2.1:443", "[2001:db8::1]:443"] {
        let refused = [
            run_simdevice(&["--relay", address, "--devices", "3"]),
            run_loadgen(&[
                "--proxy",
                address,
                "--rate",
                "10",
                "--seconds",
                "1",
                "--nodes",
                "1",
            ]),
        ];
        for output in refused {
            assert!(!output.status.success());
            assert!(output.stdout.is_empty());
            let stderr = String::from_utf8(output.stderr).unwrap();
            let cause = format!("{address} is not a loopback or private address");
            assert!(stderr.contains(&cause), "{stderr}");
            assert!(
                stderr.contains("\nfix: use an address in 127.0.0.0/8"),
                "{stderr}"
            );
        }
    }
}

#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn the_two_tools_run_a_test_and_each_prints_one_json_document() {
    let standin = Standin::start().await;
    let relay = standin.relay.to_string();
    let simdevice = spawn_blocking(move || run_simdevice(&["--relay", &relay, "--devices", "3"]));
    timeout(WAIT, standin.devices(3))
        .await
        .expect("the devices did not connect");

    let proxy = standin.proxy.to_string();
    let args = [
        "--rate",
        "50",
        "--seconds",
        "1",
        "--nodes",
        "1",
        "--bytes",
        "0,5000",
    ];
    let loadgen = spawn_blocking(move || run_loadgen(&[&["--proxy", &proxy], &args[..]].concat()));
    let loadgen = loadgen.await.unwrap();
    assert!(
        loadgen.status.success(),
        "{}",
        String::from_utf8_lossy(&loadgen.stderr)
    );
    let report: serde_json::Value = serde_json::from_slice(&loadgen.stdout).unwrap();
    assert_eq!(report["target_rate_per_second"], 50);
    assert_eq!(report["test_length_seconds"], 1);
    assert_eq!(report["node_count"], 1);
    assert_eq!(report["requests_started"], 50);
    assert_eq!(report["requests_completed"], 50);
    assert_eq!(report["requests_ok"], 50);
    assert_eq!(report["requests_not_started"], 0);
    assert_eq!(report["hash_mismatches"], 0);
    assert_eq!(report["failures"], serde_json::json!({}));
    let (up, down) = standin.metered();
    assert_eq!(report["tunnel_bytes_written"], up);
    assert_eq!(report["tunnel_bytes_read"], down);
    for percentile in ["p50", "p90", "p99", "max"] {
        assert!(report["ok_latency_us"][percentile].is_u64(), "{percentile}");
    }
    assert!(report["hardware"]["cpu_model"].is_string());
    assert!(report["hardware"]["cpu_cores"].is_u64());
    assert!(report["hardware"]["memory_bytes"].is_u64());
    assert!(report["hardware"]["os"].is_string());

    standin.hang_up();
    let simdevice = timeout(WAIT, simdevice).await.unwrap().unwrap();
    assert!(simdevice.status.success());
    let ended: serde_json::Value = serde_json::from_slice(&simdevice.stdout).unwrap();
    let expected = serde_json::json!({
        "devices": 3,
        "ended": { "the relay closed the connection": 3 },
    });
    assert_eq!(ended, expected);
}
