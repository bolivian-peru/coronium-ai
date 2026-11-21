package proto

import (
	"bytes"
	"encoding/hex"
	"encoding/json/jsontext"
	"encoding/json/v2"
	"errors"
	"fmt"
	"os"
	"reflect"
	"strings"
	"testing"
)

// The vectors are shared with the Rust implementation. They are read where
// they live, so both sides always run against the same files.
const (
	framesFile   = "../../proto/vectors/frames.json"
	sessionsFile = "../../proto/vectors/sessions.json"
)

// object is one JSON object of a vector file. Every member has to be taken by
// its exact name and none may be left over, so a misspelt, extra or missing
// member is an error and never a silent default.
type object struct {
	what    string
	members map[string]jsontext.Value
	err     error // the first problem met
}

func parseObject(what string, raw []byte) *object {
	o := &object{what: what}
	if err := json.Unmarshal(raw, &o.members); err != nil {
		o.fail("%v", err)
	}
	return o
}

func (o *object) fail(format string, args ...any) {
	if o.err == nil {
		o.err = fmt.Errorf("%s: %s", o.what, fmt.Sprintf(format, args...))
	}
}

func (o *object) take(key string, dst any) {
	raw, ok := o.members[key]
	if !ok {
		o.fail("member %q is missing", key)
		return
	}
	delete(o.members, key)
	// The decoder would turn null into a zero, which would pass for a value.
	if raw.Kind() == 'n' {
		o.fail("member %q is null", key)
		return
	}
	if err := json.Unmarshal(raw, dst); err != nil {
		o.fail("member %q: %v", key, err)
	}
}

func (o *object) hex(key string) []byte {
	var digits string
	o.take(key, &digits)
	b, err := hex.DecodeString(digits)
	if err != nil || hex.EncodeToString(b) != digits {
		o.fail("member %q is not lowercase hex", key)
	}
	return b
}

func (o *object) hexInto(key string, dst []byte) {
	b := o.hex(key)
	if len(b) != len(dst) {
		o.fail("member %q is %d bytes, want %d", key, len(b), len(dst))
	}
	copy(dst, b)
}

// pick reads a string member that has to be one of the names in table.
func pick[T any](o *object, key string, table map[string]T) T {
	var name string
	o.take(key, &name)
	value, ok := table[name]
	if !ok {
		o.fail("member %q has the unknown value %q", key, name)
	}
	return value
}

func (o *object) done() error {
	for key := range o.members {
		o.fail("unknown member %q", key)
	}
	return o.err
}

var (
	frameTypes = map[string]Type{
		"hello": TypeHello, "welcome": TypeWelcome, "refuse": TypeRefuse,
		"ping": TypePing, "pong": TypePong, "goaway": TypeGoaway,
		"open": TypeOpen, "opened": TypeOpened, "data": TypeData,
		"window": TypeWindow, "end": TypeEnd, "reset": TypeReset,
	}
	roles       = map[string]Role{"device": RoleDevice, "edge": RoleEdge}
	targetKinds = map[string]TargetKind{"name": TargetName, "ipv4": TargetIPv4, "ipv6": TargetIPv6}
	linkKinds   = map[string]LinkKind{"device": DeviceLink, "edge": EdgeLink}
	sides       = map[string]Side{"dialer": Dialer, "relay": Relay}
	connErrors  = connErrorsByName()
	expects     = knownExpects()
)

func connErrorsByName() map[string]ConnError {
	byName := map[string]ConnError{}
	for e := UnknownFrame; e <= UnexpectedFrame; e++ {
		byName[e.Error()] = e
	}
	return byName
}

// knownExpects lists every answer section 12.2 allows a step to expect.
func knownExpects() map[string]bool {
	known := map[string]bool{Verdict{}.String(): true, Verdict{Ignored: true}.String(): true}
	for e := UnknownFrame; e <= UnexpectedFrame; e++ {
		known[Verdict{Conn: e}.String()] = true
	}
	for c := ResetConnectRefused; c <= ResetIO; c++ {
		known[Verdict{Reset: c}.String()] = true
	}
	return known
}

