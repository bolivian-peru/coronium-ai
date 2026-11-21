//! Frames: the one type, its decoder and its encoder (PROTOCOL.md sections 2 to 5).
//!
//! [`decode`] follows section 3.1 step by step, in the order written there.
//! [`Frame::encode`] writes the single encoding a frame has, and refuses a
//! frame whose fields break a rule instead of writing bytes a decoder would
//! refuse. Both use the same field rules, so they cannot drift apart.

use std::fmt;
use std::net::{Ipv4Addr, Ipv6Addr};
use std::num::NonZeroU16;

use bytes::Bytes;

/// The protocol version this crate speaks.
pub const VERSION: u8 = 1;
/// The size of the header in front of every payload.
pub const HEADER_LEN: usize = 8;
/// The longest payload a frame may carry.
pub const MAX_PAYLOAD: usize = 16384;
/// The longest frame: no buffer ever needs to be larger than this.
pub const MAX_FRAME_LEN: usize = HEADER_LEN + MAX_PAYLOAD;
/// The most credit one direction of a stream may hold, and the largest WINDOW.
pub const MAX_CREDIT: u32 = 2_147_483_647;

/// A device id or an edge node id: 16 opaque bytes.
pub type Id = [u8; 16];

/// A connection error (section 8.1). It ends the connection: the side that
/// detects it sends GOAWAY `protocol_error` with a cause that starts with
/// this error's name, which is what `Display` prints.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
pub enum ConnectionError {
    #[error("unknown_frame")]
    UnknownFrame,
    #[error("bad_flags")]
    BadFlags,
    #[error("frame_too_large")]
    FrameTooLarge,
    #[error("bad_stream_id")]
    BadStreamId,
    #[error("bad_payload")]
    BadPayload,
    #[error("unexpected_frame")]
    UnexpectedFrame,
}

/// A frame value that breaks a field rule, so it has no encoding. This is a
/// fault in the code that built the frame, never something a peer sent.
#[derive(Debug, Clone, Copy, PartialEq, Eq, thiserror::Error)]
#[error("the frame cannot be encoded: {0}")]
pub struct InvalidFrame(&'static str);

/// Defines one of the three open code tables of section 8. A code is any
/// non-zero `u16`, so a code this version does not name still decodes, is
/// forwarded and compares equal to itself.
macro_rules! code_table {
    ($(#[$doc:meta])* $table:ident { $($value:literal $constant:ident $name:literal)* }) => {
        $(#[$doc])*
        #[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
        pub struct $table(NonZeroU16);

        impl $table {
            $(pub const $constant: Self = Self(NonZeroU16::new($value).unwrap());)*

            /// Any non-zero number is a code. Zero is not.
            pub const fn new(code: u16) -> Option<Self> {
                match NonZeroU16::new(code) {
                    Some(code) => Some(Self(code)),
                    None => None,
                }
            }

            /// The number on the wire.
            pub const fn get(self) -> u16 {
                self.0.get()
            }

            /// The name in PROTOCOL.md, when this version defines the code.
            pub const fn name(self) -> Option<&'static str> {
                match self.0.get() {
                    $($value => Some($name),)*
                    _ => None,
                }
            }
        }

        /// The name, or the number for a code this version does not define.
        impl fmt::Display for $table {
            fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
                match self.name() {
                    Some(name) => f.write_str(name),
                    None => write!(f, "{}", self.get()),
                }
            }
        }
    };
}

code_table! {
    /// Why a stream was reset (section 8.2).
    ResetCode {
        1 CONNECT_REFUSED "connect_refused"
        2 CONNECT_TIMEOUT "connect_timeout"
        3 DNS_FAILED "dns_failed"
        4 UNREACHABLE "unreachable"
        5 TARGET_BLOCKED "target_blocked"
        6 TOO_MANY_STREAMS "too_many_streams"
        7 FLOW_CONTROL "flow_control"
        8 PROTOCOL "protocol"
        9 CANCELLED "cancelled"
        10 GOING_AWAY "going_away"
        11 DEVICE_GONE "device_gone"
        12 NO_DEVICE "no_device"
        13 IO "io"
    }
}

code_table! {
    /// Why the relay refused a connection (section 8.3).
    RefuseCode {
        1 UNSUPPORTED_VERSION "unsupported_version"
        2 BAD_CREDENTIAL "bad_credential"
        3 UNKNOWN_ID "unknown_id"
        4 WRONG_ROLE "wrong_role"
        5 BUSY "busy"
    }
}

code_table! {
    /// Why a side is leaving (section 8.4).
    GoAwayCode {
        1 DRAINING "draining"
        2 PROTOCOL_ERROR "protocol_error"
        3 IDLE_TIMEOUT "idle_timeout"
        4 REPLACED "replaced"
        5 SHUTTING_DOWN "shutting_down"
    }
}

/// What a dialer proves itself with in HELLO. It is a secret, so `Debug`
/// prints its length and never its bytes, and a frame can be logged as it is.
#[derive(Clone, PartialEq, Eq)]
pub struct Credential(pub Vec<u8>);

impl fmt::Debug for Credential {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "Credential({} bytes)", self.0.len())
    }
}

