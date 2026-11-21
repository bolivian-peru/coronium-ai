//! The proof harness: a simulated device and a load generator.
//!
//! Load is only ever generated against simulated devices on test hardware,
//! never against production or real devices. That is built in rather than
//! left to whoever runs the tools: [`guard`] holds the only code in this
//! crate that opens a connection, and it refuses any address that is not
//! loopback or private.
//!
//! - [`guard`]: the addresses the harness may connect to.
//! - [`payload`]: a body both ends can produce, and check by hash.
//! - [`simdevice`]: a device that plays the target of every stream itself.
//! - [`loadgen`]: an open-loop load generator against an HTTP proxy endpoint.
//! - [`flags`]: the `--name value` flags of the two tools.

pub mod flags;
pub mod guard;
mod http;
pub mod loadgen;
pub mod payload;
pub mod simdevice;

/// Why a tool would not do what it was asked, and what to do about it.
#[derive(Debug, thiserror::Error)]
#[error("{cause}\nfix: {fix}")]
pub struct Refusal {
    pub cause: String,
    pub fix: String,
}
