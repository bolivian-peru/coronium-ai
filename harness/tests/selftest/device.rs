//! A simulated device driven one frame at a time, by a relay that is a script.
//!
//! The load tests show a device working. These show the single rules it must
//! keep, including the ones a well-behaved relay never gives it cause to use.

use std::time::Duration;

use bytes::Bytes;
use coronium_harness::guard::TestAddr;
use coronium_harness::payload;
use coronium_harness::simdevice::{self, End, Error};
use coronium_proto::frame::{
    ConnectionError, Credential, Frame, GoAwayCode, RefuseCode, ResetCode, Role, Target, VERSION,
};
use coronium_proto::io::{FrameReader, FrameWriter, ReadError};
use coronium_proto::session::{Link, Session, Side, Verdict};
use sha2::{Digest, Sha256};
use tokio::net::TcpListener;
use tokio::net::tcp::{OwnedReadHalf, OwnedWriteHalf};
use tokio::task::JoinHandle;
use tokio::time::timeout;

/// Longer than anything here takes, so a missing frame fails and never hangs.
const WAIT: Duration = Duration::from_secs(10);

/// How long a device must say nothing to count as waiting.
const QUIET: Duration = Duration::from_millis(300);

const WINDOW: u32 = 16384;

/// The longest keepalive there is, for tests where a PING would be noise.
const NO_PINGS: u32 = 600_000;

const NOT_FOUND: &[u8] =
    b"HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";

/// The relay end of one device connection. Every frame in either direction
/// goes through the rule checker.
struct Relay {
    reader: FrameReader<OwnedReadHalf>,
    writer: FrameWriter<OwnedWriteHalf>,
    session: Session,
    device: JoinHandle<Result<End, Error>>,
}

impl Relay {
    /// Starts a device and takes its HELLO, without answering it.
    async fn dialed(max_streams: u16) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let config = simdevice::Config {
            relay: TestAddr::new(listener.local_addr().unwrap()).unwrap(),
            id: simdevice::device_id(7),
            max_streams,
            credential: Credential(b"made-up".to_vec()),
        };
        let device = tokio::spawn(simdevice::run(config));
        let (socket, _) = listener.accept().await.unwrap();
        let (read_half, write_half) = socket.into_split();
        let mut relay = Self {
            reader: FrameReader::new(read_half),
            writer: FrameWriter::new(write_half),
            session: Session::new(Link::Device),
            device,
        };
        let hello = relay.next().await;
        let expected = Frame::Hello {
            version_min: VERSION,
            version_max: VERSION,
            role: Role::Device,
            id: simdevice::device_id(7),
            max_streams,
            credential: Credential(b"made-up".to_vec()),
            software: concat!("simdevice/", env!("CARGO_PKG_VERSION")).to_owned(),
        };
        assert_eq!(hello, expected);
        relay
    }

    /// Starts a device and welcomes it.
    async fn welcomed(max_streams: u16, keepalive_ms: u32) -> Self {
        let mut relay = Self::dialed(max_streams).await;
        let welcome = Frame::Welcome {
            version: VERSION,
            keepalive_ms,
            initial_window: WINDOW,
        };
        assert_eq!(relay.send(welcome).await, Verdict::Ok);
        relay
    }

    /// Sends a frame, and says what the rules make of it.
    async fn send(&mut self, frame: Frame) -> Verdict {
        let verdict = self.session.check(Side::Relay, &frame);
        self.writer.write_frame(&frame).await.unwrap();
        verdict
    }

    /// The next frame from the device, which must be within the rules.
    async fn next(&mut self) -> Frame {
        let frame = timeout(WAIT, self.reader.read_frame()).await;
        let frame = frame.expect("the device sent nothing").unwrap();
        let frame = frame.expect("the device closed the connection");
        // Ignored is within the rules: frames for a stream that has just
        // closed can cross on the wire.
        let verdict = self.session.check(Side::Dialer, &frame);
        let allowed = matches!(verdict, Verdict::Ok | Verdict::Ignored);
        assert!(
            allowed,
            "the device broke a rule ({verdict}) with {frame:?}"
        );
        frame
    }

    /// Checks that the device is waiting: it sends nothing.
    async fn silence(&mut self) {
        let frame = timeout(QUIET, self.reader.read_frame()).await;
        assert!(
            frame.is_err(),
            "the device should be waiting, but sent {frame:?}"
        );
    }

    /// Checks that the device has closed the connection, and says how it ended.
    async fn ended(mut self) -> Result<End, Error> {
        let last = timeout(WAIT, self.reader.read_frame()).await;
        let last = last.expect("the device kept the connection");
        assert!(matches!(last, Ok(None) | Err(ReadError::Io(_))), "{last:?}");
        timeout(WAIT, self.device).await.unwrap().unwrap()
    }

    /// Opens a stream and sends a request on it. Takes the OPENED, and the
    /// WINDOW that gives the request's credit back.
    async fn request(&mut self, stream: u32, request: &str) {
        assert_eq!(self.send(open(stream)).await, Verdict::Ok);
        assert_eq!(self.next().await, Frame::Opened { stream });
        let payload = Bytes::copy_from_slice(request.as_bytes());
        assert_eq!(
            self.send(Frame::Data { stream, payload }).await,
            Verdict::Ok
        );
        let credit = request.len() as u32;
        assert_eq!(self.next().await, Frame::Window { stream, credit });
    }

    /// Takes DATA on `stream` until exactly `count` bytes have come.
    async fn data(&mut self, stream: u32, count: usize) -> Vec<u8> {
        let mut bytes = Vec::new();
        while bytes.len() < count {
            match self.next().await {
                Frame::Data {
                    stream: on,
                    payload,
                } if on == stream => {
                    bytes.extend_from_slice(&payload);
                }
                other => panic!("expected DATA on stream {stream}, got {other:?}"),
            }
        }
        assert_eq!(bytes.len(), count);
        bytes
    }
}

