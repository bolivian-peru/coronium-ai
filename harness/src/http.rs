//! The little HTTP/1.1 the two tools speak to each other through a tunnel.
//!
//! The load generator writes the request and the simulated device reads it,
//! so both sides of that one line live here and cannot drift apart.

/// The target every CONNECT names. The simulated device plays the target and
/// never dials it, and a name under `.invalid` resolves nowhere, so a request
/// that reached a real device by mistake would still load nobody.
pub(crate) const TARGET: &str = "simdevice.invalid:80";

/// The index just past the blank line that ends a head, once it has arrived.
pub(crate) fn head_end(bytes: &[u8]) -> Option<usize> {
    let blank_line = bytes.windows(4).position(|window| window == b"\r\n\r\n")?;
    Some(blank_line + 4)
}

/// The request for the body of `(seed, length)`.
pub(crate) fn bytes_request(seed: u64, length: u64) -> String {
    format!("GET /bytes/{length}?seed={seed} HTTP/1.1\r\nHost: {TARGET}\r\n\r\n")
}

/// The `(seed, length)` a request head asks for. `None` for any other request.
pub(crate) fn parse_bytes_request(head: &[u8]) -> Option<(u64, u64)> {
    let line = first_line(head)?;
    let path = line.strip_prefix("GET ")?.strip_suffix(" HTTP/1.1")?;
    let (length, seed) = path.strip_prefix("/bytes/")?.split_once("?seed=")?;
    Some((seed.parse().ok()?, length.parse().ok()?))
}

/// The status code of a response head.
pub(crate) fn status(head: &[u8]) -> Option<u16> {
    let mut words = first_line(head)?.split(' ');
    if !words.next()?.starts_with("HTTP/1.") {
        return None;
    }
    words.next()?.parse().ok()
}

/// The `Content-Length` of a response head.
pub(crate) fn content_length(head: &[u8]) -> Option<u64> {
    let head = str::from_utf8(head).ok()?;
    let (_, value) = head
        .split("\r\n")
        .filter_map(|line| line.split_once(':'))
        .find(|(name, _)| name.eq_ignore_ascii_case("content-length"))?;
    value.trim().parse().ok()
}

fn first_line(head: &[u8]) -> Option<&str> {
    str::from_utf8(head).ok()?.split("\r\n").next()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_request_reads_back_as_it_was_written() {
        let request = bytes_request(u64::MAX, 20_000);
        assert_eq!(head_end(request.as_bytes()), Some(request.len()));
        assert_eq!(
            parse_bytes_request(request.as_bytes()),
            Some((u64::MAX, 20_000))
        );
    }

    #[test]
    fn any_other_request_is_not_a_bytes_request() {
        for request in [
            "GET / HTTP/1.1\r\n\r\n",
            "POST /bytes/5?seed=1 HTTP/1.1\r\n\r\n",
            "GET /bytes/5 HTTP/1.1\r\n\r\n",
            "GET /bytes/-5?seed=1 HTTP/1.1\r\n\r\n",
            "GET /bytes/5?seed=1&x=2 HTTP/1.1\r\n\r\n",
            "GET /bytes/5?seed=1 HTTP/1.0\r\n\r\n",
            "GET /bytes/99999999999999999999?seed=1 HTTP/1.1\r\n\r\n",
            "",
        ] {
            assert_eq!(parse_bytes_request(request.as_bytes()), None, "{request:?}");
        }
    }

    #[test]
    fn a_response_head_gives_its_status_and_length() {
        let head = b"HTTP/1.1 200 OK\r\ncontent-LENGTH:  42 \r\nConnection: close\r\n\r\n";
        assert_eq!(status(head), Some(200));
        assert_eq!(content_length(head), Some(42));

        assert_eq!(
            status(b"HTTP/1.1 407 Proxy Authentication Required\r\n\r\n"),
            Some(407)
        );
        assert_eq!(content_length(b"HTTP/1.1 200 OK\r\n\r\n"), None);
        assert_eq!(status(b"ICY 200 OK\r\n\r\n"), None);
        assert_eq!(head_end(b"HTTP/1.1 200 OK\r\nContent-Le"), None);
    }
}
