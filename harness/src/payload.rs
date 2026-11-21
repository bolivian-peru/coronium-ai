//! A body both ends can produce, so a delivery is checked by hash and the
//! body itself is never shared.
//!
//! The body for a `(seed, length)` pair is the first `length` bytes of a
//! stream that depends only on `seed`: word `k` of the stream is SplitMix64
//! applied to `seed + (k + 1) * GAMMA`, written little-endian. Every byte is
//! a function of the seed and its own offset, so the body is the same however
//! it is cut into pieces, and producing it needs no memory beyond the piece
//! being written.

use sha2::{Digest, Sha256};

/// The SplitMix64 increment.
const GAMMA: u64 = 0x9e37_79b9_7f4a_7c15;

/// The bytes of one body that have not been produced yet.
#[derive(Debug)]
pub struct Payload {
    seed: u64,
    offset: u64,
    length: u64,
}

impl Payload {
    pub fn new(seed: u64, length: u64) -> Self {
        Self {
            seed,
            offset: 0,
            length,
        }
    }

    /// How many bytes are still to come.
    pub fn remaining(&self) -> u64 {
        self.length - self.offset
    }

    /// Appends the next `limit` bytes of the body to `out`, or all that is
    /// left of it when that is less.
    pub fn append(&mut self, out: &mut Vec<u8>, limit: usize) {
        let count = usize::try_from(self.remaining()).map_or(limit, |left| left.min(limit));
        let mut at = out.len();
        out.resize(at + count, 0);
        while at < out.len() {
            let word = word(self.seed, self.offset / 8);
            // A piece can start or stop in the middle of a word.
            let skip = (self.offset % 8) as usize;
            let take = (8 - skip).min(out.len() - at);
            out[at..at + take].copy_from_slice(&word[skip..skip + take]);
            at += take;
            self.offset += take as u64;
        }
    }
}

/// Word `index` of the stream for `seed`.
fn word(seed: u64, index: u64) -> [u8; 8] {
    let mut z = seed.wrapping_add(index.wrapping_add(1).wrapping_mul(GAMMA));
    z = (z ^ (z >> 30)).wrapping_mul(0xbf58_476d_1ce4_e5b9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94d0_49bb_1331_11eb);
    (z ^ (z >> 31)).to_le_bytes()
}

/// The SHA-256 of the body for `(seed, length)`.
pub fn sha256(seed: u64, length: u64) -> [u8; 32] {
    let mut body = Payload::new(seed, length);
    let mut hasher = Sha256::new();
    let mut piece = Vec::new();
    while body.remaining() > 0 {
        piece.clear();
        body.append(&mut piece, 4096);
        hasher.update(&piece);
    }
    hasher.finalize().into()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn whole(seed: u64, length: usize) -> Vec<u8> {
        let mut body = Vec::new();
        Payload::new(seed, length as u64).append(&mut body, usize::MAX);
        assert_eq!(body.len(), length);
        body
    }

    /// These were computed by a separate implementation of the rule at the
    /// top of this file. A change to the generator must not pass unnoticed:
    /// the two ends of a test may be built from different commits.
    #[test]
    fn the_body_is_pinned() {
        assert_eq!(
            hex::encode(whole(7, 20)),
            "d70d3259e4e1cb631c663cf4d73c4c04022ab1ba"
        );
        assert_eq!(
            hex::encode(sha256(7, 100_000)),
            "5fa36b882964d3748947cdcd5199904690672b309ece4578d7820825334cad98"
        );
        assert_eq!(
            hex::encode(sha256(0, 0)),
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
    }

    #[test]
    fn the_body_does_not_depend_on_how_it_is_cut() {
        let expected = whole(42, 1000);
        for piece in [1, 3, 7, 8, 9, 64, 999, 1000, 4096] {
            let mut body = Payload::new(42, 1000);
            let mut got = Vec::new();
            while body.remaining() > 0 {
                body.append(&mut got, piece);
            }
            assert_eq!(got, expected, "pieces of {piece}");
        }
    }

    #[test]
    fn the_hash_is_the_hash_of_the_body() {
        for length in [0, 1, 4095, 4096, 4097, 20_000] {
            let digest: [u8; 32] = Sha256::digest(whole(9, length)).into();
            assert_eq!(sha256(9, length as u64), digest, "length {length}");
        }
    }

    #[test]
    fn each_seed_has_its_own_body() {
        assert_ne!(whole(1, 64), whole(2, 64));
        assert_ne!(sha256(1, 64), sha256(2, 64));
    }
}
