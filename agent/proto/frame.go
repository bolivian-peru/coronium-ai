// Package proto implements version 1 of the Coronium wire protocol: the frame
// codec and the rule checker for one link. It is written from
// proto/PROTOCOL.md at the root of the repository, and the section numbers in
// its comments refer to that document.
package proto

import (
	"bytes"
	"encoding/binary"
	"errors"
	"unicode/utf8"
)

const (
	headerLen = 8

	// MaxPayload is the longest payload a frame may carry.
	MaxPayload = 16384

	// MaxCredit is the most credit one direction of a stream may hold.
	MaxCredit = 1<<31 - 1
)

// Type is a frame type (section 3).
type Type uint8

// The frame types. Connection frames come first, stream frames from 0x10.
const (
	TypeHello   Type = 0x01
	TypeWelcome Type = 0x02
	TypeRefuse  Type = 0x03
	TypePing    Type = 0x04
	TypePong    Type = 0x05
	TypeGoaway  Type = 0x06
	TypeOpen    Type = 0x10
	TypeOpened  Type = 0x11
	TypeData    Type = 0x12
	TypeWindow  Type = 0x13
	TypeEnd     Type = 0x14
	TypeReset   Type = 0x15
)

// onStream reports whether frames of type t carry a stream id. known is false
// for a type that is not in the table.
func (t Type) onStream() (carriesID, known bool) {
	switch {
	case t >= TypeHello && t <= TypeGoaway:
		return false, true
	case t >= TypeOpen && t <= TypeReset:
		return true, true
	}
	return false, false
}

// ConnError is a connection error (section 8.1). Its text is the name the
// specification gives it, which is what a GOAWAY cause has to start with.
type ConnError uint8

// The connection errors.
const (
	UnknownFrame ConnError = iota + 1
	BadFlags
	FrameTooLarge
	BadStreamID
	BadPayload
	UnexpectedFrame
)

var connErrorNames = [...]string{
	UnknownFrame:    "unknown_frame",
	BadFlags:        "bad_flags",
	FrameTooLarge:   "frame_too_large",
	BadStreamID:     "bad_stream_id",
	BadPayload:      "bad_payload",
	UnexpectedFrame: "unexpected_frame",
}

func (e ConnError) Error() string {
	if int(e) < len(connErrorNames) {
		return connErrorNames[e]
	}
	return ""
}

// ResetCode is the reason in a RESET frame (section 8.2). The table is open:
// every code except zero is valid on the wire, named here or not.
type ResetCode uint16

// The RESET codes of version 1.
const (
	ResetConnectRefused ResetCode = iota + 1
	ResetConnectTimeout
	ResetDNSFailed
	ResetUnreachable
	ResetTargetBlocked
	ResetTooManyStreams
	ResetFlowControl
	ResetProtocol
	ResetCancelled
	ResetGoingAway
	ResetDeviceGone
	ResetNoDevice
	ResetIO
)

var resetCodeNames = [...]string{
	ResetConnectRefused: "connect_refused",
	ResetConnectTimeout: "connect_timeout",
	ResetDNSFailed:      "dns_failed",
	ResetUnreachable:    "unreachable",
	ResetTargetBlocked:  "target_blocked",
	ResetTooManyStreams: "too_many_streams",
	ResetFlowControl:    "flow_control",
	ResetProtocol:       "protocol",
	ResetCancelled:      "cancelled",
	ResetGoingAway:      "going_away",
	ResetDeviceGone:     "device_gone",
	ResetNoDevice:       "no_device",
	ResetIO:             "io",
}

// String returns the name of the code, or nothing for a code this version
// does not name.
func (c ResetCode) String() string {
	if int(c) < len(resetCodeNames) {
		return resetCodeNames[c]
	}
	return ""
}

// ID is a device id or an edge node id: 16 opaque bytes.
type ID [16]byte

// Role says what kind of node a dialer is.
type Role uint8

// The roles a HELLO may carry.
const (
	RoleDevice Role = 1
	RoleEdge   Role = 2
)

// TargetKind says how an OPEN names its target.
type TargetKind uint8

// The target kinds an OPEN may carry.
const (
	TargetName TargetKind = 1
	TargetIPv4 TargetKind = 2
	TargetIPv6 TargetKind = 3
)