fn open(stream: u32) -> Frame {
    Frame::Open {
        stream,
        device: simdevice::device_id(7),
        target: Target::Name("simdevice.invalid".to_owned()),
        port: 80,
    }
}

#[tokio::test]
async fn a_device_sends_up_to_its_credit_and_then_waits_for_window() {
    let mut relay = Relay::welcomed(8, NO_PINGS).await;
    relay
        .request(1, "GET /bytes/20000?seed=5 HTTP/1.1\r\n\r\n")
        .await;

    // The first window, to the byte, and then nothing.
    let mut answer = relay.data(1, WINDOW as usize).await;
    relay.silence().await;
    // A little credit buys exactly that much.
    relay
        .send(Frame::Window {
            stream: 1,
            credit: 100,
        })
        .await;
    answer.extend(relay.data(1, 100).await);
    relay.silence().await;
    // Plenty of credit buys the rest, and END.
    let head = b"HTTP/1.1 200 OK\r\nContent-Length: 20000\r\nConnection: close\r\n\r\n";
    let rest = head.len() + 20_000 - answer.len();
    relay
        .send(Frame::Window {
            stream: 1,
            credit: 1 << 20,
        })
        .await;
    answer.extend(relay.data(1, rest).await);
    assert_eq!(relay.next().await, Frame::End { stream: 1 });

    let (answer_head, body) = answer.split_at(head.len());
    assert_eq!(answer_head, head);
    let digest: [u8; 32] = Sha256::digest(body).into();
    assert_eq!(digest, payload::sha256(5, 20_000));

    // The relay's END closes the stream, and the device stays.
    assert_eq!(relay.send(Frame::End { stream: 1 }).await, Verdict::Ok);
    relay.send(Frame::Ping { payload: [3; 8] }).await;
    assert_eq!(relay.next().await, Frame::Pong { payload: [3; 8] });
}

