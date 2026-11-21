//! The rule checker for one link (PROTOCOL.md sections 6 and 7).
//!
//! A [`Session`] is fed every frame that crosses one connection, in order,
//! with the side that sent it, and answers with a [`Verdict`]. It checks
//! rules only: the timers of section 6.1 and the dialing of section 6.2
//! belong to whoever owns the connection.
//!
//! It keeps a few bytes for each open stream and nothing for a closed one,
//! which is all section 7 rule 6 needs. An edge link has no stream limit in
//! the protocol, so on that link the owner must bound the streams itself.
//!
//! PROTOCOL.md gives no order for a frame that breaks two rules at once.
//! Here the rules apply in the order they are numbered: section 6 before
//! section 7, and a lower rule before a higher one.

use std::collections::HashMap;
use std::fmt;
use std::mem;
use std::ops::RangeInclusive;

use crate::frame::{ConnectionError, Frame, MAX_CREDIT, ResetCode};

/// Which of the two links a connection is (section 1).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Link {
    /// An agent dialed a relay. The relay opens streams.
    Device,
    /// An edge dialed a relay. The edge opens streams.
    Edge,
}

/// The two ends of a connection.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Side {
    Dialer,
    Relay,
}

impl Side {
    fn other(self) -> Self {
        match self {
            Self::Dialer => Self::Relay,
            Self::Relay => Self::Dialer,
        }
    }

    /// The place of this side in the per-side arrays below.
    fn index(self) -> usize {
        self as usize
    }
}

/// What the rules say about one frame. `Display` prints it the way
/// `vectors/sessions.json` writes it.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Verdict {
    /// The frame is allowed.
    Ok,
    /// The frame is for a closed stream. Drop it and carry on.
    Ignored,
    /// The connection is over. No later frame will be accepted.
    ConnectionError(ConnectionError),
    /// The stream is over, with this RESET code, and the connection stays up.
    StreamError(ResetCode),
}

impl fmt::Display for Verdict {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Ok => f.write_str("ok"),
            Self::Ignored => f.write_str("ignored"),
            Self::ConnectionError(error) => write!(f, "connection_error:{error}"),
            Self::StreamError(code) => write!(f, "stream_error:{code}"),
        }
    }
}

const UNEXPECTED: Verdict = Verdict::ConnectionError(ConnectionError::UnexpectedFrame);

#[derive(Debug)]
enum Phase {
    /// Nothing has been sent yet.
    AwaitHello,
    /// HELLO was sent. Its version range is kept to judge WELCOME.
    AwaitAnswer { version_min: u8, version_max: u8 },
    /// WELCOME was sent.
    Established,
    /// REFUSE was sent or a connection error was found. Nothing may follow.
    Closed,
}

/// What a stream frame other than OPEN does to its stream.
enum Event {
    Opened,
    Data(usize),
    Window(u32),
    End,
    Reset,
}

/// One open stream. The arrays are indexed by [`Side::index`].
#[derive(Debug)]
struct Stream {
    /// The DATA bytes each side may still send.
    credit: [u32; 2],
    /// Which sides have sent END.
    ended: [bool; 2],
    /// Whether the acceptor has sent OPENED.
    opened: bool,
}

impl Stream {
    /// Applies section 7 rules 2 to 5. `Ok(true)` means the frame closed the
    /// stream, and `Err` is a stream error, which closes it too.
    fn apply(&mut self, from: Side, from_acceptor: bool, event: Event) -> Result<bool, ResetCode> {
        let sender = from.index();
        let receiver = from.other().index();
        // Rule 2: before OPENED the acceptor may only send OPENED or RESET.
        let must_wait = matches!(event, Event::Data(_) | Event::Window(_) | Event::End);
        if from_acceptor && !self.opened && must_wait {
            return Err(ResetCode::PROTOCOL);
        }
        match event {
            Event::Opened => {
                if self.opened {
                    return Err(ResetCode::PROTOCOL);
                }
                self.opened = true;
            }
            Event::Data(size) => {
                let left = u32::try_from(size)
                    .ok()
                    .and_then(|size| self.credit[sender].checked_sub(size))
                    .ok_or(ResetCode::FLOW_CONTROL)?;
                if self.ended[sender] {
                    return Err(ResetCode::PROTOCOL);
                }
                self.credit[sender] = left;
            }
            Event::Window(credit) => {
                self.credit[receiver] = self.credit[receiver]
                    .checked_add(credit)
                    .filter(|lifted| *lifted <= MAX_CREDIT)
                    .ok_or(ResetCode::FLOW_CONTROL)?;
            }
            Event::End => {
                if mem::replace(&mut self.ended[sender], true) {
                    return Err(ResetCode::PROTOCOL);
                }
                return Ok(self.ended[receiver]);
            }
            Event::Reset => return Ok(true),
        }
        Ok(false)
    }
}

