//! Runs simulated devices against a relay on test hardware.

use std::collections::BTreeMap;
use std::env;
use std::num::NonZeroU32;
use std::process::ExitCode;
use std::time::Duration;

use coronium_harness::Refusal;
use coronium_harness::flags::{self, Flags};
use coronium_harness::guard::TestAddr;
use coronium_harness::simdevice::{self, Config};
use coronium_proto::frame::Credential;
use tokio::task::JoinSet;
use tokio::time::{Instant, sleep_until};

const USAGE: &str = "simdevice --relay <ip:port> [--devices <n>] [--max-streams <1 to 1024>] \
                     [--dials-per-second <n>], \
                     with the device credential in CORONIUM_DEVICE_CREDENTIAL";

#[tokio::main]
async fn main() -> ExitCode {
    match run().await {
        Ok(()) => ExitCode::SUCCESS,
        Err(refusal) => {
            eprintln!("simdevice: {refusal}");
            ExitCode::FAILURE
        }
    }
}

async fn run() -> Result<(), Refusal> {
    let known = [
        "--relay",
        "--devices",
        "--max-streams",
        "--dials-per-second",
    ];
    let flags = Flags::parse(env::args().skip(1), &known, USAGE)?;
    let relay: TestAddr = flags.required("--relay")?.parse()?;
    let devices: u32 = flags.number("--devices")?.unwrap_or(1);
    let max_streams: u16 = flags.number("--max-streams")?.unwrap_or(32);
    let dials_per_second = flags
        .number("--dials-per-second")?
        .map_or(500, NonZeroU32::get);
    let credential = Credential(flags::secret("CORONIUM_DEVICE_CREDENTIAL")?.into_bytes());

    // Devices dial at a steady pace. Dialing all at once overflows the listen
    // queue of the relay, and a large part of a large fleet never connects.
    let begin = Instant::now();
    let mut running = JoinSet::new();
    for index in 0..devices {
        sleep_until(begin + Duration::from_secs(1) * index / dials_per_second).await;
        running.spawn(simdevice::run(Config {
            relay,
            id: simdevice::device_id(index),
            max_streams,
            credential: credential.clone(),
        }));
    }
    // A device runs until the relay lets it go, so this is printed when the
    // test is over: how many devices ended, and how.
    let mut ended: BTreeMap<String, u64> = BTreeMap::new();
    while let Some(joined) = running.join_next().await {
        let how = match joined {
            Ok(Ok(end)) => end.to_string(),
            Ok(Err(error)) => error.to_string(),
            Err(_) => "the device task panicked".to_owned(),
        };
        *ended.entry(how).or_default() += 1;
    }
    println!(
        "{}",
        serde_json::json!({ "devices": devices, "ended": ended })
    );
    Ok(())
}
