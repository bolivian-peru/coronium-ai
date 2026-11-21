package proto

import (
	"bytes"
	"math/rand/v2"
	"slices"
	"testing"
)

// The vectors are bytes somebody chose. A peer sends whatever it likes, so
// the tests in this file feed the decoder and the rule checker bytes that
// are in no vector file. The fuzz targets take their seeds from the vectors;
// plain go test runs those seeds, and the two tests beside them go further
// with a fixed seed, so that a failure repeats on every run.

// checkDecode holds Decode to section 3.1 for any bytes at all: it answers
// with a frame, incomplete or a connection error, and a frame is the only
// encoding of itself, so encoding it again gives back the bytes it used and
// every strict prefix of those bytes is incomplete. It reports whether b
// started with a frame.
func checkDecode(t *testing.T, b []byte) bool {
	t.Helper()
	f, used, err := Decode(b)
	if err != nil {
		if _, refused := err.(ConnError); !refused && err != ErrIncomplete {
			t.Fatalf("%x: decode gave the error %v", b, err)
		}
		return false
	}
	wire, err := f.Append(nil)
	if err != nil || !bytes.Equal(wire, b[:used]) {
		t.Fatalf("%x: decoded to %+v, which encodes to %x (error %v)", b[:used], f, wire, err)
	}
	for cut := range used {
		if _, _, err := Decode(b[:cut]); err != ErrIncomplete {
			t.Fatalf("%x cut to %d bytes: decode gave %v, want incomplete", b[:used], cut, err)
		}
	}
	return true
}

// checkLink runs a script through a fresh link: one byte for the link, then
// one byte for the sender in front of each frame. The script ends where its
// bytes stop being frames, because Check is only ever given what Decode
// returned. Whatever the frames, nothing is accepted after a connection
// error and a device never carries more streams than it offered. It reports
// the verdicts.
func checkLink(t *testing.T, script []byte) []Verdict {
	t.Helper()
	if len(script) == 0 {
		return nil
	}
	link := NewLink(LinkKind(script[0] & 1))
	var verdicts []Verdict
	over := false
	for script = script[1:]; len(script) > 0; {
		from := Side(script[0] & 1)
		f, used, err := Decode(script[1:])
		if err != nil {
			break
		}
		script = script[1+used:]
		v := link.Check(from, &f)
		verdicts = append(verdicts, v)
		if over && v != unexpected {
			t.Fatalf("frame %d: got %s after a connection error", len(verdicts), v)
		}
		over = over || v.Conn != 0
		if link.kind == DeviceLink && len(link.streams) > int(link.maxStreams) {
			t.Fatalf("frame %d: %d streams are open, above max_streams %d", len(verdicts), len(link.streams), link.maxStreams)
		}
	}
	return verdicts
}

func appendStep(script []byte, from Side, wire []byte) []byte {
	return append(append(script, byte(from)), wire...)
}

func FuzzDecode(f *testing.F) {
	v := loadFrameVectors(f)
	for _, fv := range slices.Concat(v.frames, v.refused, v.incomplete) {
		f.Add(fv.wire)
	}
	f.Fuzz(func(t *testing.T, b []byte) {
		checkDecode(t, b)
	})
}

func FuzzLinkCheck(f *testing.F) {
	for _, path := range []string{sessionsFile} {
		for _, s := range loadSessions(f, path) {
			script := []byte{byte(s.kind)}
			for _, st := range s.steps {
				script = appendStep(script, st.from, st.wire)
			}
			f.Add(script)
		}
	}
	f.Fuzz(func(t *testing.T, script []byte) {
		checkLink(t, script)
	})
}

// damaged returns wire with one byte changed, cut short, or with one byte
// added.
func damaged(rng *rand.Rand, wire []byte) []byte {
	at := rng.IntN(len(wire) + 1)
	switch rng.IntN(3) {
	case 0:
		b := bytes.Clone(wire)
		if at < len(b) {
			b[at] = byte(rng.Uint32())
		}
		return b
	case 1:
		return wire[:at]
	}
	return slices.Insert(bytes.Clone(wire), at, byte(rng.Uint32()))
}

func TestDecodeSurvivesDamagedVectors(t *testing.T) {
	rng := rand.New(rand.NewPCG(1, 2))
	v := loadFrameVectors(t)
	decoded := 0
	for range 200 {
		for _, fv := range slices.Concat(v.frames, v.refused, v.incomplete) {
			if checkDecode(t, damaged(rng, fv.wire)) {
				decoded++
			}
		}
	}
	// The loop is only worth something if a fair share of its inputs get
	// past the header checks and into a payload.
	if decoded < 1000 {
		t.Errorf("only %d damaged vectors decoded", decoded)
	}
}

func TestLinkSurvivesFramesInAnyOrder(t *testing.T) {
	rng := rand.New(rand.NewPCG(3, 4))
	sessions := loadSessions(t, sessionsFile)
	seen := map[string]int{}
	for range 20000 {
		// The start of a session gets the link into one of its states, and
		// frames from anywhere in the vectors then arrive from either side.
		s := &sessions[rng.IntN(len(sessions))]
		script := []byte{byte(s.kind)}
		for _, st := range s.steps[:rng.IntN(len(s.steps)+1)] {
			script = appendStep(script, st.from, st.wire)
		}
		for range rng.IntN(20) {
			other := &sessions[rng.IntN(len(sessions))]
			script = appendStep(script, Side(rng.IntN(2)), other.steps[rng.IntN(len(other.steps))].wire)
		}
		for _, v := range checkLink(t, script) {
			seen[v.String()]++
		}
	}
	// Every answer the vectors know must have come up, or the frames above
	// never got past the handshake.
	for _, s := range sessions {
		for _, st := range s.steps {
			if seen[st.expect] < 10 {
				t.Fatalf("the answer %s came up %d times", st.expect, seen[st.expect])
			}
		}
	}
}