// Hello is the payload of HELLO (section 4.1).
type Hello struct {
	VersionMin uint8
	VersionMax uint8
	Role       Role
	ID         ID
	MaxStreams uint16
	Credential []byte
	Software   string
}

// Welcome is the payload of WELCOME (section 4.2).
type Welcome struct {
	Version       uint8
	KeepaliveMS   uint32
	InitialWindow uint32
}

// Refuse is the payload of REFUSE (section 4.3).
type Refuse struct {
	Code         uint16
	RetryAfterMS uint32
	Cause        string
	Fix          string
}

// Goaway is the payload of GOAWAY (section 4.4).
type Goaway struct {
	Code             uint16
	ReconnectAfterMS uint32
	Cause            string
}

// Open is the payload of OPEN (section 5.1). Target holds the name, or the 4
// or 16 address bytes, as Kind says.
type Open struct {
	Device ID
	Kind   TargetKind
	Target []byte
	Port   uint16
}

// Frame is one frame. Type says which of the payload fields is in use, and
// the others stay zero.
//
// Data of a decoded frame points into the buffer given to Decode. That keeps
// the data path free of copies and allocations, which matters on a router,
// and it means Data must be used or copied before that buffer is reused.
// Every other field is the frame's own copy: a device checks the target of
// an OPEN and then dials it (section 10), so the target must not change when
// the next frame is read into the same buffer.
type Frame struct {
	Type   Type
	Stream uint32 // zero on connection frames

	Hello   Hello
	Welcome Welcome
	Refuse  Refuse
	Goaway  Goaway
	Open    Open
	Token   [8]byte   // PING and PONG
	Data    []byte    // DATA
	Credit  uint32    // WINDOW
	Reset   ResetCode // RESET
}

// ErrIncomplete is the answer of Decode when more bytes are needed and
// nothing is wrong yet.
var ErrIncomplete = errors.New("incomplete")

// Decode reads one frame from the start of b (section 3.1). It returns the
// frame and the number of bytes it used, or ErrIncomplete, or a ConnError.
//
// The checks run in the order the specification fixes. Everything before the
// second length check reads the header alone, so that a caller never has to
// buffer the payload of a frame that will be refused anyway.
func Decode(b []byte) (Frame, int, error) {
	if len(b) < headerLen {
		return Frame{}, 0, ErrIncomplete
	}
	typ := Type(b[0])
	onStream, known := typ.onStream()
	if !known {
		return Frame{}, 0, UnknownFrame
	}
	if b[1] != 0 {
		return Frame{}, 0, BadFlags
	}
	length := int(binary.BigEndian.Uint16(b[6:]))
	if length > MaxPayload {
		return Frame{}, 0, FrameTooLarge
	}
	id := binary.BigEndian.Uint32(b[2:])
	if (id != 0) != onStream {
		return Frame{}, 0, BadStreamID
	}
	if len(b) < headerLen+length {
		return Frame{}, 0, ErrIncomplete
	}
	f := Frame{Type: typ, Stream: id}
	if !f.readPayload(b[headerLen:headerLen+length]) || !f.validPayload() {
		return Frame{}, 0, BadPayload
	}
	return f, headerLen + length, nil
}

// Append adds the encoding of f to dst. There is exactly one (section 2), so
// a frame that a decoder would refuse is not written: dst comes back as it
// was, with a ConnError that says what is wrong.
func (f *Frame) Append(dst []byte) ([]byte, error) {
	onStream, known := f.Type.onStream()
	switch {
	case !known:
		return dst, UnknownFrame
	case (f.Stream != 0) != onStream:
		return dst, BadStreamID
	case !f.validPayload():
		return dst, BadPayload
	}
	start := len(dst)
	dst = append(dst, byte(f.Type), 0)
	dst = binary.BigEndian.AppendUint32(dst, f.Stream)
	dst = append(dst, 0, 0) // the length, filled in once the payload is written
	dst = f.appendPayload(dst)
	binary.BigEndian.PutUint16(dst[start+6:], uint16(len(dst)-start-headerLen))
	return dst, nil
}

// reader walks a payload from front to back. A read past the end marks the
// payload short and yields zeros, so a layout is read straight through and
// judged once, at the end.
type reader struct {
	rest  []byte
	short bool
}