/// The state of one connection, as far as the rules need it.
#[derive(Debug)]
pub struct Session {
    link: Link,
    phase: Phase,
    /// From HELLO.
    max_streams: u16,
    /// From WELCOME.
    initial_window: u32,
    /// The PING each side is still waiting on, indexed by [`Side::index`].
    ping: [Option<[u8; 8]>; 2],
    /// Which sides have sent GOAWAY.
    goaway: [bool; 2],
    /// The highest stream id any OPEN has used. Zero before the first OPEN.
    highest_open: u32,
    streams: HashMap<u32, Stream>,
}

impl Session {
    pub fn new(link: Link) -> Self {
        Self {
            link,
            phase: Phase::AwaitHello,
            max_streams: 0,
            initial_window: 0,
            ping: [None; 2],
            goaway: [false; 2],
            highest_open: 0,
            streams: HashMap::new(),
        }
    }

    /// Judges the next frame on the connection, sent by `from`.
    pub fn check(&mut self, from: Side, frame: &Frame) -> Verdict {
        let verdict = match self.phase {
            Phase::AwaitHello => self.first_frame(from, frame),
            Phase::AwaitAnswer {
                version_min,
                version_max,
            } => self.answer(from, frame, version_min..=version_max),
            Phase::Established => self.established(from, frame),
            Phase::Closed => UNEXPECTED,
        };
        if let Verdict::ConnectionError(_) = verdict {
            self.phase = Phase::Closed;
        }
        verdict
    }

    fn opener(&self) -> Side {
        match self.link {
            Link::Device => Side::Relay,
            Link::Edge => Side::Dialer,
        }
    }

    /// Section 6 rule 1.
    fn first_frame(&mut self, from: Side, frame: &Frame) -> Verdict {
        let Frame::Hello {
            version_min,
            version_max,
            max_streams,
            ..
        } = frame
        else {
            return UNEXPECTED;
        };
        if from != Side::Dialer {
            return UNEXPECTED;
        }
        self.max_streams = *max_streams;
        self.phase = Phase::AwaitAnswer {
            version_min: *version_min,
            version_max: *version_max,
        };
        Verdict::Ok
    }

    /// Section 6 rules 2 to 4.
    fn answer(&mut self, from: Side, frame: &Frame, versions: RangeInclusive<u8>) -> Verdict {
        if from != Side::Relay {
            return UNEXPECTED;
        }
        match frame {
            Frame::Welcome {
                version,
                initial_window,
                ..
            } if versions.contains(version) => {
                self.initial_window = *initial_window;
                self.phase = Phase::Established;
                Verdict::Ok
            }
            Frame::Refuse { .. } => {
                self.phase = Phase::Closed;
                Verdict::Ok
            }
            _ => UNEXPECTED,
        }
    }

    /// Everything after WELCOME.
    fn established(&mut self, from: Side, frame: &Frame) -> Verdict {
        match frame {
            Frame::Hello { .. } | Frame::Welcome { .. } | Frame::Refuse { .. } => UNEXPECTED,
            Frame::Ping { payload } => {
                let outstanding = &mut self.ping[from.index()];
                if outstanding.is_some() {
                    return UNEXPECTED;
                }
                *outstanding = Some(*payload);
                Verdict::Ok
            }
            Frame::Pong { payload } => {
                let outstanding = &mut self.ping[from.other().index()];
                if *outstanding != Some(*payload) {
                    return UNEXPECTED;
                }
                *outstanding = None;
                Verdict::Ok
            }
            Frame::GoAway { .. } => {
                if mem::replace(&mut self.goaway[from.index()], true) {
                    return UNEXPECTED;
                }
                Verdict::Ok
            }
            Frame::Open { stream, .. } => self.open(from, *stream),
            Frame::Opened { stream } => self.on_stream(from, *stream, Event::Opened),
            Frame::Data { stream, payload } => {
                self.on_stream(from, *stream, Event::Data(payload.len()))
            }
            Frame::Window { stream, credit } => {
                self.on_stream(from, *stream, Event::Window(*credit))
            }
            Frame::End { stream } => self.on_stream(from, *stream, Event::End),
            Frame::Reset { stream, .. } => self.on_stream(from, *stream, Event::Reset),
        }
    }

    /// OPEN: section 6 rules 6 to 8, then section 7 rules 7 and 8.
    fn open(&mut self, from: Side, stream: u32) -> Verdict {
        if from != self.opener() || self.goaway[from.index()] {
            return UNEXPECTED;
        }
        if stream <= self.highest_open {
            return Verdict::ConnectionError(ConnectionError::BadStreamId);
        }
        // An OPEN that ends in a stream error has still used its id: the
        // stream is closed, and a later frame for it is ignored.
        self.highest_open = stream;
        if self.link == Link::Device {
            if self.streams.len() >= usize::from(self.max_streams) {
                return Verdict::StreamError(ResetCode::TOO_MANY_STREAMS);
            }
            // The device is the dialer of its link.
            if self.goaway[Side::Dialer.index()] {
                return Verdict::StreamError(ResetCode::GOING_AWAY);
            }
        }
        let stream_state = Stream {
            credit: [self.initial_window; 2],
            ended: [false; 2],
            opened: false,
        };
        self.streams.insert(stream, stream_state);
        Verdict::Ok
    }

