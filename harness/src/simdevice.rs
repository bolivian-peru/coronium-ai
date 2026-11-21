//! A simulated device.
//!
//! It dials a relay as a real agent does, sends HELLO, and then carries
//! streams as the acceptor of a device link (PROTOCOL.md sections 6 and 7).
//! It never dials a target. For each OPEN it plays the target itself: an
//! HTTP/1.1 server that answers `GET /bytes/<n>?seed=<s>` with the body
//! [`Payload`] gives for that pair, and anything else with a short 404.
//!
//! One device is one task, with no channel and no second task behind it, so
//! one process can run many thousands. The task holds one frame being read,
//! little more than one frame waiting to be written, and a few words for each
//! open stream. A body is produced one frame at a time, as credit allows.
//!
//! The rules of the protocol are not written a second time here. Every frame
//! in either direction is put to the proto crate's [`Session`], and its
//! verdict decides what the device does: which OPEN is one too many, which
//! DATA overran its credit, which frame ends the connection.
//!
//! A device makes one connection and ends when the connection does. It does
//! not dial again, so section 6.2 never applies to it.

use std::collections::{HashMap, VecDeque};
use std::fmt;
use std::io;
use std::time::Duration;

use coronium_proto::frame::{
    ConnectionError, Credential, Frame, GoAwayCode, Id, InvalidFrame, MAX_FRAME_LEN, MAX_PAYLOAD,
    RefuseCode, Role, VERSION,
};
use coronium_proto::io::{FrameReader, ReadError};
use coronium_proto::session::{Link, Session, Side, Verdict};
use tokio::io::AsyncWriteExt;
use tokio::net::tcp::{ReadHalf, WriteHalf};
use tokio::time::{Instant, MissedTickBehavior, interval_at, timeout};

use crate::guard::TestAddr;
use crate::http;
use crate::payload::Payload;

/// Section 6.1: how long a dialer waits for the answer to its HELLO.
const ANSWER_TIMEOUT: Duration = Duration::from_secs(10);

/// How long a parting GOAWAY may take to write. A relay that has stopped
/// reading must not keep the task alive.
const GOODBYE_TIMEOUT: Duration = Duration::from_secs(1);

/// The longest request head a stream may send. A longer one is not a request
/// this device serves, and holding more of it would only cost memory.
const MAX_REQUEST_HEAD: usize = 1024;

/// Frames are read only while fewer bytes than this wait to be written. It
/// leaves room for one DATA frame and the small frames that answer what is
/// read, and it stops a relay that sends without reading from making the
/// device queue answers without bound.
const OUT_HIGH_WATER: usize = 2 * MAX_FRAME_LEN;

const SOFTWARE: &str = concat!("simdevice/", env!("CARGO_PKG_VERSION"));

const NOT_FOUND: &[u8] =
    b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";

/// What one simulated device needs to connect.
#[derive(Debug)]
pub struct Config {
    pub relay: TestAddr,
    pub id: Id,
    /// 1 to 1024: the most streams the device carries at once.
    pub max_streams: u16,
    /// 1 to 255 bytes.
    pub credential: Credential,
}

/// The id of simulated device number `index`: the text `simdevice`, three
/// zero bytes, then the number. Wherever an id is shown, a simulated device
/// can be told from a real one.
pub fn device_id(index: u32) -> Id {
    let mut id = [0; 16];
    id[..9].copy_from_slice(b"simdevice");
    id[12..].copy_from_slice(&index.to_be_bytes());
    id
}

/// How a connection ended when the relay ended it in an orderly way.
#[derive(Debug, PartialEq, Eq)]
pub enum End {
    /// The relay closed the connection between two frames.
    Closed,
    /// The relay answered HELLO with REFUSE.
    Refused {
        code: RefuseCode,
        retry_after_ms: u32,
        cause: String,
        fix: String,
    },
    /// The relay sent GOAWAY. The device finished its open streams, or the
    /// relay closed first.
    GoAway {
        code: GoAwayCode,
        reconnect_after_ms: u32,
        cause: String,
    },
}

impl fmt::Display for End {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Closed => f.write_str("the relay closed the connection"),
            Self::Refused {
                code, cause, fix, ..
            } => write!(f, "the relay refused ({code}): {cause}; fix: {fix}"),
            Self::GoAway { code, cause, .. } => write!(f, "the relay left ({code}): {cause}"),
        }
    }
}

