//! Frames over a byte stream: a reader and a writer for tokio.
//!
//! The reader asks the stream for one frame at a time and for nothing beyond
//! it: the 8 header bytes first, then, only when the header passed steps 2 to
//! 5 of section 3.1, the payload. So its buffer starts at 8 bytes, grows to
//! what an accepted header announced, and never holds more than one frame. A
//! peer that announces an oversized or unknown frame is refused before a
//! single payload byte is read or any memory is set aside for it.

use std::io;

use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use crate::frame::{self, ConnectionError, Frame, HEADER_LEN, InvalidFrame, Progress};

/// Why no frame could be read.
#[derive(Debug, thiserror::Error)]
pub enum ReadError {
    /// The peer broke section 3.1. The answer is GOAWAY `protocol_error`.
    #[error("{0}")]
    Protocol(#[from] ConnectionError),
    /// The stream failed, or ended in the middle of a frame.
    #[error(transparent)]
    Io(#[from] io::Error),
}

/// Why a frame was not written.
#[derive(Debug, thiserror::Error)]
pub enum WriteError {
    /// The frame has no encoding. Nothing was written.
    #[error(transparent)]
    Invalid(#[from] InvalidFrame),
    #[error(transparent)]
    Io(#[from] io::Error),
}

/// Reads frames from a byte stream.
pub struct FrameReader<R> {
    io: R,
    /// The bytes of the frame being read are `buf[..filled]`.
    buf: Vec<u8>,
    filled: usize,
}

impl<R: AsyncRead + Unpin> FrameReader<R> {
    pub fn new(io: R) -> Self {
        Self {
            io,
            buf: vec![0; HEADER_LEN],
            filled: 0,
        }
    }

    /// Reads the next frame. `Ok(None)` means the stream ended cleanly, on a
    /// frame boundary.
    ///
    /// Dropping this future loses nothing: the bytes of a half-read frame stay
    /// in the reader, so it is safe to race against a timer.
    pub async fn read_frame(&mut self) -> Result<Option<Frame>, ReadError> {
        loop {
            let wanted = match frame::progress(&self.buf[..self.filled])? {
                Progress::Frame(frame, _) => {
                    self.filled = 0;
                    return Ok(Some(frame));
                }
                Progress::Wants(wanted) => wanted,
            };
            if self.buf.len() < wanted {
                // Exact, because the usual doubling could pass the size of one frame.
                self.buf.reserve_exact(wanted - self.buf.len());
                self.buf.resize(wanted, 0);
            }
            let count = self.io.read(&mut self.buf[self.filled..wanted]).await?;
            if count == 0 {
                if self.filled == 0 {
                    return Ok(None);
                }
                return Err(io::Error::from(io::ErrorKind::UnexpectedEof).into());
            }
            self.filled += count;
        }
    }
}

/// Writes frames to a byte stream.
pub struct FrameWriter<W> {
    io: W,
    /// Reused for every frame, so a write does not allocate.
    buf: Vec<u8>,
}

impl<W: AsyncWrite + Unpin> FrameWriter<W> {
    pub fn new(io: W) -> Self {
        Self {
            io,
            buf: Vec::new(),
        }
    }

    /// Writes one frame and flushes it.
    ///
    /// Dropping this future can leave part of a frame on the stream. The
    /// connection is then unusable and must be closed.
    pub async fn write_frame(&mut self, frame: &Frame) -> Result<(), WriteError> {
        self.buf.clear();
        frame.encode(&mut self.buf)?;
        self.io.write_all(&self.buf).await?;
        self.io.flush().await?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use bytes::Bytes;

    use super::*;
    use crate::frame::{MAX_FRAME_LEN, MAX_PAYLOAD};

    fn data(length: usize) -> Frame {
        Frame::Data {
            stream: 1,
            payload: Bytes::from(vec![0x5a; length]),
        }
    }

    /// The buffer is the one thing a peer can make a reader allocate, so its
    /// size is checked from the inside, where the capacity is visible.
    #[tokio::test]
    async fn the_read_buffer_starts_small_and_never_passes_one_frame() {
        let frames = [
            data(1),
            data(5000),
            Frame::End { stream: 1 },
            data(MAX_PAYLOAD - 1),
            data(MAX_PAYLOAD),
            data(9000),
        ];
        let mut wire = Vec::new();
        for frame in &frames {
            frame.encode(&mut wire).unwrap();
        }

        let mut reader = FrameReader::new(wire.as_slice());
        assert_eq!(reader.buf.capacity(), HEADER_LEN);
        for frame in &frames {
            assert_eq!(reader.read_frame().await.unwrap().as_ref(), Some(frame));
            assert!(reader.buf.capacity() <= MAX_FRAME_LEN);
        }
        assert_eq!(reader.buf.capacity(), MAX_FRAME_LEN);
        assert!(reader.read_frame().await.unwrap().is_none());
    }

    #[tokio::test]
    async fn a_refused_header_leaves_the_buffer_at_its_first_size() {
        // DATA on stream 1 announcing 16385 bytes, with the payload behind it.
        let mut wire = vec![0x12, 0, 0, 0, 0, 1, 0x40, 0x01];
        wire.resize(HEADER_LEN + MAX_PAYLOAD + 1, 0);

        let mut reader = FrameReader::new(wire.as_slice());
        let error = reader.read_frame().await.unwrap_err();
        assert!(matches!(
            error,
            ReadError::Protocol(ConnectionError::FrameTooLarge)
        ));
        assert_eq!(reader.buf.capacity(), HEADER_LEN);
    }
}