#[tokio::test]
async fn anything_but_a_bytes_request_gets_a_short_404() {
    let mut relay = Relay::welcomed(8, NO_PINGS).await;
    relay.request(1, "GET /other HTTP/1.1\r\n\r\n").await;
    assert_eq!(relay.data(1, NOT_FOUND.len()).await, NOT_FOUND);
    assert_eq!(relay.next().await, Frame::End { stream: 1 });

    // A request the relay ends half-way.
    assert_eq!(relay.send(open(2)).await, Verdict::Ok);
    assert_eq!(relay.next().await, Frame::Opened { stream: 2 });
    let payload = Bytes::from_static(b"GET /bytes/5?se");
    relay.send(Frame::Data { stream: 2, payload }).await;
    assert_eq!(
        relay.next().await,
        Frame::Window {
            stream: 2,
            credit: 15
        }
    );
    relay.send(Frame::End { stream: 2 }).await;
    assert_eq!(relay.data(2, NOT_FOUND.len()).await, NOT_FOUND);
    assert_eq!(relay.next().await, Frame::End { stream: 2 });

    // An empty body is a head and END. DATA is never empty.
    relay
        .request(3, "GET /bytes/0?seed=1 HTTP/1.1\r\n\r\n")
        .await;
    let head = b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n";
    assert_eq!(relay.data(3, head.len()).await, head);
    assert_eq!(relay.next().await, Frame::End { stream: 3 });
}

#[tokio::test]
async fn a_device_carries_no_more_streams_than_it_said() {
    let mut relay = Relay::welcomed(2, NO_PINGS).await;
    for stream in [1, 2] {
        assert_eq!(relay.send(open(stream)).await, Verdict::Ok);
        assert_eq!(relay.next().await, Frame::Opened { stream });
    }
    // One too many: the rules say so, and so does the device.
    let too_many = ResetCode::TOO_MANY_STREAMS;
    assert_eq!(relay.send(open(3)).await, Verdict::StreamError(too_many));
    let reset = Frame::Reset {
        stream: 3,
        code: too_many,
    };
    assert_eq!(relay.next().await, reset);

    // A stream that is reset gives its place back.
    let cancelled = ResetCode::CANCELLED;
    relay
        .send(Frame::Reset {
            stream: 1,
            code: cancelled,
        })
        .await;
    assert_eq!(relay.send(open(4)).await, Verdict::Ok);
    assert_eq!(relay.next().await, Frame::Opened { stream: 4 });

    // So does a stream both sides have ended.
    relay.send(Frame::End { stream: 2 }).await;
    assert_eq!(relay.data(2, NOT_FOUND.len()).await, NOT_FOUND);
    assert_eq!(relay.next().await, Frame::End { stream: 2 });
    assert_eq!(relay.send(open(5)).await, Verdict::Ok);
    assert_eq!(relay.next().await, Frame::Opened { stream: 5 });
}

#[tokio::test]
async fn a_reset_stream_sends_nothing_more() {
    let mut relay = Relay::welcomed(8, NO_PINGS).await;
    relay
        .request(1, "GET /bytes/1000000?seed=2 HTTP/1.1\r\n\r\n")
        .await;
    relay.data(1, WINDOW as usize).await;
    let cancelled = ResetCode::CANCELLED;
    relay
        .send(Frame::Reset {
            stream: 1,
            code: cancelled,
        })
        .await;
    // Credit for a stream that is over buys nothing.
    let late = Frame::Window {
        stream: 1,
        credit: 100_000,
    };
    assert_eq!(relay.send(late).await, Verdict::Ignored);
    relay.send(Frame::Ping { payload: [1; 8] }).await;
    assert_eq!(relay.next().await, Frame::Pong { payload: [1; 8] });
    relay.silence().await;
}