/// Why a connection ended when nothing orderly ended it.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("HELLO cannot be sent: {0}")]
    Hello(InvalidFrame),
    #[error("the relay did not answer HELLO within 10 seconds")]
    NoAnswer,
    #[error("the relay broke the protocol: {0}")]
    Protocol(ConnectionError),
    #[error("nothing arrived from the relay for three keepalive periods")]
    Idle,
    #[error(transparent)]
    Io(#[from] io::Error),
}

impl From<ReadError> for Error {
    fn from(error: ReadError) -> Self {
        match error {
            ReadError::Protocol(error) => Self::Protocol(error),
            ReadError::Io(error) => Self::Io(error),
        }
    }
}

/// Runs one simulated device until its connection ends.
pub async fn run(config: Config) -> Result<End, Error> {
    let mut session = Session::new(Link::Device);
    let hello = Frame::Hello {
        version_min: VERSION,
        version_max: VERSION,
        role: Role::Device,
        id: config.id,
        max_streams: config.max_streams,
        credential: config.credential,
        software: SOFTWARE.to_owned(),
    };
    // Encoded before dialing, so a HELLO that cannot be sent costs no connection.
    let mut out = Vec::new();
    hello.encode(&mut out).map_err(Error::Hello)?;
    // The checker follows the connection from its first frame.
    session.check(Side::Dialer, &hello);

    let mut socket = config.relay.connect().await?;
    let (read_half, mut write_half) = socket.split();
    let mut reader = FrameReader::new(read_half);
    write_half.write_all(&out).await?;

    let answer = timeout(ANSWER_TIMEOUT, reader.read_frame()).await;
    let Some(answer) = answer.map_err(|_| Error::NoAnswer)?? else {
        return Ok(End::Closed);
    };
    let allowed = session.check(Side::Relay, &answer) == Verdict::Ok;
    match answer {
        Frame::Welcome {
            keepalive_ms,
            initial_window,
            ..
        } if allowed => {
            let keepalive = Duration::from_millis(keepalive_ms.into());
            let device = Device::new(session, initial_window);
            device.carry(reader, write_half, keepalive).await
        }
        Frame::Refuse {
            code,
            retry_after_ms,
            cause,
            fix,
        } if allowed => Ok(End::Refused {
            code,
            retry_after_ms,
            cause,
            fix,
        }),
        // Section 6 rules 2 and 3. GOAWAY is not allowed before WELCOME, so
        // the device closes without one.
        _ => Err(Error::Protocol(ConnectionError::UnexpectedFrame)),
    }
}

/// How far a stream has got.
enum Progress {
    /// The request head is still arriving.
    Reading(Vec<u8>),
    /// The request is read and part of the answer is still to be sent.
    Answering(Answer),
    /// The whole answer is sent, and END after it.
    Ended,
}

/// One open stream.
struct Stream {
    progress: Progress,
    /// The DATA bytes the device may still send.
    credit: u32,
    /// Whether the relay has sent END.
    relay_ended: bool,
}

impl Stream {
    fn can_send(&self) -> bool {
        self.credit > 0 && matches!(self.progress, Progress::Answering(_))
    }

    /// Section 7 rule 5: a stream is closed once both sides have sent END.
    fn is_closed(&self) -> bool {
        self.relay_ended && matches!(self.progress, Progress::Ended)
    }

    /// Takes in bytes from the relay. One request is read from a stream, and
    /// whatever follows it is dropped.
    fn read(&mut self, bytes: &[u8]) {
        let Progress::Reading(request) = &mut self.progress else {
            return;
        };
        let room = MAX_REQUEST_HEAD - request.len();
        request.extend_from_slice(&bytes[..bytes.len().min(room)]);
        if let Some(end) = http::head_end(request) {
            self.progress = Progress::Answering(Answer::to(&request[..end]));
        } else if request.len() == MAX_REQUEST_HEAD {
            self.progress = Progress::Answering(Answer::not_found());
        }
    }

    /// The relay will send no more. A request cut short is not one this
    /// device serves.
    fn relay_ended(&mut self) {
        self.relay_ended = true;
        if matches!(self.progress, Progress::Reading(_)) {
            self.progress = Progress::Answering(Answer::not_found());
        }
    }
}

