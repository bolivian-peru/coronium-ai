//! Runs the load generator against a proxy endpoint on test hardware and
//! prints one JSON report.

use std::env;
use std::process::ExitCode;
use std::time::Duration;

use coronium_harness::Refusal;
use coronium_harness::flags::{self, Flags};
use coronium_harness::loadgen::{self, Authorization, Config};

const USAGE: &str = "loadgen --proxy <ip:port> --rate <requests per second> --seconds <n> \
                     --nodes <nodes of the system under test> [--bytes <n>[,<n>...]] \
                     [--max-in-flight <n>] [--timeout-ms <n>], \
                     with the Proxy-Authorization value in CORONIUM_PROXY_AUTHORIZATION";

#[tokio::main]
async fn main() -> ExitCode {
    match run().await {
        Ok(()) => ExitCode::SUCCESS,
        Err(refusal) => {
            eprintln!("loadgen: {refusal}");
            ExitCode::FAILURE
        }
    }
}

async fn run() -> Result<(), Refusal> {
    let known = [
        "--proxy",
        "--rate",
        "--seconds",
        "--nodes",
        "--bytes",
        "--max-in-flight",
        "--timeout-ms",
    ];
    let flags = Flags::parse(env::args().skip(1), &known, USAGE)?;
    let config = Config {
        proxy: flags.required("--proxy")?.parse()?,
        rate: flags.required_number("--rate")?,
        seconds: flags.required_number("--seconds")?,
        nodes: flags.required_number("--nodes")?,
        body_bytes: flags.numbers("--bytes")?.unwrap_or_else(|| vec![1024]),
        max_in_flight: flags.number("--max-in-flight")?.unwrap_or(1024),
        timeout: Duration::from_millis(flags.number("--timeout-ms")?.unwrap_or(30_000)),
        authorization: Authorization::new(flags::secret("CORONIUM_PROXY_AUTHORIZATION")?)?,
    };
    let report = loadgen::run(config).await?;
    let json = serde_json::to_string_pretty(&report).expect("a report is plain data");
    println!("{json}");
    Ok(())
}
