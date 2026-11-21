//! What must hold for every frame, checked over frames from a small
//! generator with a fixed seed, so a failure repeats on every run.

use std::net::{Ipv4Addr, Ipv6Addr};

use bytes::Bytes;
use coronium_proto::frame::{
    Credential, Frame, GoAwayCode, HEADER_LEN, MAX_CREDIT, MAX_PAYLOAD, RefuseCode, ResetCode,
    Role, Target, decode,
};

/// SplitMix64: a few lines, no dependency, and good enough to spread test inputs.
struct Rng(u64);

impl Rng {
    fn next(&mut self) -> u64 {
        self.0 = self.0.wrapping_add(0x9e37_79b9_7f4a_7c15);
        let mut z = self.0;
        z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
        z ^ (z >> 31)
    }

    /// A number from `low` to `high`, both included.
    fn range(&mut self, low: u64, high: u64) -> u64 {
        low + self.next() % (high - low + 1)
    }

    fn pick<T: Clone>(&mut self, choices: &[T]) -> T {
        choices[self.range(0, choices.len() as u64 - 1) as usize].clone()
    }

    fn bytes(&mut self, length: usize) -> Vec<u8> {
        (0..length).map(|_| self.next() as u8).collect()
    }

    fn array<const N: usize>(&mut self) -> [u8; N] {
        std::array::from_fn(|_| self.next() as u8)
    }

    /// Text from characters of one to four bytes, `min` to `max` bytes long.
    fn text(&mut self, min: usize, max: usize) -> String {
        let target = self.range(min as u64, max as u64) as usize;
        let mut text = String::new();
        while text.len() < target {
            let next = self.pick(&[' ', 'a', '~', '\u{80}', '\u{e9}', '\u{20ac}', '\u{10ffff}']);
            if text.len() + next.len_utf8() > max {
                text.push('a');
            } else {
                text.push(next);
            }
        }
        text
    }

    /// A name section 5.1 allows. Three labels of up to 63 bytes stay under
    /// the 253 bytes a name may have; a fourth could pass them.
    fn name(&mut self) -> String {
        let labels = self.range(1, 3);
        let mut name = String::new();
        for _ in 0..labels {
            if !name.is_empty() {
                name.push('.');
            }
            for _ in 0..self.range(1, 63) {
                name.push(self.pick(&['a', 'z', '0', '9', '-', '_']));
            }
        }
        // A letter at the end keeps the last label from being all digits.
        name.pop();
        name.push('a');
        name
    }
}

/// A frame that keeps every field rule, over the whole range of every field.
fn valid_frame(rng: &mut Rng) -> Frame {
    let stream = rng.range(1, u64::from(u32::MAX)) as u32;
    match rng.range(0, 11) {
        0 => {
            let version_min = rng.range(1, 255) as u8;
            let role = rng.pick(&[Role::Device, Role::Edge]);
            Frame::Hello {
                version_min,
                version_max: rng.range(u64::from(version_min), 255) as u8,
                role,
                id: rng.array(),
                max_streams: match role {
                    Role::Device => rng.range(1, 1024) as u16,
                    Role::Edge => 0,
                },
                credential: {
                    let length = rng.range(1, 255) as usize;
                    Credential(rng.bytes(length))
                },
                software: (0..rng.range(0, 64))
                    .map(|_| char::from(rng.range(0x20, 0x7e) as u8))
                    .collect(),
            }
        }
        1 => Frame::Welcome {
            version: rng.range(1, 255) as u8,
            keepalive_ms: rng.range(1000, 600_000) as u32,
            initial_window: rng.range(16384, 1_048_576) as u32,
        },
        2 => Frame::Refuse {
            code: RefuseCode::new(rng.range(1, 65535) as u16).unwrap(),
            retry_after_ms: rng.next() as u32,
            cause: rng.text(1, 255),
            fix: rng.text(1, 255),
        },
        3 => Frame::Ping {
            payload: rng.array(),
        },
        4 => Frame::Pong {
            payload: rng.array(),
        },
        5 => Frame::GoAway {
            code: GoAwayCode::new(rng.range(1, 65535) as u16).unwrap(),
            reconnect_after_ms: rng.next() as u32,
            cause: rng.text(0, 255),
        },
        6 => Frame::Open {
            stream,
            device: rng.array(),
            target: match rng.range(0, 2) {
                0 => Target::Name(rng.name()),
                1 => Target::Ipv4(Ipv4Addr::from(rng.array::<4>())),
                _ => Target::Ipv6(Ipv6Addr::from(rng.array::<16>())),
            },
            port: rng.range(1, 65535) as u16,
        },
        7 => Frame::Opened { stream },
        8 => {
            let length = rng.pick(&[1, 2, 100, MAX_PAYLOAD - 1, MAX_PAYLOAD]);
            Frame::Data {
                stream,
                payload: Bytes::from(rng.bytes(length)),
            }
        }
        9 => Frame::Window {
            stream,
            credit: rng.range(1, u64::from(MAX_CREDIT)) as u32,
        },
        10 => Frame::End { stream },
        _ => Frame::Reset {
            stream,
            code: ResetCode::new(rng.range(1, 65535) as u16).unwrap(),
        },
    }
}

