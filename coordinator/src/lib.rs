//! The coordinator: the only writer of usage and money.

// Usage and money are integers. A float anywhere in this crate is a bug.
#![deny(clippy::float_arithmetic)]

pub mod ledger;