func (r *reader) take(n int) []byte {
	if len(r.rest) < n {
		r.short = true
		r.rest = nil
		return nil
	}
	// The capacity is cut so that appending to a field cannot overwrite the
	// bytes that follow it in the caller's buffer.
	field := r.rest[:n:n]
	r.rest = r.rest[n:]
	return field
}

func (r *reader) u8() uint8 {
	if b := r.take(1); b != nil {
		return b[0]
	}
	return 0
}

func (r *reader) u16() uint16 {
	if b := r.take(2); b != nil {
		return binary.BigEndian.Uint16(b)
	}
	return 0
}

func (r *reader) u32() uint32 {
	if b := r.take(4); b != nil {
		return binary.BigEndian.Uint32(b)
	}
	return 0
}

func (r *reader) bytes8() []byte {
	return r.take(int(r.u8()))
}

// exact reports whether the reads matched the payload: nothing was missing
// and nothing is left over.
func (r *reader) exact() bool {
	return !r.short && len(r.rest) == 0
}

// readPayload fills f from the payload p and reports whether p has exactly
// the layout of f.Type. The values are judged afterwards, by validPayload.
func (f *Frame) readPayload(p []byte) bool {
	r := reader{rest: p}
	switch f.Type {
	case TypeHello:
		h := &f.Hello
		h.VersionMin = r.u8()
		h.VersionMax = r.u8()
		h.Role = Role(r.u8())
		copy(h.ID[:], r.take(len(h.ID)))
		h.MaxStreams = r.u16()
		h.Credential = bytes.Clone(r.bytes8())
		h.Software = string(r.bytes8())
	case TypeWelcome:
		w := &f.Welcome
		w.Version = r.u8()
		w.KeepaliveMS = r.u32()
		w.InitialWindow = r.u32()
	case TypeRefuse:
		x := &f.Refuse
		x.Code = r.u16()
		x.RetryAfterMS = r.u32()
		x.Cause = string(r.bytes8())
		x.Fix = string(r.bytes8())
	case TypePing, TypePong:
		copy(f.Token[:], r.take(len(f.Token)))
	case TypeGoaway:
		g := &f.Goaway
		g.Code = r.u16()
		g.ReconnectAfterMS = r.u32()
		g.Cause = string(r.bytes8())
	case TypeOpen:
		o := &f.Open
		copy(o.Device[:], r.take(len(o.Device)))
		o.Kind = TargetKind(r.u8())
		switch o.Kind {
		case TargetName:
			o.Target = r.bytes8()
		case TargetIPv4:
			o.Target = r.take(4)
		case TargetIPv6:
			o.Target = r.take(16)
		}
		o.Target = bytes.Clone(o.Target)
		o.Port = r.u16()
	case TypeData:
		f.Data = r.take(len(p))
	case TypeWindow:
		f.Credit = r.u32()
	case TypeReset:
		f.Reset = ResetCode(r.u16())
	}
	// OPENED and END read nothing: an empty payload is their whole layout.
	return r.exact()
}

// validPayload reports whether the payload fields of f hold values the
// specification allows. Decode and Append share it, so the encoder cannot
// write a frame that the decoder refuses.
func (f *Frame) validPayload() bool {
	switch f.Type {
	case TypeHello:
		return f.Hello.valid()
	case TypeWelcome:
		w := &f.Welcome
		return w.Version >= 1 &&
			w.KeepaliveMS >= 1000 && w.KeepaliveMS <= 600000 &&
			w.InitialWindow >= 16384 && w.InitialWindow <= 1048576
	case TypeRefuse:
		x := &f.Refuse
		return x.Code != 0 && validText(x.Cause, 1) && validText(x.Fix, 1)
	case TypeGoaway:
		return f.Goaway.Code != 0 && validText(f.Goaway.Cause, 0)
	case TypeOpen:
		return f.Open.valid()
	case TypeData:
		return len(f.Data) >= 1 && len(f.Data) <= MaxPayload
	case TypeWindow:
		return f.Credit >= 1 && f.Credit <= MaxCredit
	case TypeReset:
		return f.Reset != 0
	}
	// PING, PONG, OPENED and END have no field that can be out of range.
	return true
}

func (h *Hello) valid() bool {
	var streamsFit bool
	switch h.Role {
	case RoleDevice:
		streamsFit = h.MaxStreams >= 1 && h.MaxStreams <= 1024
	case RoleEdge:
		streamsFit = h.MaxStreams == 0
	}
	return streamsFit &&
		h.VersionMin >= 1 && h.VersionMax >= h.VersionMin &&
		len(h.Credential) >= 1 && len(h.Credential) <= 255 &&
		len(h.Software) <= 64 && printableASCII(h.Software)
}