/// A frame whose fields sit on and just outside their limits, so that many of
/// them break a rule. These are the values a caller could build by mistake.
fn any_frame(rng: &mut Rng) -> Frame {
    let stream = rng.pick(&[0, 1, u32::MAX]);
    let text = |rng: &mut Rng| {
        rng.pick(&[
            String::new(),
            "a".to_owned(),
            "a".repeat(255),
            "a".repeat(256),
            "line\nbreak".to_owned(),
            "\u{7f}".to_owned(),
            "\u{e9}".to_owned(),
        ])
    };
    match rng.range(0, 11) {
        0 => Frame::Hello {
            version_min: rng.pick(&[0, 1, 2, 255]),
            version_max: rng.pick(&[0, 1, 2, 255]),
            role: rng.pick(&[Role::Device, Role::Edge]),
            id: rng.array(),
            max_streams: rng.pick(&[0, 1, 1024, 1025, u16::MAX]),
            credential: {
                let length = rng.pick(&[0, 1, 255, 256, 300]);
                Credential(rng.bytes(length))
            },
            software: rng.pick(&[
                String::new(),
                "agent/0.1.0".to_owned(),
                "a".repeat(64),
                "a".repeat(65),
                "a".repeat(256),
                "\u{1f}".to_owned(),
                "\u{7f}".to_owned(),
                "\u{e9}".to_owned(),
            ]),
        },
        1 => Frame::Welcome {
            version: rng.pick(&[0, 1, 255]),
            keepalive_ms: rng.pick(&[0, 999, 1000, 600_000, 600_001, u32::MAX]),
            initial_window: rng.pick(&[0, 16383, 16384, 1_048_576, 1_048_577, u32::MAX]),
        },
        2 => Frame::Refuse {
            code: RefuseCode::new(rng.pick(&[1, 5, 6, u16::MAX])).unwrap(),
            retry_after_ms: rng.pick(&[0, u32::MAX]),
            cause: text(rng),
            fix: text(rng),
        },
        3 => Frame::Ping {
            payload: rng.array(),
        },
        4 => Frame::Pong {
            payload: rng.array(),
        },
        5 => Frame::GoAway {
            code: GoAwayCode::new(rng.pick(&[1, 5, 6, u16::MAX])).unwrap(),
            reconnect_after_ms: rng.pick(&[0, u32::MAX]),
            cause: text(rng),
        },
        6 => Frame::Open {
            stream,
            device: rng.array(),
            target: match rng.range(0, 2) {
                0 => Target::Name(
                    rng.pick(&[
                        String::new(),
                        "a".to_owned(),
                        "example.com".to_owned(),
                        "Example.com".to_owned(),
                        ".example.com".to_owned(),
                        "example.com.".to_owned(),
                        "example..com".to_owned(),
                        "example.123".to_owned(),
                        "192.0.2.1".to_owned(),
                        "example com".to_owned(),
                        "ex\u{e4}mple.com".to_owned(),
                        format!("{}.example", "a".repeat(63)),
                        format!("{}.example", "a".repeat(64)),
                        [
                            "a".repeat(63),
                            "b".repeat(63),
                            "c".repeat(63),
                            "d".repeat(61),
                        ]
                        .join("."),
                        [
                            "a".repeat(63),
                            "b".repeat(63),
                            "c".repeat(63),
                            "d".repeat(62),
                        ]
                        .join("."),
                        "a.".repeat(200),
                    ]),
                ),
                1 => Target::Ipv4(Ipv4Addr::from(rng.array::<4>())),
                _ => Target::Ipv6(Ipv6Addr::from(rng.array::<16>())),
            },
            port: rng.pick(&[0, 1, u16::MAX]),
        },
        7 => Frame::Opened { stream },
        8 => {
            let length = rng.pick(&[0, 1, MAX_PAYLOAD, MAX_PAYLOAD + 1, 70_000]);
            Frame::Data {
                stream,
                payload: Bytes::from(rng.bytes(length)),
            }
        }
        9 => Frame::Window {
            stream,
            credit: rng.pick(&[0, 1, MAX_CREDIT, MAX_CREDIT + 1, u32::MAX]),
        },
        10 => Frame::End { stream },
        _ => Frame::Reset {
            stream,
            code: ResetCode::new(rng.pick(&[1, 13, 14, u16::MAX])).unwrap(),
        },
    }
}

fn encoded(frame: &Frame) -> Vec<u8> {
    let mut wire = Vec::new();
    frame
        .encode(&mut wire)
        .expect("the generator makes valid frames");
    wire
}

