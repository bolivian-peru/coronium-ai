package proto

import (
	"bytes"
	"testing"
)

// hotPath is the work a busy stream costs for each frame: decode, check and
// encode again.
type hotPath struct {
	link   *Link
	frames [2][]byte // indexed by the side that sends
	out    []byte
	failed bool
}

func (h *hotPath) run() {
	for from, wire := range h.frames {
		f, _, err := Decode(wire)
		if err != nil || h.link.Check(Side(from), &f) != (Verdict{}) {
			h.failed = true
			return
		}
		h.out, err = f.Append(h.out[:0])
		if err != nil || !bytes.Equal(h.out, wire) {
			h.failed = true
			return
		}
	}
}

// sent is a frame and the side that sends it.
type sent struct {
	from  Side
	frame Frame
}

// The frames that bring a device link up and open stream 1 on it.
var (
	hello   = sent{Dialer, Frame{Type: TypeHello, Hello: Hello{VersionMin: 1, VersionMax: 1, Role: RoleDevice, MaxStreams: 1, Credential: []byte{1}}}}
	welcome = sent{Relay, Frame{Type: TypeWelcome, Welcome: Welcome{Version: 1, KeepaliveMS: 1000, InitialWindow: MaxPayload}}}
	open    = sent{Relay, Frame{Type: TypeOpen, Stream: 1, Open: Open{Kind: TargetName, Target: []byte("example.com"), Port: 443}}}
	opened  = sent{Dialer, Frame{Type: TypeOpened, Stream: 1}}
)

// The vectors end a session at its first connection error. A caller that
// keeps feeding frames anyway must not find the connection alive again.
func TestNothingIsAcceptedAfterAConnectionError(t *testing.T) {
	tooNew := welcome
	tooNew.frame.Welcome.Version = 2
	goaway := sent{Dialer, Frame{Type: TypeGoaway, Goaway: Goaway{Code: 5}}}
	ping := Frame{Type: TypePing}
	// In each case the frames before the fault are allowed, and so would be
	// the frames after it had the fault not happened.
	cases := []struct {
		before []sent
		fault  sent
		want   ConnError
		after  []sent
	}{
		{[]sent{hello}, tooNew, UnexpectedFrame, []sent{welcome, open, opened}},
		{[]sent{hello, welcome}, opened, BadStreamID, []sent{{Dialer, ping}, {Relay, ping}}},
		{[]sent{hello, welcome, open, goaway}, goaway, UnexpectedFrame, []sent{opened, {Relay, ping}}},
	}
	for i, c := range cases {
		link := NewLink(DeviceLink)
		for _, s := range c.before {
			if got := link.Check(s.from, &s.frame); got != (Verdict{}) {
				t.Fatalf("case %d: %+v got %s before the fault", i, s.frame, got)
			}
		}
		if got := link.Check(c.fault.from, &c.fault.frame); got != (Verdict{Conn: c.want}) {
			t.Fatalf("case %d: the fault got %s, want %s", i, got, Verdict{Conn: c.want})
		}
		for j, s := range c.after {
			if got := link.Check(s.from, &s.frame); got != unexpected {
				t.Errorf("case %d: frame %d after the fault got %s, want %s", i, j, got, unexpected)
			}
		}
	}
}

// An agent on a router runs every frame of every stream through this code, so
// the data path must not allocate.
func TestDataPathDoesNotAllocate(t *testing.T) {
	link := NewLink(DeviceLink)
	for _, s := range []sent{hello, welcome, open, opened} {
		if got := link.Check(s.from, &s.frame); got != (Verdict{}) {
			t.Fatalf("setup: %+v got %s", s.frame, got)
		}
	}
	// Each round the device grants a full frame of credit and the relay
	// spends it, so the stream never runs dry and never overflows.
	credit := Frame{Type: TypeWindow, Stream: 1, Credit: MaxPayload}
	payload := Frame{Type: TypeData, Stream: 1, Data: make([]byte, MaxPayload)}
	h := hotPath{link: link, out: make([]byte, 0, headerLen+MaxPayload)}
	// A frame that failed to encode would leave no bytes here, and run
	// would report that as a failure.
	h.frames[Dialer], _ = credit.Append(nil)
	h.frames[Relay], _ = payload.Append(nil)
	if allocs := testing.AllocsPerRun(1000, h.run); allocs != 0 || h.failed {
		t.Errorf("a WINDOW and a DATA cost %v allocations (failed: %v), want none", allocs, h.failed)
	}
}