// parseFrame reads the frame object of section 12.1.
func parseFrame(what string, raw []byte) (Frame, error) {
	o := parseObject(what, raw)
	f := Frame{Type: pick(o, "type", frameTypes)}
	if onStream, _ := f.Type.onStream(); onStream {
		o.take("stream", &f.Stream)
	}
	switch f.Type {
	case TypeHello:
		h := &f.Hello
		o.take("version_min", &h.VersionMin)
		o.take("version_max", &h.VersionMax)
		h.Role = pick(o, "role", roles)
		o.hexInto("id", h.ID[:])
		o.take("max_streams", &h.MaxStreams)
		h.Credential = o.hex("credential")
		o.take("software", &h.Software)
	case TypeWelcome:
		w := &f.Welcome
		o.take("version", &w.Version)
		o.take("keepalive_ms", &w.KeepaliveMS)
		o.take("initial_window", &w.InitialWindow)
	case TypeRefuse:
		x := &f.Refuse
		o.take("code", &x.Code)
		o.take("retry_after_ms", &x.RetryAfterMS)
		o.take("cause", &x.Cause)
		o.take("fix", &x.Fix)
	case TypePing, TypePong:
		o.hexInto("payload", f.Token[:])
	case TypeGoaway:
		g := &f.Goaway
		o.take("code", &g.Code)
		o.take("reconnect_after_ms", &g.ReconnectAfterMS)
		o.take("cause", &g.Cause)
	case TypeOpen:
		t := &f.Open
		o.hexInto("device", t.Device[:])
		t.Kind = pick(o, "target_kind", targetKinds)
		if t.Kind == TargetName {
			var name string
			o.take("target", &name)
			t.Target = []byte(name)
		} else {
			t.Target = o.hex("target")
		}
		o.take("port", &t.Port)
	case TypeData:
		f.Data = o.hex("payload")
	case TypeWindow:
		o.take("credit", &f.Credit)
	case TypeReset:
		o.take("code", &f.Reset)
	}
	return f, o.done()
}

// frameVector is one entry of frames.json. frame is set for the entries
// under "frames" and refusal for those under "refused".
type frameVector struct {
	name    string
	wire    []byte
	frame   Frame
	refusal ConnError
}

type frameVectors struct {
	frames, refused, incomplete []frameVector
}

func parseFrameVectors(doc []byte) (frameVectors, error) {
	top := parseObject("frames.json", doc)
	takeVersion(top)
	var v frameVectors
	lists := []struct {
		key  string
		into *[]frameVector
	}{{"frames", &v.frames}, {"refused", &v.refused}, {"incomplete", &v.incomplete}}
	for _, list := range lists {
		var entries []jsontext.Value
		top.take(list.key, &entries)
		for i, raw := range entries {
			entry, err := parseFrameVector(list.key, i, raw)
			if err != nil {
				return v, err
			}
			*list.into = append(*list.into, entry)
		}
	}
	return v, top.done()
}

// parseFrameVector reads entry i of the named list. The list decides which
// third member an entry has: a frame, an error, or none.
func parseFrameVector(list string, i int, raw []byte) (frameVector, error) {
	what := fmt.Sprintf("%s[%d]", list, i)
	o := parseObject(what, raw)
	var v frameVector
	o.take("name", &v.name)
	v.wire = o.hex("hex")
	switch list {
	case "frames":
		var frame jsontext.Value
		o.take("frame", &frame)
		parsed, err := parseFrame(what+".frame", frame)
		if err != nil {
			o.fail("%v", err)
		}
		v.frame = parsed
	case "refused":
		v.refusal = pick(o, "error", connErrors)
	}
	return v, o.done()
}

func takeVersion(top *object) {
	var version int
	top.take("protocol_version", &version)
	if version != 1 {
		top.fail("protocol_version is %d, want 1", version)
	}
}

type step struct {
	from   Side
	wire   []byte
	expect string
}

type session struct {
	name  string
	kind  LinkKind
	steps []step
}

func parseSessions(doc []byte) ([]session, error) {
	top := parseObject("top level", doc)
	takeVersion(top)
	var entries []jsontext.Value
	top.take("sessions", &entries)
	var sessions []session
	for i, raw := range entries {
		s, err := parseSession(fmt.Sprintf("sessions[%d]", i), raw)
		if err != nil {
			return nil, err
		}
		sessions = append(sessions, s)
	}
	return sessions, top.done()
}

