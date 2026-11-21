package proto

// Side is one end of a link.
type Side uint8

// The two ends of a link.
const (
	Dialer Side = iota
	Relay
)

func (s Side) peer() Side {
	return s ^ 1
}

// LinkKind tells the two links of section 1 apart.
type LinkKind uint8

// On a device link the relay opens streams, on an edge link the dialer does.
const (
	DeviceLink LinkKind = iota
	EdgeLink
)

// Verdict is what the rules say about one frame. At most one field is set,
// and the zero Verdict means the frame is allowed.
type Verdict struct {
	Conn    ConnError // the connection must end: send GOAWAY and close
	Reset   ResetCode // a stream error: send RESET with this code, forget the stream
	Ignored bool      // the frame is for a closed stream: drop it
}

var unexpected = Verdict{Conn: UnexpectedFrame}

// String returns the verdict as the session vectors write it (section 12.2).
func (v Verdict) String() string {
	switch {
	case v.Conn != 0:
		return "connection_error:" + v.Conn.Error()
	case v.Reset != 0:
		return "stream_error:" + v.Reset.String()
	case v.Ignored:
		return "ignored"
	}
	return "ok"
}

type phase uint8

const (
	awaitingHello phase = iota
	awaitingAnswer
	established
	// REFUSE was sent or a connection error was found. Nothing may follow.
	closed
)

// stream is the state of one open stream. The arrays are indexed by the side
// that sends.
type stream struct {
	credit [2]uint32 // DATA bytes that side may still send
	ended  [2]bool   // that side has sent END
	opened bool      // the acceptor has sent OPENED
}

// Link checks the frames of one connection against sections 6 and 7. Timers
// and dialing are left to the caller.
//
// The text does not rank its rules. Where a frame breaks two of them, the
// one that comes first names the error: section 6 before section 7, and the
// lower number within a section.
type Link struct {
	kind  LinkKind
	phase phase

	versionMin, versionMax uint8  // from HELLO
	maxStreams             uint16 // from HELLO
	window                 uint32 // WELCOME.initial_window

	// These three are indexed by the side that sent the frame.
	pinged [2]bool    // its PING is unanswered
	token  [2][8]byte // the bytes of that PING
	goaway [2]bool    // it has sent GOAWAY

	// A closed stream leaves no trace: an id at or below highest that is not
	// in streams is closed, so memory follows the open streams only.
	highest uint32
	streams map[uint32]stream
}

// NewLink returns the checker for a connection on which nothing has been
// sent yet.
func NewLink(kind LinkKind) *Link {
	return &Link{kind: kind, streams: make(map[uint32]stream)}
}

func (l *Link) opener() Side {
	if l.kind == DeviceLink {
		return Relay
	}
	return Dialer
}

// Check judges the next frame on the link, which the side from sent. The
// frame must be valid: one that Decode returned or that Append accepts. Both
// sides' frames go through the same Link, in the order they cross the wire.
// A connection error ends the connection: every frame checked after one is
// unexpected, so a caller that fails to close cannot find the link alive.
func (l *Link) Check(from Side, f *Frame) Verdict {
	v := l.judge(from, f)
	if v.Conn != 0 {
		l.phase = closed
	}
	return v
}

func (l *Link) judge(from Side, f *Frame) Verdict {
	switch l.phase {
	case awaitingHello:
		return l.hello(from, f)
	case awaitingAnswer:
		return l.answer(from, f)
	case closed:
		return unexpected
	}
	switch f.Type {
	case TypePing:
		if l.pinged[from] {
			return unexpected
		}
		l.pinged[from], l.token[from] = true, f.Token
		return Verdict{}
	case TypePong:
		asker := from.peer()
		if !l.pinged[asker] || l.token[asker] != f.Token {
			return unexpected
		}
		l.pinged[asker] = false
		return Verdict{}
	case TypeGoaway:
		if l.goaway[from] {
			return unexpected
		}
		l.goaway[from] = true
		return Verdict{}
	case TypeOpen:
		return l.open(from, f)
	case TypeOpened, TypeData, TypeWindow, TypeEnd, TypeReset:
		return l.onStream(from, f)
	}
	// HELLO, WELCOME and REFUSE belong to the handshake, which is over.
	return unexpected
}