/// What is left to send of the answer to one request. It always holds at
/// least one byte: a stream moves on to [`Progress::Ended`] with the last one.
struct Answer {
    /// The unsent part of the response head.
    head: Vec<u8>,
    /// The unsent part of the response body.
    body: Payload,
}

impl Answer {
    fn to(request_head: &[u8]) -> Self {
        let Some((seed, length)) = http::parse_bytes_request(request_head) else {
            return Self::not_found();
        };
        // One request is read from a stream, so the connection is not kept.
        let head =
            format!("HTTP/1.1 200 OK\r\nContent-Length: {length}\r\nConnection: close\r\n\r\n");
        Self {
            head: head.into_bytes(),
            body: Payload::new(seed, length),
        }
    }

    fn not_found() -> Self {
        Self {
            head: NOT_FOUND.to_vec(),
            body: Payload::new(0, 0),
        }
    }

    fn is_sent(&self) -> bool {
        self.head.is_empty() && self.body.remaining() == 0
    }

    /// Takes the next `limit` bytes of the answer, or all that is left.
    fn take(&mut self, limit: usize) -> Vec<u8> {
        let from_head = limit.min(self.head.len());
        let mut piece: Vec<u8> = self.head.drain(..from_head).collect();
        self.body.append(&mut piece, limit - from_head);
        piece
    }
}

/// One device after WELCOME.
struct Device {
    session: Session,
    /// From WELCOME: the credit each direction of each stream starts with.
    initial_window: u32,
    streams: HashMap<u32, Stream>,
    /// The streams that have something to send and the credit to send it, in
    /// the order they take turns. A stream is here once, or not at all.
    ready: VecDeque<u32>,
    /// Encoded frames. `out[flushed..]` is still to be written, and the
    /// buffer is emptied as soon as all of it is.
    out: Vec<u8>,
    flushed: usize,
    /// How many PINGs the device has sent, and whether the last is unanswered.
    pings: u64,
    pinging: bool,
    /// Set when the relay has sent GOAWAY: how this connection will end.
    leaving: Option<End>,
}

impl Device {
    fn new(session: Session, initial_window: u32) -> Self {
        Self {
            session,
            initial_window,
            streams: HashMap::new(),
            ready: VecDeque::new(),
            out: Vec::new(),
            flushed: 0,
            pings: 0,
            pinging: false,
            leaving: None,
        }
    }

    /// Carries streams until the connection ends.
    async fn carry(
        mut self,
        mut reader: FrameReader<ReadHalf<'_>>,
        mut writer: WriteHalf<'_>,
        keepalive: Duration,
    ) -> Result<End, Error> {
        // Section 6.1 is kept with one timer that ticks once a keepalive
        // period, and two small counts, so that no frame costs a clock read.
        // The price is lateness of up to one period, never earliness: a PING
        // goes out one to two periods after the last write, and the idle
        // limit is reached three to four periods after the last frame.
        let mut ticks = interval_at(Instant::now() + keepalive, keepalive);
        // After a stall the ticks must not arrive in a burst: each one counts
        // toward the idle limit.
        ticks.set_missed_tick_behavior(MissedTickBehavior::Delay);
        let mut wrote_since_tick = false;
        let mut quiet_ticks = 0;

        loop {
            // One piece per flush: the buffer stays near one frame, and every
            // stream with credit gets its turn.
            if self.out.is_empty() {
                self.queue_data();
            }
            if self.out.is_empty()
                && self.streams.is_empty()
                && let Some(end) = self.leaving.take()
            {
                return Ok(end);
            }

            // Reading and writing wait together, so a relay that is slow to
            // read never stops the device from hearing WINDOW, RESET or PING.
            // Both are safe to drop half-way: the reader keeps its bytes and
            // a `write` that did not finish wrote nothing.
            tokio::select! {
                frame = reader.read_frame(), if self.out.len() < OUT_HIGH_WATER => {
                    quiet_ticks = 0;
                    let received = match frame {
                        Ok(Some(frame)) => self.receive(frame),
                        Ok(None) => return Ok(self.leaving.take().unwrap_or(End::Closed)),
                        Err(ReadError::Protocol(error)) => Err(error),
                        Err(ReadError::Io(error)) => return Err(error.into()),
                    };
                    if let Err(error) = received {
                        let cause = error.to_string();
                        self.leave(&mut writer, GoAwayCode::PROTOCOL_ERROR, cause).await;
                        return Err(Error::Protocol(error));
                    }
                }
                count = writer.write(&self.out[self.flushed..]), if !self.out.is_empty() => {
                    self.wrote(count?)?;
                    wrote_since_tick = true;
                }
                _ = ticks.tick() => {
                    quiet_ticks += 1;
                    // Ticks are one period apart, so a fourth tick with no
                    // frame since before the first means over three periods.
                    if quiet_ticks > 3 {
                        let cause = "nothing received for three keepalive periods".to_owned();
                        self.leave(&mut writer, GoAwayCode::IDLE_TIMEOUT, cause).await;
                        return Err(Error::Idle);
                    }
                    if !wrote_since_tick && !self.pinging {
                        self.pings += 1;
                        self.pinging = true;
                        self.send(&Frame::Ping { payload: self.pings.to_be_bytes() });
                    }
                    wrote_since_tick = false;
                }
            }
        }
    }