/// What the dialer says it is in HELLO.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Role {
    Device,
    Edge,
}

/// Where OPEN asks the device to connect.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Target {
    /// A host name, lower case, which the device resolves on its own network.
    Name(String),
    Ipv4(Ipv4Addr),
    Ipv6(Ipv6Addr),
}

/// One frame of any of the twelve types. Fields carry the names PROTOCOL.md
/// gives them. Connection frames have no `stream`: theirs is always zero.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum Frame {
    Hello {
        version_min: u8,
        version_max: u8,
        role: Role,
        id: Id,
        max_streams: u16,
        credential: Credential,
        software: String,
    },
    Welcome {
        version: u8,
        keepalive_ms: u32,
        initial_window: u32,
    },
    Refuse {
        code: RefuseCode,
        retry_after_ms: u32,
        cause: String,
        fix: String,
    },
    Ping {
        payload: [u8; 8],
    },
    Pong {
        payload: [u8; 8],
    },
    GoAway {
        code: GoAwayCode,
        reconnect_after_ms: u32,
        cause: String,
    },
    Open {
        stream: u32,
        device: Id,
        target: Target,
        port: u16,
    },
    Opened {
        stream: u32,
    },
    Data {
        stream: u32,
        payload: Bytes,
    },
    Window {
        stream: u32,
        credit: u32,
    },
    End {
        stream: u32,
    },
    Reset {
        stream: u32,
        code: ResetCode,
    },
}

/// The type byte of each frame.
#[derive(Clone, Copy)]
enum Kind {
    Hello = 0x01,
    Welcome = 0x02,
    Refuse = 0x03,
    Ping = 0x04,
    Pong = 0x05,
    GoAway = 0x06,
    Open = 0x10,
    Opened = 0x11,
    Data = 0x12,
    Window = 0x13,
    End = 0x14,
    Reset = 0x15,
}

impl Kind {
    fn from_wire(byte: u8) -> Option<Self> {
        Some(match byte {
            0x01 => Self::Hello,
            0x02 => Self::Welcome,
            0x03 => Self::Refuse,
            0x04 => Self::Ping,
            0x05 => Self::Pong,
            0x06 => Self::GoAway,
            0x10 => Self::Open,
            0x11 => Self::Opened,
            0x12 => Self::Data,
            0x13 => Self::Window,
            0x14 => Self::End,
            0x15 => Self::Reset,
            _ => return None,
        })
    }

    fn is_stream(self) -> bool {
        self as u8 >= Self::Open as u8
    }
}

/// A header that passed steps 2 to 5 of section 3.1.
struct Header {
    kind: Kind,
    stream: u32,
    length: usize,
}

