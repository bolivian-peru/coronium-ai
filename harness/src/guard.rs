//! The addresses the harness may connect to.
//!
//! A [`TestAddr`] can only be made from a loopback or private address, and
//! [`TestAddr::connect`] is the only place in this crate that opens a
//! connection. So neither tool can be pointed at production or at a real
//! device, whatever its flags say.

use std::io;
use std::net::{IpAddr, SocketAddr};
use std::str::FromStr;

use tokio::net::TcpStream;

use crate::Refusal;

/// An address on test hardware: loopback, RFC 1918 or IPv6 unique-local.
#[derive(Debug, Clone, Copy)]
pub struct TestAddr(SocketAddr);

impl TestAddr {
    pub fn new(addr: SocketAddr) -> Result<Self, Refusal> {
        if is_test_ip(addr.ip()) {
            return Ok(Self(addr));
        }
        Err(Refusal {
            cause: format!(
                "{addr} is not a loopback or private address, and load is only ever sent to \
                 simulated devices on test hardware"
            ),
            fix: "use an address in 127.0.0.0/8, 10.0.0.0/8, 172.16.0.0/12, 192.168.0.0/16, \
                  ::1 or fc00::/7"
                .to_owned(),
        })
    }

    pub async fn connect(self) -> io::Result<TcpStream> {
        let stream = TcpStream::connect(self.0).await?;
        // Both tools write whole frames and whole requests, so holding small
        // writes back to batch them would only add latency to what is measured.
        stream.set_nodelay(true)?;
        Ok(stream)
    }
}

fn is_test_ip(ip: IpAddr) -> bool {
    // An IPv4-mapped IPv6 address reaches the IPv4 host, so it is judged as one.
    match ip.to_canonical() {
        IpAddr::V4(ip) => ip.is_loopback() || ip.is_private(),
        IpAddr::V6(ip) => ip.is_loopback() || ip.is_unique_local(),
    }
}

/// Names are not resolved: what a name points at can change between the
/// check and the connection.
impl FromStr for TestAddr {
    type Err = Refusal;

    fn from_str(text: &str) -> Result<Self, Refusal> {
        let addr: SocketAddr = text.parse().map_err(|_| Refusal {
            cause: format!("{text:?} is not an IP address and port"),
            fix: "write it as 127.0.0.1:7000 or [::1]:7000 (names are not resolved)".to_owned(),
        })?;
        Self::new(addr)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn allows(ip: &str) -> bool {
        is_test_ip(ip.parse().unwrap())
    }

    #[test]
    fn loopback_and_private_addresses_are_allowed() {
        for ip in [
            "127.0.0.1",
            "127.255.255.254",
            "10.0.0.1",
            "172.16.0.1",
            "172.31.255.254",
            "192.168.0.1",
            "::1",
            "fc00::1",
            "fdff:ffff::1",
            "::ffff:10.0.0.1",
        ] {
            assert!(allows(ip), "{ip}");
        }
    }

    #[test]
    fn everything_else_is_refused() {
        for ip in [
            // The documentation ranges stand for public addresses.
            "192.0.2.1",
            "203.0.113.7",
            "2001:db8::1",
            // Just outside each private range.
            "9.255.255.255",
            "11.0.0.0",
            "172.15.255.255",
            "172.32.0.0",
            "192.167.255.255",
            "192.169.0.0",
            "128.0.0.1",
            "fbff::1",
            "fe00::1",
            // Not public, but not in the list either.
            "0.0.0.0",
            "100.64.0.1",
            "169.254.0.1",
            "fe80::1",
            "::",
            "::ffff:192.0.2.1",
        ] {
            assert!(!allows(ip), "{ip}");
        }
    }

    #[test]
    fn a_refusal_names_the_address_and_the_fix() {
        let refusal = "203.0.113.7:443".parse::<TestAddr>().unwrap_err();
        assert!(refusal.cause.contains("203.0.113.7:443"));
        assert!(refusal.fix.contains("127.0.0.0/8"));

        let refusal = "test.example.com:443".parse::<TestAddr>().unwrap_err();
        assert!(refusal.cause.contains("not an IP address and port"));
    }
}