func (l *Link) hello(from Side, f *Frame) Verdict {
	if from != Dialer || f.Type != TypeHello {
		return unexpected
	}
	// The role is not compared with the link: a dialer on the wrong listener
	// is answered with REFUSE wrong_role, which is not a connection error.
	l.versionMin, l.versionMax = f.Hello.VersionMin, f.Hello.VersionMax
	l.maxStreams = f.Hello.MaxStreams
	l.phase = awaitingAnswer
	return Verdict{}
}

func (l *Link) answer(from Side, f *Frame) Verdict {
	if from != Relay {
		return unexpected
	}
	switch f.Type {
	case TypeWelcome:
		if f.Welcome.Version < l.versionMin || f.Welcome.Version > l.versionMax {
			return unexpected
		}
		l.window = f.Welcome.InitialWindow
		l.phase = established
		return Verdict{}
	case TypeRefuse:
		l.phase = closed
		return Verdict{}
	}
	return unexpected
}

func (l *Link) open(from Side, f *Frame) Verdict {
	if from != l.opener() || l.goaway[from] {
		return unexpected
	}
	if f.Stream <= l.highest {
		return Verdict{Conn: BadStreamID}
	}
	// An OPEN that is turned down below still uses up its id. The stream
	// then counts as closed, so the frames the opener sent straight after it
	// are ignored instead of ending the connection.
	l.highest = f.Stream
	if l.kind == DeviceLink {
		// Rule 7.7 comes before rule 7.8, so a device that is both full and
		// leaving is reported as full.
		if len(l.streams) >= int(l.maxStreams) {
			return Verdict{Reset: ResetTooManyStreams}
		}
		// The device is the dialer of its link.
		if l.goaway[Dialer] {
			return Verdict{Reset: ResetGoingAway}
		}
	}
	l.streams[f.Stream] = stream{credit: [2]uint32{l.window, l.window}}
	return Verdict{}
}

// onStream judges OPENED, DATA, WINDOW, END and RESET.
func (l *Link) onStream(from Side, f *Frame) Verdict {
	acceptor := from != l.opener()
	// Who may send a frame is settled before its stream is looked at: an
	// OPENED from the opener is never a late frame that crossed on the wire.
	if f.Type == TypeOpened && !acceptor {
		return unexpected
	}
	if f.Stream > l.highest {
		return Verdict{Conn: BadStreamID}
	}
	s, open := l.streams[f.Stream]
	if !open {
		return Verdict{Ignored: true}
	}
	fault, closed := s.apply(from, acceptor, f)
	if closed {
		delete(l.streams, f.Stream)
	} else {
		l.streams[f.Stream] = s
	}
	return Verdict{Reset: fault}
}

// apply moves an open stream forward by one frame. It returns the stream
// error the frame causes, if any, and whether the stream is closed after it.
func (s *stream) apply(from Side, acceptor bool, f *Frame) (ResetCode, bool) {
	if f.Type == TypeReset {
		return 0, true
	}
	if acceptor && !s.opened && f.Type != TypeOpened {
		return ResetProtocol, true
	}
	switch f.Type {
	case TypeOpened:
		if s.opened {
			return ResetProtocol, true
		}
		s.opened = true
	case TypeData:
		size := uint32(len(f.Data))
		if size > s.credit[from] {
			return ResetFlowControl, true
		}
		if s.ended[from] {
			return ResetProtocol, true
		}
		s.credit[from] -= size
	case TypeWindow:
		// WINDOW pays for the DATA of the other side. Credit never passes
		// MaxCredit, so this subtraction cannot wrap, on 32 bits or 64.
		receiver := from.peer()
		if f.Credit > MaxCredit-s.credit[receiver] {
			return ResetFlowControl, true
		}
		s.credit[receiver] += f.Credit
	case TypeEnd:
		if s.ended[from] {
			return ResetProtocol, true
		}
		s.ended[from] = true
	}
	return 0, s.ended[Dialer] && s.ended[Relay]
}