    /// A stream frame other than OPEN: section 6 rules 7 and 8, then section 7.
    fn on_stream(&mut self, from: Side, id: u32, event: Event) -> Verdict {
        let from_acceptor = from != self.opener();
        if matches!(event, Event::Opened) && !from_acceptor {
            return UNEXPECTED;
        }
        if id > self.highest_open {
            return Verdict::ConnectionError(ConnectionError::BadStreamId);
        }
        // Not open and not above the highest OPEN: the stream is closed.
        let Some(stream) = self.streams.get_mut(&id) else {
            return Verdict::Ignored;
        };
        let (closed, verdict) = match stream.apply(from, from_acceptor, event) {
            Ok(closed) => (closed, Verdict::Ok),
            Err(code) => (true, Verdict::StreamError(code)),
        };
        if closed {
            self.streams.remove(&id);
        }
        verdict
    }
}

#[cfg(test)]
mod tests {
    use bytes::Bytes;

    use super::*;
    use crate::frame::{Credential, Role, Target};

    fn established(link: Link) -> Session {
        let mut session = Session::new(link);
        let (role, max_streams) = match link {
            Link::Device => (Role::Device, 1024),
            Link::Edge => (Role::Edge, 0),
        };
        let hello = Frame::Hello {
            version_min: 1,
            version_max: 1,
            role,
            id: [7; 16],
            max_streams,
            credential: Credential(vec![1]),
            software: String::new(),
        };
        let welcome = Frame::Welcome {
            version: 1,
            keepalive_ms: 25_000,
            initial_window: 16384,
        };
        assert_eq!(session.check(Side::Dialer, &hello), Verdict::Ok);
        assert_eq!(session.check(Side::Relay, &welcome), Verdict::Ok);
        session
    }

    fn open(stream: u32) -> Frame {
        Frame::Open {
            stream,
            device: [7; 16],
            target: Target::Name("example.com".to_owned()),
            port: 443,
        }
    }

    /// Every way a stream can close must also drop its state, or a peer that
    /// opens and closes streams for long enough would exhaust memory.
    #[test]
    fn a_closed_stream_leaves_nothing_behind() {
        for link in [Link::Device, Link::Edge] {
            let mut session = established(link);
            let opener = session.opener();
            let acceptor = opener.other();
            let mut stream = 0;
            for round in 0..1000 {
                // Both sides send END.
                stream += 1;
                assert_eq!(session.check(opener, &open(stream)), Verdict::Ok);
                assert_eq!(
                    session.check(acceptor, &Frame::Opened { stream }),
                    Verdict::Ok
                );
                assert_eq!(session.check(opener, &Frame::End { stream }), Verdict::Ok);
                assert_eq!(session.check(acceptor, &Frame::End { stream }), Verdict::Ok);
                // One side sends RESET.
                stream += 1;
                let reset = Frame::Reset {
                    stream,
                    code: ResetCode::CANCELLED,
                };
                assert_eq!(session.check(opener, &open(stream)), Verdict::Ok);
                assert_eq!(session.check(acceptor, &reset), Verdict::Ok);
                // A stream error.
                stream += 1;
                let early = Frame::Data {
                    stream,
                    payload: Bytes::from_static(b"early"),
                };
                assert_eq!(session.check(opener, &open(stream)), Verdict::Ok);
                assert_eq!(
                    session.check(acceptor, &early),
                    Verdict::StreamError(ResetCode::PROTOCOL)
                );
                assert!(session.streams.is_empty(), "round {round}");
            }
            assert_eq!(
                session.check(acceptor, &Frame::End { stream: 1 }),
                Verdict::Ignored
            );
        }
    }

    /// The vectors end a session at its first connection error. A caller that
    /// keeps feeding frames anyway must not find the connection alive again.
    #[test]
    fn nothing_is_accepted_after_a_connection_error() {
        let mut session = established(Link::Device);
        let ping = Frame::Ping { payload: [0; 8] };
        assert_eq!(session.check(Side::Dialer, &Frame::Opened { stream: 1 }), {
            Verdict::ConnectionError(ConnectionError::BadStreamId)
        });
        assert_eq!(session.check(Side::Dialer, &ping), UNEXPECTED);
        assert_eq!(session.check(Side::Relay, &ping), UNEXPECTED);
    }

    #[test]
    fn a_stream_is_a_few_words() {
        assert!(size_of::<Stream>() <= 2 * size_of::<usize>());
    }
}