func parseSession(what string, raw []byte) (session, error) {
	o := parseObject(what, raw)
	var s session
	o.take("name", &s.name)
	s.kind = pick(o, "link", linkKinds)
	var steps []jsontext.Value
	o.take("steps", &steps)
	for i, raw := range steps {
		st, err := parseStep(fmt.Sprintf("%s.steps[%d]", what, i), raw)
		if err != nil {
			return s, err
		}
		s.steps = append(s.steps, st)
	}
	return s, o.done()
}

func parseStep(what string, raw []byte) (step, error) {
	o := parseObject(what, raw)
	var st step
	st.from = pick(o, "from", sides)
	st.wire = o.hex("hex")
	o.take("expect", &st.expect)
	if o.err == nil && !expects[st.expect] {
		o.fail("unknown expect %q", st.expect)
	}
	return st, o.done()
}

func readVectors(t testing.TB, path string) []byte {
	doc, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return doc
}

func loadFrameVectors(t testing.TB) frameVectors {
	v, err := parseFrameVectors(readVectors(t, framesFile))
	if err != nil {
		t.Fatal(err)
	}
	return v
}

func loadSessions(t testing.TB, path string) []session {
	sessions, err := parseSessions(readVectors(t, path))
	if err != nil {
		t.Fatalf("%s: %v", path, err)
	}
	return sessions
}

func TestFrameVectors(t *testing.T) {
	v := loadFrameVectors(t)
	for i := range v.frames {
		checkFrame(t, &v.frames[i])
	}
	for _, r := range v.refused {
		if _, _, err := Decode(r.wire); err != r.refusal {
			t.Errorf("refused %q: decode gave %v, want %v", r.name, err, r.refusal)
		}
	}
	for _, c := range v.incomplete {
		if _, _, err := Decode(c.wire); err != ErrIncomplete {
			t.Errorf("incomplete %q: decode gave %v, want incomplete", c.name, err)
		}
	}
}

func checkFrame(t *testing.T, v *frameVector) {
	got, used, err := Decode(v.wire)
	switch {
	case err != nil:
		t.Errorf("frames %q: decode gave %v", v.name, err)
	case used != len(v.wire):
		t.Errorf("frames %q: decode used %d of %d bytes", v.name, used, len(v.wire))
	case !reflect.DeepEqual(got, v.frame):
		t.Errorf("frames %q: decode gave\n%+v, want\n%+v", v.name, got, v.frame)
	}
	wire, err := v.frame.Append(nil)
	if err != nil || !bytes.Equal(wire, v.wire) {
		t.Errorf("frames %q: encode gave %x (error %v), want %x", v.name, wire, err, v.wire)
	}
}

// A vector is one frame alone, but on a connection frames arrive back to
// back. Decode has to hand out each one and leave the bytes behind it alone.
func TestFrameVectorsBackToBack(t *testing.T) {
	v := loadFrameVectors(t)
	var received []byte
	for _, fv := range v.frames {
		received = append(received, fv.wire...)
	}
	for _, fv := range v.frames {
		got, used, err := Decode(received)
		if err != nil || used != len(fv.wire) || !reflect.DeepEqual(got, fv.frame) {
			t.Fatalf("frames %q: decode gave %+v, %d bytes and error %v, want %+v and %d bytes",
				fv.name, got, used, err, fv.frame, len(fv.wire))
		}
		received = received[used:]
	}
}

func TestSessionVectors(t *testing.T) {
	for _, path := range []string{sessionsFile} {
		sessions := loadSessions(t, path)
		for i := range sessions {
			if err := runSession(&sessions[i]); err != nil {
				t.Errorf("%s: session %q: %v", path, sessions[i].name, err)
			}
		}
	}
}

// runSession feeds the steps to a fresh link and returns the first step that
// does not get exactly the answer it expects.
func runSession(s *session) error {
	link := NewLink(s.kind)
	for i := range s.steps {
		st := &s.steps[i]
		got, err := answerStep(link, st)
		if err != nil {
			return fmt.Errorf("step %d: %v", i, err)
		}
		if got != st.expect {
			return fmt.Errorf("step %d: got %s, want %s", i, got, st.expect)
		}
		if strings.HasPrefix(got, "connection_error:") && i+1 < len(s.steps) {
			return fmt.Errorf("step %d: a session ends at its first connection error, but more steps follow", i)
		}
	}
	return nil
}

