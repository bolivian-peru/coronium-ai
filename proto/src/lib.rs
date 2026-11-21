//! The Coronium wire protocol, version 1.
//!
//! The rules are in `PROTOCOL.md` next to this crate, and the vectors every
//! implementation must pass are in `vectors/`.
//!
//! - [`frame`]: the frames, their decoder and their encoder.
//! - [`session`]: the rule checker for one link.
//! - [`io`]: reading and writing frames over a byte stream.

pub mod frame;
pub mod io;
pub mod session;
