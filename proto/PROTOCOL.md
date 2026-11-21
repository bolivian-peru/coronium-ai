# Coronium wire protocol, version 1

This is the protocol spoken between a device agent and a relay, and between an
edge and a relay. It is published so that anyone can write or modify an agent
and stay compatible: an implementation conforms when it passes every vector in
[`vectors/`](./vectors) and follows the rules in this document.

The words "must" and "must not" are requirements. Everything else is advice.

## 1. Links and roles

| Link | Dialer | Listener | Who opens streams |
|---|---|---|---|
| device link | agent on a device | relay | the relay |
| edge link | edge | relay | the edge |

Both links carry the same frames. The side that opens streams is called the
**opener**; the other side is the **acceptor**. On a device link the relay is
the opener and the device is the acceptor. On an edge link the edge is the
opener and the relay is the acceptor.

A relay joins the two links: it takes a stream an edge opened, opens a stream
to the named device, and forwards frames both ways (section 9).

The transport is TLS 1.3 over TCP. Plain TCP is allowed only on a loopback
address, for tests. The protocol needs nothing from the transport except an
ordered, reliable byte stream.

## 2. Conventions

- All integers are unsigned and big-endian. `u8`, `u16`, `u32` are 1, 2 and 4 bytes.
- `id` is 16 opaque bytes. It is written as 32 lowercase hex digits.
- `bytes8` is a length-prefixed byte string: one `u8` length, then that many bytes.
- `text8` is a `bytes8` whose content is UTF-8 with no control characters
  (no code point below U+0020 and not U+007F).
- Every frame has exactly one encoding. A decoder must refuse anything else.

## 3. Frames

```
 0      1      2                  6          8
+------+------+------------------+----------+=================+
| type | flags|    stream id     |  length  |     payload     |
|  u8  |  u8  |       u32        |   u16    |  length bytes   |
+------+------+------------------+----------+=================+
```

- `flags` must be zero in version 1.
- `length` is the payload length and must not exceed **16384**.
- `stream id` is zero on connection frames and non-zero on stream frames.

| Type | Name | Stream id | Sent by | Payload |
|---|---|---|---|---|
| `0x01` | HELLO | 0 | dialer | section 4.1 |
| `0x02` | WELCOME | 0 | relay | section 4.2 |
| `0x03` | REFUSE | 0 | relay | section 4.3 |
| `0x04` | PING | 0 | either | 8 bytes |
| `0x05` | PONG | 0 | either | 8 bytes |
| `0x06` | GOAWAY | 0 | either | section 4.4 |
| `0x10` | OPEN | n | opener | section 5.1 |
| `0x11` | OPENED | n | acceptor | empty |
| `0x12` | DATA | n | either | 1 to 16384 bytes |
| `0x13` | WINDOW | n | either | `u32` credit, 1 to 2147483647 |
| `0x14` | END | n | either | empty |
| `0x15` | RESET | n | either | `u16` code, not zero (section 8.2) |

### 3.1 Decoding

A decoder is given the bytes received so far and returns exactly one of:

- a **frame** and the number of bytes it used,
- **incomplete**: more bytes are needed and nothing is wrong yet,
- a **connection error** (section 8.1).

It must check in this order and stop at the first failure:

1. Fewer than 8 bytes: incomplete.
2. `type` is not in the table: `unknown_frame`.
3. `flags` is not zero: `bad_flags`.
4. `length` is above 16384: `frame_too_large`.
5. `stream id` is not zero on a connection frame, or is zero on a stream frame: `bad_stream_id`.
6. Fewer than `8 + length` bytes: incomplete.
7. The payload does not match its layout exactly: `bad_payload`. This covers a
   wrong length, bytes left over, a value outside its stated range, and text
   that is not valid `text8`.

Steps 2 to 5 use only the header, so an oversized or unknown frame is refused
before its payload is buffered.

## 4. Connection frames

### 4.1 HELLO

