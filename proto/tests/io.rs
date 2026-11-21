//! Frames over a byte stream: what the reader takes from the stream, and when.

use std::io;
use std::net::Ipv4Addr;
use std::pin::{Pin, pin};
use std::task::{Context, Poll, Waker};

use bytes::Bytes;
use coronium_proto::frame::{
    ConnectionError, Credential, Frame, GoAwayCode, MAX_PAYLOAD, RefuseCode, ResetCode, Role,
    Target,
};
use coronium_proto::io::{FrameReader, FrameWriter, ReadError, WriteError};
use tokio::io::{AsyncRead, AsyncWriteExt, ReadBuf};

/// One frame of each of the twelve types.
fn one_of_each() -> Vec<Frame> {
    let id = [0xab; 16];
    vec![
        Frame::Hello {
            version_min: 1,
            version_max: 1,
            role: Role::Device,
            id,
            max_streams: 32,
            credential: Credential(b"example".to_vec()),
            software: "agent/0.1.0".to_owned(),
        },
        Frame::Welcome {
            version: 1,
            keepalive_ms: 25_000,
            initial_window: 65_536,
        },
        Frame::Refuse {
            code: RefuseCode::BUSY,
            retry_after_ms: 1000,
            cause: "busy".to_owned(),
            fix: "dial again later".to_owned(),
        },
        Frame::Ping { payload: [1; 8] },
        Frame::Pong { payload: [1; 8] },
        Frame::GoAway {
            code: GoAwayCode::DRAINING,
            reconnect_after_ms: 5000,
            cause: String::new(),
        },
        Frame::Open {
            stream: 1,
            device: id,
            target: Target::Ipv4(Ipv4Addr::new(192, 0, 2, 1)),
            port: 443,
        },
        Frame::Opened { stream: 1 },
        Frame::Data {
            stream: 1,
            payload: Bytes::from(vec![7; MAX_PAYLOAD]),
        },
        Frame::Window {
            stream: 1,
            credit: 65_536,
        },
        Frame::End { stream: 1 },
        Frame::Reset {
            stream: 1,
            code: ResetCode::CANCELLED,
        },
    ]
}

fn wire_of(frames: &[Frame]) -> Vec<u8> {
    let mut wire = Vec::new();
    for frame in frames {
        frame.encode(&mut wire).unwrap();
    }
    wire
}

/// A stream that hands over one byte for each read, the slowest a peer can be.
struct OneByteAtATime<'a>(&'a [u8]);

impl AsyncRead for OneByteAtATime<'_> {
    fn poll_read(
        mut self: Pin<&mut Self>,
        _: &mut Context<'_>,
        buf: &mut ReadBuf<'_>,
    ) -> Poll<io::Result<()>> {
        if let Some((first, rest)) = self.0.split_first() {
            buf.put_slice(&[*first]);
            self.0 = rest;
        }
        Poll::Ready(Ok(()))
    }
}

fn is_unexpected_eof(result: Result<Option<Frame>, ReadError>) -> bool {
    matches!(result, Err(ReadError::Io(error)) if error.kind() == io::ErrorKind::UnexpectedEof)
}

#[tokio::test]
async fn frames_written_are_the_frames_read() {
    let frames = one_of_each();
    let (near, far) = tokio::io::duplex(1024);
    let sent = frames.clone();
    let writing = tokio::spawn(async move {
        let mut writer = FrameWriter::new(near);
        for frame in &sent {
            writer.write_frame(frame).await.unwrap();
        }
    });

    let mut reader = FrameReader::new(far);
    for frame in &frames {
        assert_eq!(reader.read_frame().await.unwrap().as_ref(), Some(frame));
    }
    // The writer is dropped when its task ends, which closes the stream on a frame boundary.
    writing.await.unwrap();
    assert!(reader.read_frame().await.unwrap().is_none());
}

#[tokio::test]
async fn frames_arriving_one_byte_at_a_time_are_read() {
    let frames = one_of_each();
    let wire = wire_of(&frames);
    let mut reader = FrameReader::new(OneByteAtATime(&wire));
    for frame in &frames {
        assert_eq!(reader.read_frame().await.unwrap().as_ref(), Some(frame));
    }
    assert!(reader.read_frame().await.unwrap().is_none());
}

