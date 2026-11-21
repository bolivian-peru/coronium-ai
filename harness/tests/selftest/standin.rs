//! A stand-in for the edge and the relay. It lives here only until the real
//! ones exist, and is deleted then.
//!
//! Toward simulated devices it is the relay side of the protocol, and it puts
//! every frame a device sends to the proto crate's rule checker. Toward the
//! load generator it is an HTTP proxy: each CONNECT becomes an OPEN on a
//! device, and bytes move both ways under the credit rules. It also plays the
//! meter: it counts DATA payload bytes in each direction, which is what
//! PROTOCOL.md section 11 says an edge counts.

use std::collections::HashMap;
use std::net::SocketAddr;
use std::sync::atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use bytes::Bytes;
use coronium_proto::frame::{Frame, Id, MAX_PAYLOAD, ResetCode, Role, Target, VERSION};
use coronium_proto::io::{FrameReader, FrameWriter, ReadError};
use coronium_proto::session::{Link, Session, Side, Verdict};
use tokio::io::{AsyncReadExt, AsyncWriteExt};
use tokio::net::tcp::OwnedWriteHalf;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::mpsc;

/// The only `Proxy-Authorization` value the stand-in lets through.
pub const AUTHORIZATION: &str = "Bearer made-up-for-the-self-test";

/// The smallest window the protocol allows, so that a modest body is enough
/// to make a device wait for WINDOW.
pub const INITIAL_WINDOW: u32 = 16384;

/// The shortest keepalive the protocol allows, so that devices send PING
/// within a test of a few seconds.
const KEEPALIVE_MS: u32 = 1000;

pub struct Standin {
    /// Where devices dial.
    pub relay: SocketAddr,
    /// Where the load generator sends CONNECT.
    pub proxy: SocketAddr,
    shared: Arc<Shared>,
}

#[derive(Default)]
struct Shared {
    devices: Mutex<Vec<Arc<Device>>>,
    /// Which device the next CONNECT is offered to first.
    turn: AtomicUsize,
    /// The meter: DATA payload bytes toward devices, and from them.
    bytes_up: AtomicU64,
    bytes_down: AtomicU64,
    /// Every rule a device broke.
    violations: Mutex<Vec<String>>,
    /// Every rule the stand-in broke itself. A test that passes with one of
    /// these has proved nothing.
    faults: Mutex<Vec<String>>,
    corrupt_next: AtomicBool,
}

/// One connected device.
struct Device {
    id: Id,
    max_streams: usize,
    link: Mutex<DeviceLink>,
}

struct DeviceLink {
    session: Session,
    /// Frames on their way to the device. `None` once the stand-in hung up.
    out: Option<mpsc::UnboundedSender<Frame>>,
    next_stream: u32,
    /// Where the frames of each open stream go.
    streams: HashMap<u32, mpsc::UnboundedSender<Frame>>,
}

impl Standin {
    pub async fn start() -> Self {
        let relay = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let proxy = TcpListener::bind("127.0.0.1:0").await.unwrap();
        let standin = Self {
            relay: relay.local_addr().unwrap(),
            proxy: proxy.local_addr().unwrap(),
            shared: Arc::default(),
        };
        tokio::spawn(accept(relay, standin.shared.clone(), serve_device));
        tokio::spawn(accept(proxy, standin.shared.clone(), serve_buyer));
        standin
    }