The first frame on every connection, sent by the dialer.

| Field | Type | Rule |
|---|---|---|
| `version_min` | `u8` | at least 1 |
| `version_max` | `u8` | at least `version_min` |
| `role` | `u8` | 1 = device, 2 = edge |
| `id` | `id` | the device id or the edge node id |
| `max_streams` | `u16` | device: 1 to 1024, the most streams it will carry at once. edge: 0 |
| `credential` | `bytes8` | 1 to 255 bytes, opaque |
| `software` | `text8` | 0 to 64 bytes, printable ASCII only (0x20 to 0x7e), for example `agent/0.1.0` |

### 4.2 WELCOME

The relay accepts the connection.

| Field | Type | Rule |
|---|---|---|
| `version` | `u8` | at least 1; the version in use from now on |
| `keepalive_ms` | `u32` | 1000 to 600000 |
| `initial_window` | `u32` | 16384 to 1048576 |

The relay picks the highest version both sides support. A dialer sets
`version_max` to the highest version it implements. A relay answers a HELLO
whose role does not fit the listener with REFUSE `wrong_role`.

### 4.3 REFUSE

The relay refuses the connection and then closes it. A refusal always says why
and what to do.

| Field | Type | Rule |
|---|---|---|
| `code` | `u16` | not zero (section 8.3) |
| `retry_after_ms` | `u32` | 0 means retrying will not help until the cause is fixed |
| `cause` | `text8` | 1 to 255 bytes |
| `fix` | `text8` | 1 to 255 bytes |

### 4.4 GOAWAY

The sender is leaving. It opens no more streams and asks the other side to do
the same. Streams already open continue until they end or the connection closes.

| Field | Type | Rule |
|---|---|---|
| `code` | `u16` | not zero (section 8.4) |
| `reconnect_after_ms` | `u32` | how long the dialer should wait before it dials again |
| `cause` | `text8` | 0 to 255 bytes |

## 5. Stream frames

### 5.1 OPEN

Asks the device to connect to a target over TCP.

| Field | Type | Rule |
|---|---|---|
| `device` | `id` | the device that must carry the stream |
| `kind` | `u8` | 1 = name, 2 = IPv4, 3 = IPv6 |
| `address` | by kind | name: `bytes8`, 1 to 253 bytes. IPv4: 4 bytes. IPv6: 16 bytes |
| `port` | `u16` | not zero |

A name must use only `a-z`, `0-9`, `-`, `_` and `.`, must not start or end
with `.`, must not contain an empty label or a label longer than 63 bytes, and
its last label must not be all digits (such a target is sent as an address).
Upper case is refused: the opener lowercases names before sending.

The device resolves names itself, on its own network.

### 5.2 The others

- **OPENED**: the device is connected to the target. Empty payload.
- **DATA**: bytes for the other end of the stream. Never empty.
- **WINDOW**: lets the other side send that many more DATA bytes on this stream.
- **END**: the sender will send no more DATA on this stream. Empty payload.
- **RESET**: the stream is over in both directions, with a reason code.

## 6. Connection rules

A connection error (section 8.1) ends the connection: the side that detects it
sends GOAWAY with code `protocol_error` and a cause that starts with the error
name, then closes. Before WELCOME, or when it has already sent GOAWAY, it
closes without sending one.

When a frame breaks more than one rule, the rule that comes first in this
document names the error: a rule of this section before a rule of section 7,
and a lower-numbered rule before a higher one.

1. The dialer sends HELLO first. Any other first frame, or any frame from the
   relay before HELLO, is `unexpected_frame`.
2. After HELLO the dialer sends nothing until the relay answers. The relay
   answers with exactly one WELCOME or REFUSE. A second HELLO, a second
   WELCOME, a WELCOME from the dialer, a HELLO from the relay, or any frame
   other than WELCOME or REFUSE while the answer is pending, is `unexpected_frame`.
3. `WELCOME.version` must lie between `version_min` and `version_max`.
   Otherwise `unexpected_frame`.