// answerStep gives the rule checker's answer for one step. A step is one
// whole frame (section 12.2), so bytes the decoder refuses are a fault in the
// file and never an answer: the decoder's errors are tested in frames.json.
func answerStep(link *Link, st *step) (string, error) {
	f, used, err := Decode(st.wire)
	if err != nil || used != len(st.wire) {
		return "", errors.New("the hex is not exactly one whole frame")
	}
	return link.Check(st.from, &f).String(), nil
}

// A step that is not one whole frame must fail its session, even when the
// step expects the very error the decoder gives for its bytes.
func TestSessionStepMustBeOneWholeFrame(t *testing.T) {
	cases := []struct {
		wire, expect string
	}{
		{"04010000000000080001020304050607", "connection_error:bad_flags"},
		{"04000000000000080001020304", "connection_error:unexpected_frame"},
		{"0400000000000008000102030405060700", "connection_error:unexpected_frame"},
	}
	for _, c := range cases {
		wire, err := hex.DecodeString(c.wire)
		if err != nil {
			t.Fatal(err)
		}
		s := session{kind: DeviceLink, steps: []step{{from: Dialer, wire: wire, expect: c.expect}}}
		if runSession(&s) == nil {
			t.Errorf("a step with the bytes %s was accepted", c.wire)
		}
	}
}

// Each case below is a vector file that parses, with one edit that must make
// it fail. This is what keeps a typo in a vector from being skipped.
const (
	goodFrames = `{"protocol_version":1,` +
		`"frames":[{"name":"f","hex":"1400000000010000","frame":{"type":"end","stream":1}}],` +
		`"refused":[{"name":"r","hex":"7f00000000000000","error":"unknown_frame"}],` +
		`"incomplete":[{"name":"i","hex":"0a"}]}`
	goodSessions = `{"protocol_version":1,"sessions":[{"name":"s","link":"device",` +
		`"steps":[{"from":"dialer","hex":"1400000000010000","expect":"ok"}]}]}`
)

func framesError(doc string) error {
	_, err := parseFrameVectors([]byte(doc))
	return err
}

func sessionsError(doc string) error {
	_, err := parseSessions([]byte(doc))
	return err
}

func TestVectorFilesAreReadStrictly(t *testing.T) {
	cases := []struct {
		parse    func(string) error
		good     string
		old, new string
	}{
		{framesError, goodFrames, `"protocol_version":1`, `"protocol_version":2`},
		{framesError, goodFrames, `"protocol_version":1`, `"protocol_version":1,"extra":[]`},
		{framesError, goodFrames, `"stream":1`, `"stream":1,"payload":"00"`},
		{framesError, goodFrames, `,"stream":1`, ``},
		{framesError, goodFrames, `"stream":1`, `"stream":null`},
		{framesError, goodFrames, `"stream":1`, `"stream":4294967296`},
		{framesError, goodFrames, `"type":"end"`, `"type":"finish"`},
		{framesError, goodFrames, `"error":"unknown_frame"`, `"error":"bad_frame"`},
		{framesError, goodFrames, `"hex":"0a"`, `"hex":"0A"`},
		{framesError, goodFrames, `"name":"i"`, `"name":"i","name":"i"`},
		{sessionsError, goodSessions, `"protocol_version":1`, `"protocol_version":1.5`},
		{sessionsError, goodSessions, `"expect":"ok"`, `"expect":"fine"`},
		{sessionsError, goodSessions, `"expect":"ok"`, `"expect":"stream_error:nonsense"`},
		{sessionsError, goodSessions, `"expect":"ok"`, `"expect":"ok","note":""`},
		{sessionsError, goodSessions, `,"expect":"ok"`, ``},
		{sessionsError, goodSessions, `"hex"`, `"Hex"`},
		{sessionsError, goodSessions, `"from":"dialer"`, `"from":"device"`},
		{sessionsError, goodSessions, `"link":"device"`, `"link":"mesh"`},
		{sessionsError, goodSessions, `"link":"device"`, `"link":"device","note":""`},
	}
	for _, c := range cases {
		if err := c.parse(c.good); err != nil {
			t.Fatalf("the unedited file does not parse: %v", err)
		}
		edited := strings.Replace(c.good, c.old, c.new, 1)
		if edited == c.good {
			t.Fatalf("the edit %s to %s changes nothing", c.old, c.new)
		}
		if c.parse(edited) == nil {
			t.Errorf("a file with %s in place of %s was accepted", c.new, c.old)
		}
	}
}