    /// Notes that the next `count` bytes of `out` have been written.
    fn wrote(&mut self, count: usize) -> io::Result<()> {
        if count == 0 {
            return Err(io::ErrorKind::WriteZero.into());
        }
        self.flushed += count;
        if self.flushed < self.out.len() {
            return Ok(());
        }
        self.flushed = 0;
        if self.streams.is_empty() {
            // An idle device gives its buffer back, so the memory of a fleet
            // follows its traffic and not its size.
            self.out = Vec::new();
        } else {
            self.out.clear();
        }
        Ok(())
    }

    /// Sends a parting GOAWAY, as far as the relay will take it.
    async fn leave(&mut self, writer: &mut WriteHalf<'_>, code: GoAwayCode, cause: String) {
        let goaway = Frame::GoAway {
            code,
            reconnect_after_ms: 0,
            cause,
        };
        // Not put to the checker: after a connection error it accepts nothing
        // more, and this is the last frame either way.
        if goaway.encode(&mut self.out).is_ok() {
            let unsent = &self.out[self.flushed..];
            let _ = timeout(GOODBYE_TIMEOUT, writer.write_all(unsent)).await;
        }
    }

    /// Queues a frame of the device's own, after putting it to the checker
    /// like any other so that the checker sees the whole connection.
    fn send(&mut self, frame: &Frame) {
        let verdict = self.session.check(Side::Dialer, frame);
        debug_assert!(
            matches!(verdict, Verdict::Ok | Verdict::Ignored),
            "the simulated device broke a rule ({verdict}) with {frame:?}"
        );
        frame
            .encode(&mut self.out)
            .expect("every frame the device builds has an encoding");
    }

    /// Takes one frame from the relay. An error ends the connection.
    fn receive(&mut self, frame: Frame) -> Result<(), ConnectionError> {
        match self.session.check(Side::Relay, &frame) {
            Verdict::Ok => self.accept(frame),
            // Section 7 rule 6: a late frame for a closed stream.
            Verdict::Ignored => {}
            Verdict::StreamError(code) => {
                let stream = frame.stream();
                self.streams.remove(&stream);
                self.send(&Frame::Reset { stream, code });
            }
            Verdict::ConnectionError(error) => return Err(error),
        }
        Ok(())
    }

    /// Acts on a frame the rules allow.
    fn accept(&mut self, frame: Frame) {
        match frame {
            Frame::Ping { payload } => self.send(&Frame::Pong { payload }),
            Frame::Pong { .. } => self.pinging = false,
            Frame::GoAway {
                code,
                reconnect_after_ms,
                cause,
            } => {
                self.leaving = Some(End::GoAway {
                    code,
                    reconnect_after_ms,
                    cause,
                });
            }
            Frame::Open { stream, .. } => {
                let open = Stream {
                    progress: Progress::Reading(Vec::new()),
                    credit: self.initial_window,
                    relay_ended: false,
                };
                self.streams.insert(stream, open);
                // The device is its own target, so it is connected at once.
                self.send(&Frame::Opened { stream });
            }
            Frame::Data { stream, payload } => {
                self.change(stream, |open| open.read(&payload));
                // The bytes are consumed as they arrive, so their credit goes
                // straight back. A payload is never longer than MAX_PAYLOAD.
                let credit = payload.len() as u32;
                self.send(&Frame::Window { stream, credit });
            }
            // The checker has made sure the sum is within MAX_CREDIT.
            Frame::Window { stream, credit } => self.change(stream, |open| open.credit += credit),
            Frame::End { stream } => {
                self.change(stream, Stream::relay_ended);
                self.forget_if_closed(stream);
            }
            Frame::Reset { stream, .. } => {
                self.streams.remove(&stream);
            }
            // The checker allows none of these from a relay after WELCOME.
            Frame::Hello { .. }
            | Frame::Welcome { .. }
            | Frame::Refuse { .. }
            | Frame::Opened { .. } => {}
        }
    }