func (o *Open) valid() bool {
	var targetFits bool
	switch o.Kind {
	case TargetName:
		targetFits = validName(o.Target)
	case TargetIPv4:
		targetFits = len(o.Target) == 4
	case TargetIPv6:
		targetFits = len(o.Target) == 16
	}
	return targetFits && o.Port != 0
}

// validText reports whether s is a text8 of at least shortest bytes. A code
// point below U+0020 or equal to U+007F is always a single byte in UTF-8, so
// the control characters can be found byte by byte.
func validText(s string, shortest int) bool {
	if len(s) < shortest || len(s) > 255 || !utf8.ValidString(s) {
		return false
	}
	for i := 0; i < len(s); i++ {
		if s[i] < 0x20 || s[i] == 0x7f {
			return false
		}
	}
	return true
}

func printableASCII(s string) bool {
	for i := 0; i < len(s); i++ {
		if s[i] < 0x20 || s[i] > 0x7e {
			return false
		}
	}
	return true
}

// validName applies the name rules of section 5.1.
func validName(name []byte) bool {
	if len(name) < 1 || len(name) > 253 {
		return false
	}
	labelLen, allDigits := 0, true
	for _, c := range name {
		if c == '.' {
			// A dot with no label before it is a leading dot or an empty label.
			if labelLen == 0 {
				return false
			}
			labelLen, allDigits = 0, true
			continue
		}
		digit := c >= '0' && c <= '9'
		if !digit && (c < 'a' || c > 'z') && c != '-' && c != '_' {
			return false
		}
		allDigits = allDigits && digit
		labelLen++
		if labelLen > 63 {
			return false
		}
	}
	// What is left is the last label: empty after a trailing dot, and never
	// all digits, because such a target has to be sent as an address.
	return labelLen > 0 && !allDigits
}

func (f *Frame) appendPayload(dst []byte) []byte {
	switch f.Type {
	case TypeHello:
		h := &f.Hello
		dst = append(dst, h.VersionMin, h.VersionMax, byte(h.Role))
		dst = append(dst, h.ID[:]...)
		dst = binary.BigEndian.AppendUint16(dst, h.MaxStreams)
		dst = appendBytes8(dst, h.Credential)
		dst = appendBytes8(dst, h.Software)
	case TypeWelcome:
		w := &f.Welcome
		dst = append(dst, w.Version)
		dst = binary.BigEndian.AppendUint32(dst, w.KeepaliveMS)
		dst = binary.BigEndian.AppendUint32(dst, w.InitialWindow)
	case TypeRefuse:
		x := &f.Refuse
		dst = binary.BigEndian.AppendUint16(dst, x.Code)
		dst = binary.BigEndian.AppendUint32(dst, x.RetryAfterMS)
		dst = appendBytes8(dst, x.Cause)
		dst = appendBytes8(dst, x.Fix)
	case TypePing, TypePong:
		dst = append(dst, f.Token[:]...)
	case TypeGoaway:
		g := &f.Goaway
		dst = binary.BigEndian.AppendUint16(dst, g.Code)
		dst = binary.BigEndian.AppendUint32(dst, g.ReconnectAfterMS)
		dst = appendBytes8(dst, g.Cause)
	case TypeOpen:
		o := &f.Open
		dst = append(dst, o.Device[:]...)
		dst = append(dst, byte(o.Kind))
		if o.Kind == TargetName {
			dst = appendBytes8(dst, o.Target)
		} else {
			dst = append(dst, o.Target...)
		}
		dst = binary.BigEndian.AppendUint16(dst, o.Port)
	case TypeData:
		dst = append(dst, f.Data...)
	case TypeWindow:
		dst = binary.BigEndian.AppendUint32(dst, f.Credit)
	case TypeReset:
		dst = binary.BigEndian.AppendUint16(dst, uint16(f.Reset))
	}
	return dst
}

// appendBytes8 writes s with its length in front. validPayload has already
// made sure the length fits in one byte.
func appendBytes8[T []byte | string](dst []byte, s T) []byte {
	dst = append(dst, byte(len(s)))
	return append(dst, s...)
}