/// Steps 1 to 5 of section 3.1. `None` means fewer than 8 bytes have arrived.
fn read_header(bytes: &[u8]) -> Result<Option<Header>, ConnectionError> {
    let Some(&[kind, flags, s0, s1, s2, s3, l0, l1]) = bytes.first_chunk::<HEADER_LEN>() else {
        return Ok(None);
    };
    let kind = Kind::from_wire(kind).ok_or(ConnectionError::UnknownFrame)?;
    if flags != 0 {
        return Err(ConnectionError::BadFlags);
    }
    let length = usize::from(u16::from_be_bytes([l0, l1]));
    if length > MAX_PAYLOAD {
        return Err(ConnectionError::FrameTooLarge);
    }
    let stream = u32::from_be_bytes([s0, s1, s2, s3]);
    if (stream != 0) != kind.is_stream() {
        return Err(ConnectionError::BadStreamId);
    }
    Ok(Some(Header {
        kind,
        stream,
        length,
    }))
}

/// What the bytes received so far amount to, short of an error.
pub(crate) enum Progress {
    /// A whole frame, and the number of bytes it used.
    Frame(Frame, usize),
    /// Not a whole frame yet. The frame needs this many bytes in all, as far
    /// as the bytes so far can tell: the header first, then header and payload.
    Wants(usize),
}

/// Section 3.1 with the size of the missing part kept, so that a reader knows
/// how much to buffer and never buffers a payload whose header was refused.
pub(crate) fn progress(bytes: &[u8]) -> Result<Progress, ConnectionError> {
    let Some(header) = read_header(bytes)? else {
        return Ok(Progress::Wants(HEADER_LEN));
    };
    let used = HEADER_LEN + header.length;
    let Some(payload) = bytes.get(HEADER_LEN..used) else {
        return Ok(Progress::Wants(used));
    };
    let frame = read_payload(&header, payload).ok_or(ConnectionError::BadPayload)?;
    Ok(Progress::Frame(frame, used))
}

/// Decodes the frame at the start of `bytes`, the bytes received so far.
///
/// - `Ok(Some((frame, used)))`: a frame, and how many bytes it used.
/// - `Ok(None)`: incomplete. More bytes are needed and nothing is wrong yet.
/// - `Err(error)`: a connection error.
pub fn decode(bytes: &[u8]) -> Result<Option<(Frame, usize)>, ConnectionError> {
    Ok(match progress(bytes)? {
        Progress::Frame(frame, used) => Some((frame, used)),
        Progress::Wants(_) => None,
    })
}

/// Reads the fields of one payload from front to back.
struct Fields<'a>(&'a [u8]);

impl<'a> Fields<'a> {
    fn rest(&mut self) -> &'a [u8] {
        std::mem::take(&mut self.0)
    }

    fn take(&mut self, count: usize) -> Option<&'a [u8]> {
        let (head, rest) = self.0.split_at_checked(count)?;
        self.0 = rest;
        Some(head)
    }

    fn array<const N: usize>(&mut self) -> Option<[u8; N]> {
        let (head, rest) = self.0.split_first_chunk()?;
        self.0 = rest;
        Some(*head)
    }

    fn u8(&mut self) -> Option<u8> {
        self.array().map(u8::from_be_bytes)
    }

    fn u16(&mut self) -> Option<u16> {
        self.array().map(u16::from_be_bytes)
    }

    fn u32(&mut self) -> Option<u32> {
        self.array().map(u32::from_be_bytes)
    }

    fn bytes8(&mut self) -> Option<&'a [u8]> {
        let length = self.u8()?;
        self.take(usize::from(length))
    }

    fn text8(&mut self) -> Option<String> {
        let text = str::from_utf8(self.bytes8()?).ok()?;
        Some(text.to_owned())
    }
}