4. After REFUSE no more frames are sent. Any frame after it is `unexpected_frame`.
5. PING may be sent by either side after WELCOME. A side must not send a
   second PING while its first is unanswered (`unexpected_frame`). The receiver
   answers with a PONG carrying the same 8 bytes. A PONG that does not answer
   the other side's outstanding PING with the same bytes is `unexpected_frame`.
6. GOAWAY may be sent once by each side after WELCOME. A second GOAWAY from
   the same side is `unexpected_frame`. An opener must not send OPEN after it
   has sent GOAWAY (`unexpected_frame`).
7. OPEN is sent only by the opener and OPENED only by the acceptor. The
   reverse is `unexpected_frame`. Stream frames before WELCOME are
   `unexpected_frame`.
8. Stream ids in OPEN must increase: each OPEN uses an id greater than every
   earlier OPEN on the connection. An id that does not is `bad_stream_id`. Any
   other stream frame whose id is greater than the highest OPEN so far is
   `bad_stream_id`.
   An opener that has used id 4294967295 opens no more streams on that
   connection: it sends GOAWAY and the dialer dials again.

### 6.1 Timers

- The relay closes a connection that has not sent HELLO within 10 seconds. The
  dialer closes one that has not been answered within 10 seconds.
- A side that has sent nothing for `keepalive_ms` sends a PING.
- A side that has received nothing for three times `keepalive_ms` sends GOAWAY
  with code `idle_timeout` and closes.

### 6.2 Dialing again

These rules stop a broken agent from hammering the network.

- After a lost connection or a failed dial, wait a random time between 0 and
  `min(300 s, 1 s * 2^attempt)`, where `attempt` counts failures in a row and
  returns to 0 once a connection has stayed up for 60 seconds.
- After GOAWAY with `reconnect_after_ms = R`, wait `R` plus a random time
  between 0 and `max(R, 1 s)`.
- After REFUSE with `retry_after_ms = R` above zero, wait `R` plus a random
  time between 0 and `R`.
- After REFUSE with `retry_after_ms = 0`, or GOAWAY with code `replaced`, do
  not dial again for at least 15 minutes, and show the cause and fix to the owner.

## 7. Stream rules

A stream error ends one stream and leaves the connection up: the side that
detects it sends RESET with the code named below and forgets the stream.

1. A stream starts with OPEN from the opener. The opener may send DATA, END,
   WINDOW and RESET straight after OPEN, without waiting for an answer.
2. The acceptor's first frame on a stream must be OPENED or RESET. DATA, END
   or WINDOW before OPENED, or a second OPENED, is a stream error `protocol`.
3. **Credit.** Each direction of each stream starts with `initial_window`
   bytes of credit. DATA uses credit equal to its payload length. WINDOW from
   one side adds credit for the other side's DATA. DATA larger than the
   sender's remaining credit is a stream error `flow_control`. A WINDOW that
   would lift credit above 2147483647 is a stream error `flow_control`.
4. After a side sends END it must not send DATA or END on that stream again
   (stream error `protocol`). It may still send WINDOW and RESET.
5. A stream is closed when both sides have sent END, or when either side has
   sent RESET, or after a stream error.
6. A stream frame other than OPEN for a closed stream is **ignored**: frames can cross on the
   wire, so a late frame is not an error. An implementation needs no memory of
   closed streams: an id at or below the highest OPEN that is not open is closed.
7. On a device link, an OPEN that would put more than `HELLO.max_streams`
   streams open at once is a stream error `too_many_streams`. An edge link has
   no such limit in this protocol.
8. On a device link, an OPEN after the device's GOAWAY is a stream error
   `going_away`. On an edge link an OPEN after the relay's GOAWAY is allowed,
   and the relay may answer it with RESET `going_away`.

While it connects to the target, a device holds early DATA from the opener.
The credit rule bounds that to `initial_window` bytes per stream.