    /// Waits until `count` devices are connected.
    pub async fn devices(&self, count: usize) {
        while self.shared.devices.lock().unwrap().len() < count {
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
    }

    /// The DATA payload bytes counted toward devices and from them.
    pub fn metered(&self) -> (u64, u64) {
        let up = self.shared.bytes_up.load(Ordering::Relaxed);
        let down = self.shared.bytes_down.load(Ordering::Relaxed);
        (up, down)
    }

    /// The rules devices broke, then the rules the stand-in broke.
    pub fn violations(&self) -> (Vec<String>, Vec<String>) {
        let violations = self.shared.violations.lock().unwrap().clone();
        let faults = self.shared.faults.lock().unwrap().clone();
        (violations, faults)
    }

    /// Flips one bit in the next DATA frame a device sends, on its way to the
    /// buyer.
    pub fn corrupt_one_byte(&self) {
        self.shared.corrupt_next.store(true, Ordering::Relaxed);
    }

    /// Closes every device connection, as a relay does when it stops.
    pub fn hang_up(&self) {
        for device in self.shared.devices.lock().unwrap().iter() {
            device.link.lock().unwrap().out = None;
        }
    }
}

async fn accept<F>(
    listener: TcpListener,
    shared: Arc<Shared>,
    serve: fn(TcpStream, Arc<Shared>) -> F,
) where
    F: Future<Output = ()> + Send + 'static,
{
    loop {
        let (socket, _) = listener.accept().await.unwrap();
        socket.set_nodelay(true).unwrap();
        tokio::spawn(serve(socket, shared.clone()));
    }
}

/// A frame, short enough to put in a message.
fn brief(frame: &Frame) -> String {
    let mut text = format!("{frame:?}");
    text.truncate(120);
    text
}

impl Shared {
    /// Notes a rule a device broke.
    fn violation(&self, text: String) {
        self.violations.lock().unwrap().push(text);
    }

    /// Opens a stream on the next device that has room for one.
    fn open(
        &self,
        to_buyer: &mpsc::UnboundedSender<Frame>,
        target: &Target,
        port: u16,
    ) -> Option<(Arc<Device>, u32)> {
        let devices = self.devices.lock().unwrap();
        let first = self.turn.fetch_add(1, Ordering::Relaxed);
        (0..devices.len()).find_map(|step| {
            let device = &devices[(first + step) % devices.len()];
            let stream = device.open(self, to_buyer.clone(), target.clone(), port)?;
            Some((device.clone(), stream))
        })
    }
}

impl Device {
    /// Sends a frame to the device.
    fn send(&self, shared: &Shared, frame: Frame) {
        self.link.lock().unwrap().queue(shared, frame);
    }

    /// Opens a stream, unless the device is carrying all it said it would.
    fn open(
        &self,
        shared: &Shared,
        to_buyer: mpsc::UnboundedSender<Frame>,
        target: Target,
        port: u16,
    ) -> Option<u32> {
        let mut link = self.link.lock().unwrap();
        if link.streams.len() >= self.max_streams {
            return None;
        }
        // The id is taken and the OPEN queued under one lock, so that ids
        // reach the wire in increasing order.
        let stream = link.next_stream;
        link.next_stream += 1;
        link.streams.insert(stream, to_buyer);
        let open = Frame::Open {
            stream,
            device: self.id,
            target,
            port,
        };
        link.queue(shared, open);
        Some(stream)
    }