/// Step 7 of section 3.1. `None` means the payload does not match its layout.
fn read_payload(header: &Header, payload: &[u8]) -> Option<Frame> {
    let stream = header.stream;
    let mut fields = Fields(payload);
    let frame = match header.kind {
        Kind::Hello => Frame::Hello {
            version_min: fields.u8()?,
            version_max: fields.u8()?,
            role: match fields.u8()? {
                1 => Role::Device,
                2 => Role::Edge,
                _ => return None,
            },
            id: fields.array()?,
            max_streams: fields.u16()?,
            credential: Credential(fields.bytes8()?.to_vec()),
            software: fields.text8()?,
        },
        Kind::Welcome => Frame::Welcome {
            version: fields.u8()?,
            keepalive_ms: fields.u32()?,
            initial_window: fields.u32()?,
        },
        Kind::Refuse => Frame::Refuse {
            code: RefuseCode::new(fields.u16()?)?,
            retry_after_ms: fields.u32()?,
            cause: fields.text8()?,
            fix: fields.text8()?,
        },
        Kind::Ping => Frame::Ping {
            payload: fields.array()?,
        },
        Kind::Pong => Frame::Pong {
            payload: fields.array()?,
        },
        Kind::GoAway => Frame::GoAway {
            code: GoAwayCode::new(fields.u16()?)?,
            reconnect_after_ms: fields.u32()?,
            cause: fields.text8()?,
        },
        Kind::Open => Frame::Open {
            stream,
            device: fields.array()?,
            target: match fields.u8()? {
                1 => Target::Name(fields.text8()?),
                2 => Target::Ipv4(Ipv4Addr::from(fields.array::<4>()?)),
                3 => Target::Ipv6(Ipv6Addr::from(fields.array::<16>()?)),
                _ => return None,
            },
            port: fields.u16()?,
        },
        Kind::Opened => Frame::Opened { stream },
        Kind::Data => Frame::Data {
            stream,
            payload: Bytes::copy_from_slice(fields.rest()),
        },
        Kind::Window => Frame::Window {
            stream,
            credit: fields.u32()?,
        },
        Kind::End => Frame::End { stream },
        Kind::Reset => Frame::Reset {
            stream,
            code: ResetCode::new(fields.u16()?)?,
        },
    };
    // Bytes left over would be a second encoding of the same frame, and every
    // frame has exactly one.
    let exact = fields.0.is_empty() && frame.validate().is_ok();
    exact.then_some(frame)
}

fn require(holds: bool, rule: &'static str) -> Result<(), InvalidFrame> {
    if holds {
        Ok(())
    } else {
        Err(InvalidFrame(rule))
    }
}

/// `text8`: no code point below U+0020 and not U+007F. Each of those is one
/// byte in UTF-8, so looking at bytes is enough.
fn is_text(text: &str, min_len: usize) -> bool {
    (min_len..=255).contains(&text.len()) && text.bytes().all(|byte| byte >= 0x20 && byte != 0x7f)
}