#[tokio::test]
async fn an_oversized_frame_is_refused_without_reading_its_payload() {
    // DATA on stream 1 announcing 16385 bytes, with all of them behind the header.
    let mut wire = vec![0x12, 0, 0, 0, 0, 1, 0x40, 0x01];
    wire.resize(8 + MAX_PAYLOAD + 1, 0xee);

    let mut source = wire.as_slice();
    let mut reader = FrameReader::new(&mut source);
    let error = reader.read_frame().await.unwrap_err();
    assert!(matches!(
        error,
        ReadError::Protocol(ConnectionError::FrameTooLarge)
    ));
    // The reader took the header and nothing else: the payload is still in the stream.
    assert_eq!(source.len(), MAX_PAYLOAD + 1);
}

#[tokio::test]
async fn every_header_refusal_comes_before_the_payload_is_read() {
    let cases = [
        ([0x7f, 0, 0, 0, 0, 0, 0, 100], ConnectionError::UnknownFrame),
        ([0x12, 1, 0, 0, 0, 1, 0, 100], ConnectionError::BadFlags),
        (
            [0x12, 0, 0, 0, 0, 1, 0xff, 0xff],
            ConnectionError::FrameTooLarge,
        ),
        ([0x12, 0, 0, 0, 0, 0, 0, 100], ConnectionError::BadStreamId),
        ([0x04, 0, 0, 0, 0, 1, 0, 100], ConnectionError::BadStreamId),
    ];
    for (header, expected) in cases {
        let mut wire = header.to_vec();
        wire.resize(8 + 100, 0xee);
        let mut source = wire.as_slice();
        let mut reader = FrameReader::new(&mut source);
        match reader.read_frame().await {
            Err(ReadError::Protocol(error)) => assert_eq!(error, expected),
            other => panic!("{header:?}: {other:?}"),
        }
        assert_eq!(source.len(), 100, "{header:?}: payload bytes were read");
    }
}

#[tokio::test]
async fn a_bad_payload_is_refused_once_it_has_arrived() {
    // WINDOW with credit zero, then a frame that must not be touched.
    let mut wire = vec![0x13, 0, 0, 0, 0, 1, 0, 4, 0, 0, 0, 0];
    wire.extend(wire_of(&[Frame::End { stream: 1 }]));
    let mut source = wire.as_slice();
    let mut reader = FrameReader::new(&mut source);
    let error = reader.read_frame().await.unwrap_err();
    assert!(matches!(
        error,
        ReadError::Protocol(ConnectionError::BadPayload)
    ));
    assert_eq!(source.len(), 8);
}

#[tokio::test]
async fn a_stream_that_ends_inside_a_frame_is_an_error() {
    let wire = wire_of(&[Frame::Data {
        stream: 1,
        payload: Bytes::from_static(b"hello"),
    }]);
    // Cut inside the header, at the end of the header, and inside the payload.
    for length in [3, 8, 10] {
        let mut reader = FrameReader::new(&wire[..length]);
        assert!(
            is_unexpected_eof(reader.read_frame().await),
            "cut at {length}"
        );
    }
    // After a whole frame, the end of the stream is a clean close.
    let mut reader = FrameReader::new(wire.as_slice());
    assert!(reader.read_frame().await.unwrap().is_some());
    assert!(reader.read_frame().await.unwrap().is_none());
    // A stream with nothing in it is a clean close too.
    let mut reader = FrameReader::new(&[][..]);
    assert!(reader.read_frame().await.unwrap().is_none());
}

/// A read is raced against timers, so a read that is dropped half way must
/// not lose the bytes it already took from the stream.
#[tokio::test]
async fn a_dropped_read_loses_no_bytes() {
    let frame = Frame::Data {
        stream: 1,
        payload: Bytes::from_static(b"hello"),
    };
    let wire = wire_of(std::slice::from_ref(&frame));
    let (mut near, far) = tokio::io::duplex(64);
    let mut reader = FrameReader::new(far);
    let mut context = Context::from_waker(Waker::noop());

    for part in [&wire[..3], &wire[3..10]] {
        near.write_all(part).await.unwrap();
        let mut read = pin!(reader.read_frame());
        assert!(read.as_mut().poll(&mut context).is_pending());
    }
    near.write_all(&wire[10..]).await.unwrap();
    assert_eq!(reader.read_frame().await.unwrap(), Some(frame));
}

#[tokio::test]
async fn a_frame_with_no_encoding_is_not_written() {
    let mut sink = Vec::new();
    let mut writer = FrameWriter::new(&mut sink);
    let empty = Frame::Data {
        stream: 1,
        payload: Bytes::new(),
    };
    let result = writer.write_frame(&empty).await;
    assert!(matches!(result, Err(WriteError::Invalid(_))));
    // The writer is still usable, and only the valid frame reached the stream.
    let end = Frame::End { stream: 1 };
    writer.write_frame(&end).await.unwrap();
    assert_eq!(sink, wire_of(&[end]));
}
