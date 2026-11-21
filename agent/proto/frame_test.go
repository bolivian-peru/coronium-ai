package proto

import (
	"bytes"
	"reflect"
	"strings"
	"testing"
)

// A device checks the target of an OPEN against section 10 and then dials
// what it checked, so the target must not change when the next frame is read
// into the same buffer. Only DATA may stay a view of that buffer.
func TestDecodedFrameOutlivesItsBuffer(t *testing.T) {
	v := loadFrameVectors(t)
	for i := range v.frames {
		fv := &v.frames[i]
		if fv.frame.Type == TypeData {
			continue
		}
		buf := bytes.Clone(fv.wire)
		got, _, err := Decode(buf)
		if err != nil {
			t.Fatalf("frames %q: decode gave %v", fv.name, err)
		}
		for j := range buf {
			buf[j] ^= 0xff
		}
		if !reflect.DeepEqual(got, fv.frame) {
			t.Errorf("frames %q: the decoded frame changed when its buffer was reused", fv.name)
		}
	}
}

// The vectors only ask for frames that have an encoding. These are frames
// that have none, which the encoder must turn down instead of writing bytes a
// decoder would refuse or misread.
func TestAppendRefusesWhatHasNoEncoding(t *testing.T) {
	edge := Hello{VersionMin: 1, VersionMax: 1, Role: RoleEdge, Credential: []byte{1}}
	longCredential := edge
	longCredential.Credential = make([]byte, 256)
	cases := []struct {
		frame Frame
		want  ConnError
	}{
		{Frame{Type: 0x07}, UnknownFrame},
		{Frame{Type: TypeEnd}, BadStreamID},
		{Frame{Type: TypePing, Stream: 1}, BadStreamID},
		{Frame{Type: TypeData, Stream: 1}, BadPayload},
		{Frame{Type: TypeData, Stream: 1, Data: make([]byte, MaxPayload+1)}, BadPayload},
		{Frame{Type: TypeWindow, Stream: 1, Credit: MaxCredit + 1}, BadPayload},
		{Frame{Type: TypeReset, Stream: 1}, BadPayload},
		{Frame{Type: TypeHello, Hello: longCredential}, BadPayload},
		{Frame{Type: TypeGoaway, Goaway: Goaway{Code: 1, Cause: strings.Repeat("a", 256)}}, BadPayload},
		{Frame{Type: TypeGoaway, Goaway: Goaway{Code: 1, Cause: "a\nb"}}, BadPayload},
		{Frame{Type: TypeOpen, Stream: 1, Open: Open{Kind: TargetName, Target: []byte("Example.com"), Port: 443}}, BadPayload},
		{Frame{Type: TypeOpen, Stream: 1, Open: Open{Kind: TargetIPv4, Target: make([]byte, 16), Port: 443}}, BadPayload},
	}
	for _, c := range cases {
		if wire, err := c.frame.Append(nil); err != c.want || wire != nil {
			t.Errorf("%+v: encode gave %x and %v, want %v", c.frame, wire, err, c.want)
		}
	}
	// The cases above must fail for the reason given and not for a slip in
	// the frames they are built from.
	if _, err := (&Frame{Type: TypeHello, Hello: edge}).Append(nil); err != nil {
		t.Errorf("the HELLO the cases start from does not encode: %v", err)
	}
}