## 8. Errors

### 8.1 Connection errors

| Name | Meaning |
|---|---|
| `unknown_frame` | the frame type is not defined in this version |
| `bad_flags` | the flags byte is not zero |
| `frame_too_large` | the length is above 16384 |
| `bad_stream_id` | a stream id is zero, non-zero, out of order or never opened where that is not allowed |
| `bad_payload` | the payload does not match its layout |
| `unexpected_frame` | the frame is not allowed from this side or in this state |

### 8.2 RESET codes

| Code | Name | Sent when |
|---|---|---|
| 1 | `connect_refused` | the target refused the connection |
| 2 | `connect_timeout` | the target did not answer in time |
| 3 | `dns_failed` | the device could not resolve the name |
| 4 | `unreachable` | no route to the target |
| 5 | `target_blocked` | the target is one a device never dials (section 10) |
| 6 | `too_many_streams` | the device is at `max_streams` |
| 7 | `flow_control` | a credit rule was broken |
| 8 | `protocol` | a stream rule was broken |
| 9 | `cancelled` | the other end of the stream went away |
| 10 | `going_away` | the sender has sent GOAWAY |
| 11 | `device_gone` | relay to edge: the device connection was lost |
| 12 | `no_device` | relay to edge: that device is not connected to this relay |
| 13 | `io` | the connection to the target failed mid-stream |

### 8.3 REFUSE codes

| Code | Name | Meaning |
|---|---|---|
| 1 | `unsupported_version` | no version in common |
| 2 | `bad_credential` | the credential is not recognised |
| 3 | `unknown_id` | the id is not known to the network |
| 4 | `wrong_role` | this listener does not take that role |
| 5 | `busy` | the relay is admitting connections at a limited rate; retry after the stated time |

### 8.4 GOAWAY codes

| Code | Name | Meaning |
|---|---|---|
| 1 | `draining` | planned shutdown of this node |
| 2 | `protocol_error` | a connection error; the cause starts with its name |
| 3 | `idle_timeout` | nothing was received for three keepalive periods |
| 4 | `replaced` | the same id connected again elsewhere |
| 5 | `shutting_down` | the dialer is stopping |

The three code tables are open: a decoder accepts any non-zero code, and an
implementation that meets a code it does not know shows the cause text and
follows the timing rules in section 6.2.

## 9. What a relay does

- It keeps one connection per device id. A second connection with the same id
  replaces the first, which gets GOAWAY `replaced`.
- For an OPEN from an edge it finds the device named in the frame. If the
  device is not connected it answers RESET `no_device`. Otherwise it picks the
  next stream id on the device link and forwards the OPEN unchanged apart from
  the stream id.
- It forwards OPENED, DATA, WINDOW, END and RESET between the two streams,
  changing only the stream id, and enforces sections 6 and 7 on both links.
- When a device connection ends it sends RESET `device_gone` on every edge
  stream that device was carrying. When an edge connection ends it sends RESET
  `cancelled` on every device stream opened for that edge.
- It may hold an edge link to a stream limit of its own and answer an OPEN
  beyond it with RESET `too_many_streams`.
- It never blocks one device's traffic on another device: credit bounds what
  can be in flight to a device, and a device that exceeds it is reset.

## 10. What a device never dials

A device must answer OPEN with RESET `target_blocked`, without connecting,
when the target address (given directly, or after resolving a name) is:

- loopback, private (10/8, 172.16/12, 192.168/16), link-local, carrier-grade
  NAT (100.64/10), multicast, broadcast or unspecified, in IPv4;
- loopback, unique-local (fc00::/7), link-local (fe80::/10), multicast or
  unspecified, in IPv6, or an IPv4-mapped form of any address above.

The device connects to the address it checked, and does not resolve the name
a second time.

## 11. Metering

Bytes are counted in one place only: at the edge, as the sum of DATA payload
lengths in each direction of a stream. No frame carries a usage report, and
nothing a device or a relay counts has any effect on what a buyer pays or a
supplier earns.

