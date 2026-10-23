//! A shell owns this connection; the Host owns the resulting client lifetime.
use achbit_kernel_abi::{is_valid_host_shell_token, HOST_SHELL_TOKEN_HEADER};
use std::io::{self, Read, Write};
use std::net::{Shutdown, SocketAddr, TcpStream, ToSocketAddrs};
use std::time::{Duration, Instant};

pub const HOST_LIFETIME_ENV: &str = "DEEPCODE_HOST_LIFETIME";

pub struct HostClientLease {
    stream: TcpStream,
}

impl HostClientLease {
    pub fn connect(base_url: &str, token: &str, persistent: bool) -> io::Result<Self> {
        Self::connect_until(
            base_url,
            token,
            persistent,
            Instant::now() + Duration::from_secs(8),
        )
    }

    pub fn connect_until(
        base_url: &str,
        token: &str,
        persistent: bool,
        deadline: Instant,
    ) -> io::Result<Self> {
        if !is_valid_host_shell_token(token) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                "invalid Host shell token",
            ));
        }
        let authority = base_url.strip_prefix("http://").ok_or_else(|| {
            io::Error::new(io::ErrorKind::InvalidInput, "Host must use local HTTP")
        })?;
        let address: SocketAddr = authority
            .to_socket_addrs()?
            .next()
            .filter(|address| address.ip().is_loopback())
            .ok_or_else(|| io::Error::new(io::ErrorKind::InvalidInput, "Host must use loopback"))?;
        let mut stream = TcpStream::connect_timeout(
            &address,
            Duration::from_secs(2).min(crate::startup::remaining(deadline)?),
        )?;

        let mode = if persistent { "persistent" } else { "client" };
        let request = format!("GET /api/host/client?mode={mode} HTTP/1.1\r\nHost: {authority}\r\n{HOST_SHELL_TOKEN_HEADER}: {token}\r\nConnection: keep-alive\r\n\r\n");
        let mut pending = request.as_bytes();
        while !pending.is_empty() {
            stream.set_write_timeout(Some(
                Duration::from_secs(3).min(crate::startup::remaining(deadline)?),
            ))?;
            let count = stream.write(pending)?;
            if count == 0 {
                return Err(io::Error::new(
                    io::ErrorKind::WriteZero,
                    "Host client registration write returned zero",
                ));
            }
            pending = &pending[count..];
        }
        let mut header = Vec::new();
        while !header.ends_with(b"\r\n\r\n") {
            let mut byte = [0];
            stream.set_read_timeout(Some(
                Duration::from_secs(3).min(crate::startup::remaining(deadline)?),
            ))?;
            stream.read_exact(&mut byte)?;
            header.push(byte[0]);
            if header.len() > 16 * 1024 {
                return Err(io::Error::new(
                    io::ErrorKind::InvalidData,
                    "Host client response header too large",
                ));
            }
        }
        if !header.starts_with(b"HTTP/1.1 200 ") {
            return Err(io::Error::new(
                io::ErrorKind::ConnectionRefused,
                "Host rejected client lifetime registration",
            ));
        }
        stream.set_read_timeout(None)?;
        Ok(Self { stream })
    }
}

impl Drop for HostClientLease {
    fn drop(&mut self) {
        let _ = self.stream.shutdown(Shutdown::Both);
    }
}