    /// Applies `change` to an open stream, and gives the stream a turn when
    /// that left it with something to send and the credit to send it.
    fn change(&mut self, id: u32, change: impl FnOnce(&mut Stream)) {
        let Some(stream) = self.streams.get_mut(&id) else {
            return;
        };
        let could_send = stream.can_send();
        change(stream);
        if !could_send && stream.can_send() {
            self.ready.push_back(id);
        }
    }

    /// Drops what is held for a stream once the stream is closed, which is
    /// also when the checker stops counting it toward `max_streams`.
    fn forget_if_closed(&mut self, id: u32) {
        if self.streams.get(&id).is_some_and(Stream::is_closed) {
            self.streams.remove(&id);
        }
    }

    /// Queues the next piece of the answer on the stream whose turn it is,
    /// and END behind it when that was the last piece.
    fn queue_data(&mut self) {
        while let Some(id) = self.ready.pop_front() {
            // A stream can close while it waits for its turn.
            let Some(stream) = self.streams.get_mut(&id) else {
                continue;
            };
            let Progress::Answering(answer) = &mut stream.progress else {
                continue;
            };
            let credit = usize::try_from(stream.credit).unwrap_or(MAX_PAYLOAD);
            let piece = answer.take(credit.min(MAX_PAYLOAD));
            let sent = answer.is_sent();
            // The piece was cut to the credit, so it fits.
            stream.credit -= piece.len() as u32;
            if sent {
                stream.progress = Progress::Ended;
            } else if stream.credit > 0 {
                self.ready.push_back(id);
            }

            self.send(&Frame::Data {
                stream: id,
                payload: piece.into(),
            });
            if sent {
                self.send(&Frame::End { stream: id });
                self.forget_if_closed(id);
            }
            return;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_simulated_id_says_what_it_is() {
        assert_eq!(&device_id(258), b"simdevice\0\0\0\0\0\x01\x02");
    }

    #[test]
    fn an_answer_comes_out_whole_however_it_is_cut() {
        let request = http::bytes_request(3, 5000);
        let mut whole = Vec::new();
        let mut answer = Answer::to(request.as_bytes());
        whole.extend(answer.take(usize::MAX));
        assert!(answer.is_sent());

        for limit in [1, 7, 60, 4096] {
            let mut answer = Answer::to(request.as_bytes());
            let mut pieces = Vec::new();
            while !answer.is_sent() {
                let piece = answer.take(limit);
                assert!(!piece.is_empty() && piece.len() <= limit);
                pieces.extend(piece);
            }
            assert_eq!(pieces, whole, "pieces of {limit}");
        }

        let head_end = http::head_end(&whole).unwrap();
        assert_eq!(http::status(&whole[..head_end]), Some(200));
        assert_eq!(http::content_length(&whole[..head_end]), Some(5000));
        assert_eq!(whole.len() - head_end, 5000);
    }

    #[test]
    fn a_request_head_is_never_held_beyond_its_limit() {
        let mut stream = Stream {
            progress: Progress::Reading(Vec::new()),
            credit: 16384,
            relay_ended: false,
        };
        for _ in 0..10 {
            stream.read(&[b'a'; 300]);
            if let Progress::Reading(request) = &stream.progress {
                assert!(request.len() < MAX_REQUEST_HEAD);
            }
        }
        let Progress::Answering(mut answer) = stream.progress else {
            panic!("a head that is too long must be answered");
        };
        assert_eq!(answer.take(usize::MAX), NOT_FOUND);
    }
}