## 12. Test vectors

### 12.1 `vectors/frames.json`

```json
{
  "protocol_version": 1,
  "frames":     [ { "name": "...", "hex": "...", "frame": { } } ],
  "refused":    [ { "name": "...", "hex": "...", "error": "bad_payload" } ],
  "incomplete": [ { "name": "...", "hex": "..." } ]
}
```

- For each entry in `frames`: decoding `hex` must give exactly `frame` and use
  every byte, and encoding `frame` must give exactly `hex`.
- For each entry in `refused`: decoding `hex` must give the connection error `error`.
- For each entry in `incomplete`: decoding `hex` must give incomplete.

The `frame` object has a `type` and these fields. Byte strings and ids are
lowercase hex; numbers are JSON integers.

| `type` | Fields |
|---|---|
| `hello` | `version_min`, `version_max`, `role` (`"device"` or `"edge"`), `id`, `max_streams`, `credential` (hex), `software` (string) |
| `welcome` | `version`, `keepalive_ms`, `initial_window` |
| `refuse` | `code`, `retry_after_ms`, `cause`, `fix` |
| `ping`, `pong` | `payload` (hex, 8 bytes) |
| `goaway` | `code`, `reconnect_after_ms`, `cause` |
| `open` | `stream`, `device`, `target_kind` (`"name"`, `"ipv4"` or `"ipv6"`), `target` (the name as a string, or the address bytes as hex), `port` |
| `opened`, `end` | `stream` |
| `data` | `stream`, `payload` (hex) |
| `window` | `stream`, `credit` |
| `reset` | `stream`, `code` |

### 12.2 `vectors/sessions.json`

```json
{
  "protocol_version": 1,
  "sessions": [
    { "name": "...", "link": "device",
      "steps": [ { "from": "dialer", "hex": "...", "expect": "ok" } ] }
  ]
}
```

`link` is `device` or `edge`. Each step is one whole frame sent by `dialer` or
`relay`, and every step decodes to a frame: bytes a decoder refuses belong in
`frames.json`. An implementation feeds the steps in order to its rule checker for
that link and must report, for each step, exactly:

- `ok`: the frame is allowed,
- `ignored`: the frame is for a closed stream (section 7, rule 6),
- `connection_error:<name>`: `unexpected_frame` or `bad_stream_id`, from the rules of section 6,
- `stream_error:<name>`: a stream error, named as in section 8.2.

A session ends at its first connection error. After a stream error that stream
is closed and the session goes on.

## 13. Worked examples

These were encoded by hand from the tables above and are also in the vector files.

| Frame | Bytes (hex) |
|---|---|
| PING, payload `00 01 02 03 04 05 06 07` | `0400000000000008` `0001020304050607` |
| HELLO, versions 1 to 1, device, id `00112233445566778899aabbccddeeff`, 32 streams, credential `secret`, software `agent/0.1.0` | `0100000000000028` `010101` `00112233445566778899aabbccddeeff` `0020` `06736563726574` `0b6167656e742f302e312e30` |
| WELCOME, version 1, keepalive 25000 ms, window 65536 | `0200000000000009` `01` `000061a8` `00010000` |
| OPEN, stream 1, that device, name `example.com`, port 443 | `100000000001001f` `00112233445566778899aabbccddeeff` `01` `0b6578616d706c652e636f6d` `01bb` |
| OPEN, stream 2, that device, IPv4 93.184.216.34, port 80 | `1000000000020017` `00112233445566778899aabbccddeeff` `02` `5db8d822` `0050` |
| OPENED, stream 1 | `1100000000010000` |
| DATA, stream 1, payload `hi` | `1200000000010002` `6869` |
| WINDOW, stream 1, credit 65536 | `1300000000010004` `00010000` |
| END, stream 1 | `1400000000010000` |
| RESET, stream 1, `target_blocked` | `1500000000010002` `0005` |