#[test]
fn decoding_an_encoded_frame_gives_the_frame_back() {
    let mut rng = Rng(1);
    for _ in 0..20_000 {
        let frame = valid_frame(&mut rng);
        let wire = encoded(&frame);
        assert_eq!(decode(&wire), Ok(Some((frame, wire.len()))));
    }
}

/// The encoder either refuses a frame and writes nothing, or writes bytes
/// that decode to exactly that frame. There is no third outcome.
#[test]
fn the_encoder_emits_nothing_the_decoder_would_refuse() {
    let mut rng = Rng(2);
    let (mut emitted, mut refused) = (0, 0);
    for _ in 0..20_000 {
        let frame = any_frame(&mut rng);
        // Bytes already in the buffer must survive either outcome.
        let mut wire = b"before".to_vec();
        match frame.encode(&mut wire) {
            Ok(()) => {
                emitted += 1;
                let (before, written) = wire.split_at(6);
                assert_eq!(before, b"before");
                assert_eq!(decode(written), Ok(Some((frame, written.len()))));
            }
            Err(_) => {
                refused += 1;
                assert_eq!(
                    wire, b"before",
                    "a refused frame left bytes behind: {frame:?}"
                );
            }
        }
    }
    assert!(
        emitted > 1000 && refused > 1000,
        "{emitted} emitted, {refused} refused"
    );
}

#[test]
fn every_strict_prefix_of_a_valid_frame_is_incomplete() {
    let mut rng = Rng(3);
    for _ in 0..500 {
        let wire = encoded(&valid_frame(&mut rng));
        for length in 0..wire.len() {
            assert_eq!(
                decode(&wire[..length]),
                Ok(None),
                "{length} of {} bytes",
                wire.len()
            );
        }
    }
}

#[test]
fn frames_decode_one_after_another_from_one_buffer() {
    let mut rng = Rng(4);
    let frames: Vec<Frame> = (0..200).map(|_| valid_frame(&mut rng)).collect();
    let mut wire = Vec::new();
    for frame in &frames {
        frame.encode(&mut wire).unwrap();
    }
    let mut rest = wire.as_slice();
    for frame in &frames {
        let (decoded, used) = decode(rest).unwrap().unwrap();
        assert_eq!(&decoded, frame);
        rest = &rest[used..];
    }
    assert!(rest.is_empty());
}

/// Bytes that decode at all must be the one encoding of the frame they
/// decode to: encoding it again gives the same bytes back.
fn assert_decodes_safely(bytes: &[u8]) -> bool {
    let Ok(Some((frame, used))) = decode(bytes) else {
        return false;
    };
    assert!(used <= bytes.len());
    assert_eq!(
        encoded(&frame),
        &bytes[..used],
        "a second encoding of {frame:?}"
    );
    true
}

/// Whatever the bytes, the decoder answers: it does not panic, read out of
/// bounds or accept a frame it could not have encoded itself.
#[test]
fn the_decoder_never_panics() {
    let mut rng = Rng(5);
    let kinds = [
        0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x10, 0x11, 0x12, 0x13, 0x14, 0x15,
    ];
    let mut accepted = 0;
    for _ in 0..20_000 {
        // Any bytes at all. Most stop at the header checks.
        let length = rng.range(0, 64) as usize;
        accepted += usize::from(assert_decodes_safely(&rng.bytes(length)));

        // A header that passes, in front of any payload: this reaches every payload layout.
        let kind: u8 = rng.pick(&kinds);
        let other_length = rng.range(0, 600) as usize;
        let length = rng.pick(&[0, 1, 2, 4, 8, 9, 23, 24, 35, 40, other_length]);
        let mut wire = vec![kind, 0, 0, 0, 0, u8::from(kind >= 0x10)];
        wire.extend_from_slice(&(length as u16).to_be_bytes());
        wire.extend(rng.bytes(length));
        accepted += usize::from(assert_decodes_safely(&wire));

        // A valid frame with one byte changed, or cut short, or with a byte added.
        let mut wire = encoded(&valid_frame(&mut rng));
        let at = rng.range(0, wire.len() as u64 - 1) as usize;
        match rng.range(0, 2) {
            0 => wire[at] = rng.next() as u8,
            1 => wire.truncate(at),
            _ => wire.insert(at, rng.next() as u8),
        }
        accepted += usize::from(assert_decodes_safely(&wire));
    }
    // The loop is only worth something if a fair share of its inputs get past the header.
    assert!(accepted > 1000, "only {accepted} inputs decoded");
}

#[test]
fn a_header_alone_is_enough_to_refuse_a_frame() {
    // DATA on stream 1 announcing 16385 bytes: refused with no payload in sight.
    let header = [0x12, 0, 0, 0, 0, 1, 0x40, 0x01];
    assert_eq!(header.len(), HEADER_LEN);
    assert_eq!(
        decode(&header).unwrap_err().to_string(),
        "frame_too_large",
        "the header checks must not wait for the payload"
    );
}
