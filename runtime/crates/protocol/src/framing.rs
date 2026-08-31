use serde::Serialize;
use serde::de::DeserializeOwned;
use thiserror::Error;
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use crate::MAX_FRAME_BYTES;

#[derive(Debug, Error)]
pub enum FrameError {
    #[error("protocol stream ended")]
    EndOfStream,
    #[error("protocol frame exceeds {MAX_FRAME_BYTES} bytes")]
    FrameTooLarge,
    #[error("protocol frame contains invalid JSON: {0}")]
    InvalidJson(#[from] serde_json::Error),
    #[error("protocol I/O failed: {0}")]
    Io(#[from] std::io::Error),
}

pub async fn read_frame<R, T>(reader: &mut R) -> Result<T, FrameError>
where
    R: AsyncRead + Unpin,
    T: DeserializeOwned,
{
    let mut length = [0_u8; 4];
    match reader.read_exact(&mut length).await {
        Ok(_) => {}
        Err(error) if error.kind() == std::io::ErrorKind::UnexpectedEof => {
            return Err(FrameError::EndOfStream);
        }
        Err(error) => return Err(FrameError::Io(error)),
    }
    let length = u32::from_le_bytes(length) as usize;
    if length > MAX_FRAME_BYTES {
        return Err(FrameError::FrameTooLarge);
    }
    let mut payload = vec![0_u8; length];
    reader.read_exact(&mut payload).await?;
    Ok(serde_json::from_slice(&payload)?)
}

pub async fn write_frame<W, T>(writer: &mut W, value: &T) -> Result<(), FrameError>
where
    W: AsyncWrite + Unpin,
    T: Serialize,
{
    let payload = serde_json::to_vec(value)?;
    let length = u32::try_from(payload.len()).map_err(|_| FrameError::FrameTooLarge)?;
    if payload.len() > MAX_FRAME_BYTES {
        return Err(FrameError::FrameTooLarge);
    }
    writer.write_all(&length.to_le_bytes()).await?;
    writer.write_all(&payload).await?;
    writer.flush().await?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use serde_json::json;
    use tokio::io::duplex;

    use super::{read_frame, write_frame};

    #[tokio::test]
    async fn round_trip() {
        let (mut left, mut right) = duplex(1024);
        let expected = json!({"type": "request", "id": "c:1"});
        write_frame(&mut left, &expected)
            .await
            .expect("write frame");
        let actual: serde_json::Value = read_frame(&mut right).await.expect("read frame");
        assert_eq!(expected, actual);
    }
}