fn is_label(label: &str) -> bool {
    (1..=63).contains(&label.len())
        && label
            .bytes()
            .all(|byte| matches!(byte, b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_'))
}

fn is_all_digits(label: &str) -> bool {
    label.bytes().all(|byte| byte.is_ascii_digit())
}

/// The name rules of section 5.1. A leading dot, a trailing dot and two dots
/// in a row all show up as an empty label.
fn is_name(name: &str) -> bool {
    name.len() <= 253
        && name.split('.').all(is_label)
        && !name.rsplit('.').next().is_some_and(is_all_digits)
}

/// Writes a `bytes8`. `validate` has already kept the length within one byte.
fn put_bytes8(out: &mut Vec<u8>, bytes: &[u8]) {
    let length = u8::try_from(bytes.len()).expect("validate bounds every bytes8");
    out.push(length);
    out.extend_from_slice(bytes);
}

impl Frame {
    /// The stream this frame belongs to, or zero for a connection frame.
    pub fn stream(&self) -> u32 {
        match self {
            Self::Hello { .. }
            | Self::Welcome { .. }
            | Self::Refuse { .. }
            | Self::Ping { .. }
            | Self::Pong { .. }
            | Self::GoAway { .. } => 0,
            Self::Open { stream, .. }
            | Self::Opened { stream }
            | Self::Data { stream, .. }
            | Self::Window { stream, .. }
            | Self::End { stream }
            | Self::Reset { stream, .. } => *stream,
        }
    }

    fn kind(&self) -> Kind {
        match self {
            Self::Hello { .. } => Kind::Hello,
            Self::Welcome { .. } => Kind::Welcome,
            Self::Refuse { .. } => Kind::Refuse,
            Self::Ping { .. } => Kind::Ping,
            Self::Pong { .. } => Kind::Pong,
            Self::GoAway { .. } => Kind::GoAway,
            Self::Open { .. } => Kind::Open,
            Self::Opened { .. } => Kind::Opened,
            Self::Data { .. } => Kind::Data,
            Self::Window { .. } => Kind::Window,
            Self::End { .. } => Kind::End,
            Self::Reset { .. } => Kind::Reset,
        }
    }

    /// The rules of sections 3 to 5 that the field types do not already hold.
    /// The decoder and the encoder both go through here, which is what makes
    /// "the encoder emits it" and "the decoder accepts it" the same set.
    fn validate(&self) -> Result<(), InvalidFrame> {
        if self.kind().is_stream() {
            require(
                self.stream() != 0,
                "a stream frame needs a non-zero stream id",
            )?;
        }
        match self {
            Self::Hello {
                version_min,
                version_max,
                role,
                max_streams,
                credential,
                software,
                ..
            } => {
                require(*version_min >= 1, "version_min must be at least 1")?;
                require(
                    version_max >= version_min,
                    "version_max is below version_min",
                )?;
                let streams_fit = match role {
                    Role::Device => (1..=1024).contains(max_streams),
                    Role::Edge => *max_streams == 0,
                };
                require(
                    streams_fit,
                    "max_streams must be 1 to 1024 for a device and 0 for an edge",
                )?;
                require(
                    (1..=255).contains(&credential.0.len()),
                    "credential must be 1 to 255 bytes",
                )?;
                let printable = software.bytes().all(|byte| (0x20..=0x7e).contains(&byte));
                require(
                    software.len() <= 64 && printable,
                    "software must be 0 to 64 bytes of printable ASCII",
                )
            }
            Self::Welcome {
                version,
                keepalive_ms,
                initial_window,
            } => {
                require(*version >= 1, "version must be at least 1")?;
                require(
                    (1000..=600_000).contains(keepalive_ms),
                    "keepalive_ms must be 1000 to 600000",
                )?;
                require(
                    (16384..=1_048_576).contains(initial_window),
                    "initial_window must be 16384 to 1048576",
                )
            }
            Self::Refuse { cause, fix, .. } => {
                require(is_text(cause, 1), "cause must be 1 to 255 bytes of text")?;
                require(is_text(fix, 1), "fix must be 1 to 255 bytes of text")
            }
            Self::GoAway { cause, .. } => {
                require(is_text(cause, 0), "cause must be 0 to 255 bytes of text")
            }
            Self::Open { target, port, .. } => {
                if let Target::Name(name) = target {
                    require(is_name(name), "the target is not a name section 5.1 allows")?;
                }
                require(*port != 0, "port must not be zero")
            }
            Self::Data { payload, .. } => require(
                (1..=MAX_PAYLOAD).contains(&payload.len()),
                "DATA must carry 1 to 16384 bytes",
            ),
            Self::Window { credit, .. } => require(
                (1..=MAX_CREDIT).contains(credit),
                "credit must be 1 to 2147483647",
            ),
            Self::Ping { .. }
            | Self::Pong { .. }
            | Self::Opened { .. }
            | Self::End { .. }
            | Self::Reset { .. } => Ok(()),
        }
    }

    /// Appends this frame's one encoding to `out`. A frame that breaks a
    /// field rule is refused and `out` is left as it was, so nothing a decoder
    /// would refuse can reach the wire.
    pub fn encode(&self, out: &mut Vec<u8>) -> Result<(), InvalidFrame> {
        self.validate()?;
        let start = out.len();
        out.extend_from_slice(&[self.kind() as u8, 0]);
        out.extend_from_slice(&self.stream().to_be_bytes());
        // The length is filled in below, once the payload is written.
        out.extend_from_slice(&[0, 0]);
        match self {
            Self::Hello {
                version_min,
                version_max,
                role,
                id,
                max_streams,
                credential,
                software,
            } => {
                let role = match role {
                    Role::Device => 1,
                    Role::Edge => 2,
                };
                out.extend_from_slice(&[*version_min, *version_max, role]);
                out.extend_from_slice(id);
                out.extend_from_slice(&max_streams.to_be_bytes());
                put_bytes8(out, &credential.0);
                put_bytes8(out, software.as_bytes());
            }
            Self::Welcome {
                version,
                keepalive_ms,
                initial_window,
            } => {
                out.push(*version);
                out.extend_from_slice(&keepalive_ms.to_be_bytes());
                out.extend_from_slice(&initial_window.to_be_bytes());
            }
            Self::Refuse {
                code,
                retry_after_ms,
                cause,
                fix,
            } => {
                out.extend_from_slice(&code.get().to_be_bytes());
                out.extend_from_slice(&retry_after_ms.to_be_bytes());
                put_bytes8(out, cause.as_bytes());
                put_bytes8(out, fix.as_bytes());
            }
            Self::Ping { payload } | Self::Pong { payload } => out.extend_from_slice(payload),
            Self::GoAway {
                code,
                reconnect_after_ms,
                cause,
            } => {
                out.extend_from_slice(&code.get().to_be_bytes());
                out.extend_from_slice(&reconnect_after_ms.to_be_bytes());
                put_bytes8(out, cause.as_bytes());
            }
            Self::Open {
                device,
                target,
                port,
                ..
            } => {
                out.extend_from_slice(device);
                match target {
                    Target::Name(name) => {
                        out.push(1);
                        put_bytes8(out, name.as_bytes());
                    }
                    Target::Ipv4(address) => {
                        out.push(2);
                        out.extend_from_slice(&address.octets());
                    }
                    Target::Ipv6(address) => {
                        out.push(3);
                        out.extend_from_slice(&address.octets());
                    }
                }
                out.extend_from_slice(&port.to_be_bytes());
            }
            Self::Opened { .. } | Self::End { .. } => {}
            Self::Data { payload, .. } => out.extend_from_slice(payload),
            Self::Window { credit, .. } => out.extend_from_slice(&credit.to_be_bytes()),
            Self::Reset { code, .. } => out.extend_from_slice(&code.get().to_be_bytes()),
        }
        let length =
            u16::try_from(out.len() - start - HEADER_LEN).expect("validate bounds every payload");
        out[start + 6..start + HEADER_LEN].copy_from_slice(&length.to_be_bytes());
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Frames end up in logs and in test failures. The credential must not.
    #[test]
    fn debug_output_leaves_the_credential_out() {
        let hello = Frame::Hello {
            version_min: 1,
            version_max: 1,
            role: Role::Device,
            id: [0; 16],
            max_streams: 1,
            credential: Credential(b"zzzz".to_vec()),
            software: String::new(),
        };
        let printed = format!("{hello:?}");
        assert!(printed.contains("Credential(4 bytes)"), "{printed}");
        assert!(
            !printed.contains("zzzz") && !printed.contains("122"),
            "{printed}"
        );
    }

    #[test]
    fn a_code_has_its_name_or_its_number() {
        assert_eq!(ResetCode::TARGET_BLOCKED.get(), 5);
        assert_eq!(ResetCode::new(5), Some(ResetCode::TARGET_BLOCKED));
        assert_eq!(ResetCode::TARGET_BLOCKED.to_string(), "target_blocked");
        assert_eq!(RefuseCode::BUSY.name(), Some("busy"));
        assert_eq!(GoAwayCode::SHUTTING_DOWN.name(), Some("shutting_down"));
        // The tables are open: an unnamed code is still a code, and zero never is.
        let unnamed = ResetCode::new(14).unwrap();
        assert_eq!(
            (unnamed.name(), unnamed.to_string()),
            (None, "14".to_owned())
        );
        assert_eq!(ResetCode::new(0), None);
    }
}