    /// Frees the place of a stream that is over.
    fn forget(&self, stream: u32) {
        self.link.lock().unwrap().streams.remove(&stream);
    }
}

impl DeviceLink {
    /// Queues a frame for the device. The checker sees it here, under the
    /// lock that orders the queue, so it sees the stand-in's frames in the
    /// order they reach the wire and never after the device could have
    /// answered them.
    fn queue(&mut self, shared: &Shared, frame: Frame) {
        let Some(out) = &self.out else {
            return;
        };
        let verdict = self.session.check(Side::Relay, &frame);
        if !matches!(verdict, Verdict::Ok | Verdict::Ignored) {
            let fault = format!("{verdict} on {}", brief(&frame));
            shared.faults.lock().unwrap().push(fault);
        }
        let _ = out.send(frame);
    }
}

async fn write_frames(
    mut writer: FrameWriter<OwnedWriteHalf>,
    mut frames: mpsc::UnboundedReceiver<Frame>,
) {
    while let Some(frame) = frames.recv().await {
        if writer.write_frame(&frame).await.is_err() {
            return;
        }
    }
}

/// The relay side of one device connection.
async fn serve_device(socket: TcpStream, shared: Arc<Shared>) {
    let (read_half, write_half) = socket.into_split();
    let mut reader = FrameReader::new(read_half);
    let mut session = Session::new(Link::Device);

    let hello = match reader.read_frame().await {
        Ok(Some(frame)) => frame,
        other => return shared.violation(format!("a device sent no HELLO: {other:?}")),
    };
    let verdict = session.check(Side::Dialer, &hello);
    let Frame::Hello {
        role: Role::Device,
        id,
        max_streams,
        ..
    } = hello
    else {
        return shared.violation(format!(
            "{verdict} on a first frame that is no device HELLO"
        ));
    };
    if verdict != Verdict::Ok {
        return shared.violation(format!("{verdict} on HELLO"));
    }

    let (out, frames) = mpsc::unbounded_channel();
    tokio::spawn(write_frames(FrameWriter::new(write_half), frames));
    let device = Arc::new(Device {
        id,
        max_streams: max_streams.into(),
        link: Mutex::new(DeviceLink {
            session,
            out: Some(out),
            next_stream: 1,
            streams: HashMap::new(),
        }),
    });
    device.send(
        &shared,
        Frame::Welcome {
            version: VERSION,
            keepalive_ms: KEEPALIVE_MS,
            initial_window: INITIAL_WINDOW,
        },
    );
    shared.devices.lock().unwrap().push(device.clone());

    loop {
        let frame = match reader.read_frame().await {
            Ok(Some(frame)) => frame,
            Err(ReadError::Protocol(error)) => {
                break shared.violation(format!("a frame that does not decode: {error}"));
            }
            // The device is gone.
            Ok(None) | Err(ReadError::Io(_)) => break,
        };
        let (verdict, to_buyer) = {
            let mut link = device.link.lock().unwrap();
            let verdict = link.session.check(Side::Dialer, &frame);
            (verdict, link.streams.get(&frame.stream()).cloned())
        };
        match verdict {
            Verdict::Ok => match frame {
                Frame::Ping { payload } => device.send(&shared, Frame::Pong { payload }),
                // The stand-in sends no PING, and a device may leave when it likes.
                Frame::Pong { .. } | Frame::GoAway { .. } => {}
                on_stream => forward(to_buyer, on_stream),
            },
            Verdict::Ignored => {}
            Verdict::StreamError(code) => {
                shared.violation(format!("{verdict} on {}", brief(&frame)));
                let reset = Frame::Reset {
                    stream: frame.stream(),
                    code,
                };
                device.send(&shared, reset.clone());
                forward(to_buyer, reset);
            }
            Verdict::ConnectionError(_) => {
                break shared.violation(format!("{verdict} on {}", brief(&frame)));
            }
        }
    }
    shared
        .devices
        .lock()
        .unwrap()
        .retain(|other| !Arc::ptr_eq(other, &device));
    // Dropping the senders closes the connection, and tells every buyer on
    // this device that it is gone.
    let mut link = device.link.lock().unwrap();
    link.out = None;
    link.streams.clear();
}

/// Passes a frame to the buyer of its stream, if the stream still has one.
/// Never awaited: credit bounds what a stream can have queued.
fn forward(to_buyer: Option<mpsc::UnboundedSender<Frame>>, frame: Frame) {
    if let Some(to_buyer) = to_buyer {
        let _ = to_buyer.send(frame);
    }
}

async fn answer(socket: &mut TcpStream, status: &str) {
    let response = format!("HTTP/1.1 {status}\r\nContent-Length: 0\r\n\r\n");
    let _ = socket.write_all(response.as_bytes()).await;
}

/// The edge side of one buyer connection: one CONNECT, one stream.
async fn serve_buyer(mut socket: TcpStream, shared: Arc<Shared>) {
    let mut head = Vec::new();
    let mut piece = [0; 1024];
    while !head.ends_with(b"\r\n\r\n") {
        match socket.read(&mut piece).await {
            Ok(count) if count > 0 && head.len() < 4096 => head.extend_from_slice(&piece[..count]),
            _ => return,
        }
    }
    let head = String::from_utf8_lossy(&head);
    let mut lines = head.split("\r\n");
    let target = lines
        .next()
        .and_then(|line| line.strip_prefix("CONNECT ")?.strip_suffix(" HTTP/1.1"))
        .and_then(|target| target.rsplit_once(':'))
        .and_then(|(name, port)| Some((Target::Name(name.to_owned()), port.parse().ok()?)));
    let Some((target, port)) = target else {
        return answer(&mut socket, "400 Bad Request").await;
    };
    if !lines.any(|line| line.strip_prefix("Proxy-Authorization: ") == Some(AUTHORIZATION)) {
        return answer(&mut socket, "407 Proxy Authentication Required").await;
    }

    let (to_buyer, mut from_device) = mpsc::unbounded_channel();
    let Some((device, stream)) = shared.open(&to_buyer, &target, port) else {
        return answer(&mut socket, "503 Service Unavailable").await;
    };
    // The device's table now holds the only sender, so the channel closes
    // when the device goes.
    drop(to_buyer);
    let carried = carry(&shared, &device, stream, &mut socket, &mut from_device).await;
    if !carried {
        // Section 9: the other end of the stream went away.
        let code = ResetCode::CANCELLED;
        device.send(&shared, Frame::Reset { stream, code });
    }
    device.forget(stream);
}

/// Moves bytes between a buyer and a stream until both sides have ended.
/// `false` means the stream was left open and must be reset.
async fn carry(
    shared: &Shared,
    device: &Device,
    stream: u32,
    socket: &mut TcpStream,
    from_device: &mut mpsc::UnboundedReceiver<Frame>,
) -> bool {
    match from_device.recv().await {
        Some(Frame::Opened { .. }) => {}
        // RESET, or the device is gone: the stream is over already.
        _ => {
            answer(socket, "502 Bad Gateway").await;
            return true;
        }
    }
    if socket
        .write_all(b"HTTP/1.1 200 Connection established\r\n\r\n")
        .await
        .is_err()
    {
        return false;
    }

    let (mut from_buyer, mut to_buyer) = socket.split();
    let mut piece = vec![0; MAX_PAYLOAD];
    // The DATA bytes that may still be sent to the device.
    let mut credit = INITIAL_WINDOW as usize;
    let mut buyer_ended = false;
    let mut device_ended = false;
    while !(buyer_ended && device_ended) {
        tokio::select! {
            read = from_buyer.read(&mut piece[..credit.min(MAX_PAYLOAD)]), if !buyer_ended && credit > 0 => {
                let Ok(count) = read else {
                    return false;
                };
                if count == 0 {
                    buyer_ended = true;
                    device.send(shared, Frame::End { stream });
                    continue;
                }
                credit -= count;
                shared.bytes_up.fetch_add(count as u64, Ordering::Relaxed);
                let payload = Bytes::copy_from_slice(&piece[..count]);
                device.send(shared, Frame::Data { stream, payload });
            }
            frame = from_device.recv() => match frame {
                Some(Frame::Data { mut payload, .. }) => {
                    shared.bytes_down.fetch_add(payload.len() as u64, Ordering::Relaxed);
                    if shared.corrupt_next.swap(false, Ordering::Relaxed) {
                        let mut corrupt = payload.to_vec();
                        // The last byte of a frame is body whenever the frame
                        // holds any body, since the head goes first.
                        *corrupt.last_mut().unwrap() ^= 1;
                        payload = corrupt.into();
                    }
                    if to_buyer.write_all(&payload).await.is_err() {
                        return false;
                    }
                    // Credit goes back once the bytes have left for the buyer.
                    let credit = payload.len() as u32;
                    device.send(shared, Frame::Window { stream, credit });
                }
                Some(Frame::Window { credit: more, .. }) => credit += more as usize,
                Some(Frame::End { .. }) => {
                    device_ended = true;
                    // A buyer that has its answer may be gone already. Its
                    // own end of the stream is noticed by the read above.
                    let _ = to_buyer.shutdown().await;
                }
                // RESET, or the device is gone: the stream is over already.
                _ => return true,
            }
        }
    }
    true
}