#[tokio::test]
async fn a_device_finishes_its_streams_after_goaway_and_then_goes() {
    let mut relay = Relay::welcomed(8, NO_PINGS).await;
    relay
        .request(1, "GET /bytes/20000?seed=9 HTTP/1.1\r\n\r\n")
        .await;
    relay.data(1, WINDOW as usize).await;
    let goaway = Frame::GoAway {
        code: GoAwayCode::DRAINING,
        reconnect_after_ms: 250,
        cause: "planned restart".to_owned(),
    };
    assert_eq!(relay.send(goaway).await, Verdict::Ok);

    // The stream that was open goes on to its end.
    relay
        .send(Frame::Window {
            stream: 1,
            credit: 1 << 20,
        })
        .await;
    let rest = "HTTP/1.1 200 OK\r\nContent-Length: 20000\r\nConnection: close\r\n\r\n".len()
        + 20_000
        - WINDOW as usize;
    relay.data(1, rest).await;
    assert_eq!(relay.next().await, Frame::End { stream: 1 });
    relay.send(Frame::End { stream: 1 }).await;

    let end = relay.ended().await.unwrap();
    let expected = End::GoAway {
        code: GoAwayCode::DRAINING,
        reconnect_after_ms: 250,
        cause: "planned restart".to_owned(),
    };
    assert_eq!(end, expected);
}

#[tokio::test]
async fn a_device_answers_ping_pings_a_quiet_relay_and_leaves_a_silent_one() {
    let mut relay = Relay::welcomed(8, 1000).await;
    relay
        .send(Frame::Ping {
            payload: *b"are you?",
        })
        .await;
    assert_eq!(
        relay.next().await,
        Frame::Pong {
            payload: *b"are you?"
        }
    );

    // With nothing to send for a keepalive period, the device asks in turn.
    let Frame::Ping { payload: first } = relay.next().await else {
        panic!("expected a PING from an idle device");
    };
    assert_eq!(
        relay.send(Frame::Pong { payload: first }).await,
        Verdict::Ok
    );

    // From here the relay is silent. The device asks once more, never twice
    // while unanswered, and after three keepalive periods says why it goes.
    let Frame::Ping { payload: second } = relay.next().await else {
        panic!("expected a second PING");
    };
    assert_ne!(first, second);
    let goaway = relay.next().await;
    assert!(
        matches!(&goaway, Frame::GoAway { code, .. } if *code == GoAwayCode::IDLE_TIMEOUT),
        "{goaway:?}"
    );
    assert!(matches!(relay.ended().await, Err(Error::Idle)));
}

#[tokio::test]
async fn a_relay_that_breaks_a_rule_is_told_which_and_left() {
    let mut relay = Relay::welcomed(8, NO_PINGS).await;
    // OPENED is only ever the acceptor's frame.
    let broken = relay.send(Frame::Opened { stream: 1 }).await;
    let unexpected = ConnectionError::UnexpectedFrame;
    assert_eq!(broken, Verdict::ConnectionError(unexpected));

    // Read past the checker: after a connection error it accepts nothing.
    let goaway = timeout(WAIT, relay.reader.read_frame()).await.unwrap();
    let Ok(Some(Frame::GoAway { code, cause, .. })) = goaway else {
        panic!("expected GOAWAY, got {goaway:?}");
    };
    assert_eq!(code, GoAwayCode::PROTOCOL_ERROR);
    assert!(cause.starts_with("unexpected_frame"), "{cause}");
    let end = relay.ended().await;
    assert!(matches!(end, Err(Error::Protocol(error)) if error == unexpected));
}

#[tokio::test]
async fn a_refused_device_ends_with_the_cause_and_the_fix() {
    let mut relay = Relay::dialed(8).await;
    let refuse = Frame::Refuse {
        code: RefuseCode::BAD_CREDENTIAL,
        retry_after_ms: 0,
        cause: "the credential is not recognised".to_owned(),
        fix: "enrol the device again".to_owned(),
    };
    assert_eq!(relay.send(refuse).await, Verdict::Ok);
    let end = relay.ended().await.unwrap();
    assert_eq!(
        end.to_string(),
        "the relay refused (bad_credential): the credential is not recognised; \
         fix: enrol the device again"
    );
}
