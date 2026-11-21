//! The vectors of PROTOCOL.md section 12, enforced for every entry.
//!
//! The expected results in the vector files come from PROTOCOL.md. When this
//! test fails, the code is wrong until PROTOCOL.md says otherwise.

use std::collections::HashSet;
use std::net::{Ipv4Addr, Ipv6Addr};
use std::path::Path;

use bytes::Bytes;
use coronium_proto::frame::{
    Credential, Frame, GoAwayCode, RefuseCode, ResetCode, Role, Target, VERSION, decode,
};
use coronium_proto::session::{Link, Session, Side};
use serde::Deserialize;
use serde::de::DeserializeOwned;

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FramesFile {
    protocol_version: u8,
    frames: Vec<FrameVector>,
    refused: Vec<RefusedVector>,
    incomplete: Vec<IncompleteVector>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct FrameVector {
    name: String,
    hex: String,
    frame: FrameJson,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RefusedVector {
    name: String,
    hex: String,
    error: String,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct IncompleteVector {
    name: String,
    hex: String,
}

/// The `frame` object of section 12.1.
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase", deny_unknown_fields)]
enum FrameJson {
    Hello {
        version_min: u8,
        version_max: u8,
        role: String,
        id: String,
        max_streams: u16,
        credential: String,
        software: String,
    },
    Welcome {
        version: u8,
        keepalive_ms: u32,
        initial_window: u32,
    },
    Refuse {
        code: u16,
        retry_after_ms: u32,
        cause: String,
        fix: String,
    },
    Ping {
        payload: String,
    },
    Pong {
        payload: String,
    },
    Goaway {
        code: u16,
        reconnect_after_ms: u32,
        cause: String,
    },
    Open {
        stream: u32,
        device: String,
        target_kind: String,
        target: String,
        port: u16,
    },
    Opened {
        stream: u32,
    },
    Data {
        stream: u32,
        payload: String,
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
        code: u16,
    },
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SessionsFile {
    protocol_version: u8,
    sessions: Vec<SessionVector>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct SessionVector {
    name: String,
    link: String,
    steps: Vec<Step>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct Step {
    from: String,
    hex: String,
    expect: String,
}

/// Reads a JSON file of this crate, named from the crate's own directory.
fn load<T: DeserializeOwned>(file: &str) -> T {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(file);
    let text = std::fs::read_to_string(&path)
        .unwrap_or_else(|error| panic!("{}: {error}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|error| panic!("{}: {error}", path.display()))
}

/// Section 12.1 writes bytes as lower-case hex, so upper case is a fault in the file.
fn unhex(hex: &str) -> Vec<u8> {
    let bytes = hex::decode(hex).unwrap_or_else(|error| panic!("{hex}: {error}"));
    assert_eq!(hex::encode(&bytes), hex, "hex must be lower case");
    bytes
}

fn unhex_array<const N: usize>(hex: &str) -> [u8; N] {
    unhex(hex)
        .try_into()
        .unwrap_or_else(|_| panic!("{hex} is not {N} bytes"))
}

fn frame_of(json: &FrameJson) -> Frame {
    match json {
        FrameJson::Hello {
            version_min,
            version_max,
            role,
            id,
            max_streams,
            credential,
            software,
        } => Frame::Hello {
            version_min: *version_min,
            version_max: *version_max,
            role: match role.as_str() {
                "device" => Role::Device,
                "edge" => Role::Edge,
                other => panic!("unknown role {other}"),
            },
            id: unhex_array(id),
            max_streams: *max_streams,
            credential: Credential(unhex(credential)),
            software: software.clone(),
        },
        FrameJson::Welcome {
            version,
            keepalive_ms,
            initial_window,
        } => Frame::Welcome {
            version: *version,
            keepalive_ms: *keepalive_ms,
            initial_window: *initial_window,
        },
        FrameJson::Refuse {
            code,
            retry_after_ms,
            cause,
            fix,
        } => Frame::Refuse {
            code: RefuseCode::new(*code).expect("a frame in `frames` has a non-zero code"),
            retry_after_ms: *retry_after_ms,
            cause: cause.clone(),
            fix: fix.clone(),
        },
        FrameJson::Ping { payload } => Frame::Ping {
            payload: unhex_array(payload),
        },
        FrameJson::Pong { payload } => Frame::Pong {
            payload: unhex_array(payload),
        },
        FrameJson::Goaway {
            code,
            reconnect_after_ms,
            cause,
        } => Frame::GoAway {
            code: GoAwayCode::new(*code).expect("a frame in `frames` has a non-zero code"),
            reconnect_after_ms: *reconnect_after_ms,
            cause: cause.clone(),
        },
        FrameJson::Open {
            stream,
            device,
            target_kind,
            target,
            port,
        } => Frame::Open {
            stream: *stream,
            device: unhex_array(device),
            target: match target_kind.as_str() {
                "name" => Target::Name(target.clone()),
                "ipv4" => Target::Ipv4(Ipv4Addr::from(unhex_array::<4>(target))),
                "ipv6" => Target::Ipv6(Ipv6Addr::from(unhex_array::<16>(target))),
                other => panic!("unknown target_kind {other}"),
            },
            port: *port,
        },
        FrameJson::Opened { stream } => Frame::Opened { stream: *stream },
        FrameJson::Data { stream, payload } => Frame::Data {
            stream: *stream,
            payload: Bytes::from(unhex(payload)),
        },
        FrameJson::Window { stream, credit } => Frame::Window {
            stream: *stream,
            credit: *credit,
        },
        FrameJson::End { stream } => Frame::End { stream: *stream },
        FrameJson::Reset { stream, code } => Frame::Reset {
            stream: *stream,
            code: ResetCode::new(*code).expect("a frame in `frames` has a non-zero code"),
        },
    }
}

fn assert_unique<'a>(names: impl Iterator<Item = &'a String>) {
    let mut seen = HashSet::new();
    for name in names {
        assert!(seen.insert(name), "two entries are named {name}");
    }
}

#[test]
fn frames_decode_and_encode_both_ways() {
    let file: FramesFile = load("vectors/frames.json");
    assert_eq!(file.protocol_version, VERSION);
    assert_unique(file.frames.iter().map(|vector| &vector.name));
    for vector in &file.frames {
        let wire = unhex(&vector.hex);
        let frame = frame_of(&vector.frame);
        assert_eq!(
            decode(&wire),
            Ok(Some((frame.clone(), wire.len()))),
            "decoding {}",
            vector.name
        );
        let mut encoded = Vec::new();
        assert_eq!(
            frame.encode(&mut encoded),
            Ok(()),
            "encoding {}",
            vector.name
        );
        assert_eq!(hex::encode(encoded), vector.hex, "encoding {}", vector.name);
    }
}

#[test]
fn every_strict_prefix_of_a_frame_is_incomplete() {
    let file: FramesFile = load("vectors/frames.json");
    for vector in &file.frames {
        let wire = unhex(&vector.hex);
        for length in 0..wire.len() {
            assert_eq!(
                decode(&wire[..length]),
                Ok(None),
                "{} cut to {length} bytes",
                vector.name
            );
        }
    }
}

#[test]
fn refused_frames_give_their_connection_error() {
    let file: FramesFile = load("vectors/frames.json");
    assert_unique(file.refused.iter().map(|vector| &vector.name));
    for vector in &file.refused {
        let error = decode(&unhex(&vector.hex)).expect_err(&vector.name);
        assert_eq!(error.to_string(), vector.error, "{}", vector.name);
    }
}

#[test]
fn incomplete_frames_are_incomplete() {
    let file: FramesFile = load("vectors/frames.json");
    assert_unique(file.incomplete.iter().map(|vector| &vector.name));
    for vector in &file.incomplete {
        assert_eq!(decode(&unhex(&vector.hex)), Ok(None), "{}", vector.name);
    }
}

#[test]
fn sessions_get_the_expected_verdict_at_every_step() {
    assert_verdicts(&load("vectors/sessions.json"));
}

/// Feeds each session to a fresh checker, as section 12.2 describes.
fn assert_verdicts(file: &SessionsFile) {
    assert_eq!(file.protocol_version, VERSION);
    assert_unique(file.sessions.iter().map(|vector| &vector.name));
    for vector in &file.sessions {
        let link = match vector.link.as_str() {
            "device" => Link::Device,
            "edge" => Link::Edge,
            other => panic!("{}: unknown link {other}", vector.name),
        };
        let mut session = Session::new(link);
        let mut over = false;
        for (index, step) in vector.steps.iter().enumerate() {
            let at = format!("{} step {index}", vector.name);
            assert!(!over, "{at}: a session ends at its first connection error");
            let side = match step.from.as_str() {
                "dialer" => Side::Dialer,
                "relay" => Side::Relay,
                other => panic!("{at}: unknown side {other}"),
            };
            let wire = unhex(&step.hex);
            let (frame, used) = decode(&wire)
                .unwrap_or_else(|error| panic!("{at}: {error}"))
                .unwrap_or_else(|| panic!("{at}: incomplete"));
            assert_eq!(used, wire.len(), "{at}: a step is one whole frame");
            assert_eq!(session.check(side, &frame).to_string(), step.expect, "{at}");
            over = step.expect.starts_with("connection_error:");
        }
    }
}

/// The files must keep covering what they were written to cover, so losing
/// entries, a frame type, an error or a link fails here and not unnoticed.
#[test]
fn the_vectors_cover_every_frame_type_error_and_verdict() {
    let frames: FramesFile = load("vectors/frames.json");
    let sessions: SessionsFile = load("vectors/sessions.json");
    assert!(frames.frames.len() >= 60, "{} frames", frames.frames.len());
    assert!(
        frames.refused.len() >= 80,
        "{} refused",
        frames.refused.len()
    );
    assert!(
        frames.incomplete.len() >= 10,
        "{} incomplete",
        frames.incomplete.len()
    );
    assert!(
        sessions.sessions.len() >= 60,
        "{} sessions",
        sessions.sessions.len()
    );

    let types: HashSet<u8> = frames
        .frames
        .iter()
        .map(|vector| unhex(&vector.hex)[0])
        .collect();
    assert_eq!(types.len(), 12, "frame types in `frames`: {types:?}");

    let errors: HashSet<&str> = frames
        .refused
        .iter()
        .map(|vector| vector.error.as_str())
        .collect();
    let decoder_errors = [
        "unknown_frame",
        "bad_flags",
        "frame_too_large",
        "bad_stream_id",
        "bad_payload",
    ];
    assert_eq!(errors, HashSet::from(decoder_errors));

    for link in ["device", "edge"] {
        let verdicts: HashSet<&str> = sessions
            .sessions
            .iter()
            .filter(|vector| vector.link == link)
            .flat_map(|vector| &vector.steps)
            .map(|step| step.expect.as_str())
            .collect();
        let mut expected = HashSet::from([
            "ok",
            "ignored",
            "connection_error:unexpected_frame",
            "connection_error:bad_stream_id",
            "stream_error:protocol",
            "stream_error:flow_control",
        ]);
        if link == "device" {
            // Section 7 rules 7 and 8 exist on a device link only.
            expected.extend(["stream_error:too_many_streams", "stream_error:going_away"]);
        }
        assert_eq!(verdicts, expected, "verdicts on the {link} link");
    }
}
