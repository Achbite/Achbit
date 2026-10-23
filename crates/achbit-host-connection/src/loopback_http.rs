//! Bounded HTTP exchange for synchronous Host startup and shutdown requests.
use serde::de::DeserializeOwned;
use std::io::{self, Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::time::{Duration, Instant};

pub fn parse_port(value: &str) -> io::Result<u16> {
    value.parse::<u16>().map_err(|error| {
        io::Error::new(
            io::ErrorKind::InvalidInput,
            format!("Invalid Host port {value:?}: {error}"),
        )
    })
}

pub fn connect_loopback(host: &str, port: &str, timeout: Duration) -> io::Result<TcpStream> {
    connect_loopback_until(host, port, Instant::now() + timeout)
}

pub fn connect_loopback_until(host: &str, port: &str, deadline: Instant) -> io::Result<TcpStream> {
    let port = parse_port(port)?;
    let addresses = (host, port)
        .to_socket_addrs()
        .map_err(|error| super::host_io_error(format!("Resolve Host {host}:{port}"), error))?;
    let mut last_error = io::Error::new(
        io::ErrorKind::AddrNotAvailable,
        "Host address did not resolve",
    );
    for address in addresses {
        match TcpStream::connect_timeout(&address, crate::startup::remaining(deadline)?) {
            Ok(stream) => return Ok(stream),
            Err(error) => {
                let unavailable = matches!(
                    error.kind(),
                    io::ErrorKind::ConnectionRefused | io::ErrorKind::TimedOut
                );
                let error = super::host_io_error(format!("Connect Host {address}"), error);
                if !unavailable {
                    return Err(error);
                }
                last_error = error;
            }
        }
    }
    Err(last_error)
}

pub fn probe_loopback_listener(host: &str, port: &str) -> io::Result<bool> {
    match connect_loopback(host, port, Duration::from_millis(180)) {
        Ok(_) => Ok(true),
        Err(error)
            if matches!(
                error.kind(),
                io::ErrorKind::ConnectionRefused | io::ErrorKind::TimedOut
            ) =>
        {
            Ok(false)
        }
        Err(error) => Err(error),
    }
}

pub fn request_loopback_json<T: DeserializeOwned>(
    host: &str,
    port: &str,
    request: &str,
    read_timeout_millis: u64,
) -> io::Result<T> {
    let stream = connect_loopback(host, port, Duration::from_millis(180))?;
    request_connected_json(stream, request, read_timeout_millis)
}

pub fn request_connected_json<T: DeserializeOwned>(
    mut stream: TcpStream,
    request: &str,
    read_timeout_millis: u64,
) -> io::Result<T> {
    stream.set_read_timeout(Some(Duration::from_millis(read_timeout_millis)))?;
    stream.set_write_timeout(Some(Duration::from_millis(300)))?;
    stream.write_all(request.as_bytes())?;
    let mut response = Vec::with_capacity(4096);
    stream.take(64 * 1024 + 1).read_to_end(&mut response)?;
    if response.len() > 64 * 1024 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Host HTTP response exceeds 64 KiB",
        ));
    }
    decode_response(&response)
}

fn decode_response<T: DeserializeOwned>(response: &[u8]) -> io::Result<T> {
    let body_offset = response
        .windows(4)
        .position(|window| window == b"\r\n\r\n")
        .ok_or_else(|| {
            io::Error::new(
                io::ErrorKind::InvalidData,
                "Host HTTP response has no header terminator",
            )
        })?
        + 4;
    if !response.starts_with(b"HTTP/1.1 200 ") {
        let status_end = response
            .windows(2)
            .position(|window| window == b"\r\n")
            .unwrap_or(body_offset - 4);
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            format!(
                "Host HTTP request failed: {}",
                String::from_utf8_lossy(&response[..status_end])
            ),
        ));
    }
    serde_json::from_slice(&response[body_offset..])
        .map_err(|error| io::Error::new(io::ErrorKind::InvalidData, error))
}

/// One absolute deadline covers connect, every write, and every read.
pub fn request_loopback_json_until<T: DeserializeOwned>(
    host: &str,
    port: &str,
    request: &str,
    deadline: Instant,
) -> io::Result<T> {
    let stream = connect_loopback_until(
        host,
        port,
        deadline.min(Instant::now() + Duration::from_millis(180)),
    )?;
    request_connected_json_until(stream, request, deadline)
}

pub fn request_connected_json_until<T: DeserializeOwned>(
    mut stream: TcpStream,
    request: &str,
    deadline: Instant,
) -> io::Result<T> {
    let mut bytes = request.as_bytes();
    while !bytes.is_empty() {
        stream.set_write_timeout(Some(crate::startup::remaining(deadline)?))?;
        let count = stream.write(bytes)?;
        if count == 0 {
            return Err(io::Error::new(
                io::ErrorKind::WriteZero,
                "Host request write returned zero",
            ));
        }
        bytes = &bytes[count..];
    }
    let mut response = Vec::with_capacity(4096);
    let mut buffer = [0; 4096];
    loop {
        stream.set_read_timeout(Some(crate::startup::remaining(deadline)?))?;
        let count = stream.read(&mut buffer)?;
        if count == 0 {
            break;
        }
        response.extend_from_slice(&buffer[..count]);
        if response.len() > 64 * 1024 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Host HTTP response exceeds 64 KiB",
            ));
        }
    }
    decode_response(&response)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::net::TcpListener;

    #[test]
    fn startup_http_deadline_bounds_a_trickling_response() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port().to_string();
        let server = std::thread::spawn(move || {
            let (mut stream, _) = listener.accept().unwrap();
            let mut request = [0; 512];
            stream.read(&mut request).unwrap();
            for _ in 0..10 {
                if stream.write_all(b" ").is_err() {
                    break;
                }
                std::thread::sleep(Duration::from_millis(30));
            }
        });
        let start = Instant::now();
        let error = request_loopback_json_until::<serde_json::Value>(
            "127.0.0.1",
            &port,
            "GET / HTTP/1.1\r\nConnection: close\r\n\r\n",
            start + Duration::from_millis(100),
        )
        .unwrap_err();
        assert!(crate::startup::transport_pending(&error));
        assert!(start.elapsed() < Duration::from_millis(300));
        server.join().unwrap();
    }

    #[test]
    fn listener_probe_keeps_invalid_ports_distinct_from_absent_listeners() {
        for port in ["", "invalid", "65536"] {
            let error = probe_loopback_listener("127.0.0.1", port).unwrap_err();
            assert_eq!(error.kind(), io::ErrorKind::InvalidInput);
            assert!(error.to_string().contains("Invalid Host port"));
        }
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port().to_string();
        assert!(probe_loopback_listener("127.0.0.1", &port).unwrap());
        drop(listener);
        assert!(!probe_loopback_listener("127.0.0.1", &port).unwrap());
    }

    #[test]
    fn shared_exchange_preserves_json_status_and_decode_failures() {
        for (response, expected) in [
            (
                "HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n{\"ok\":true}",
                None,
            ),
            (
                "HTTP/1.1 503 Unavailable\r\nConnection: close\r\n\r\n{}",
                Some("503 Unavailable"),
            ),
            ("HTTP/1.1 200 OK\r\nConnection: close\r\n\r\n{", Some("EOF")),
        ] {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port().to_string();
            let server = std::thread::spawn(move || {
                let (mut stream, _) = listener.accept().unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(2)))
                    .unwrap();
                let mut request = Vec::new();
                while !request.ends_with(b"\r\n\r\n") {
                    let mut byte = [0];
                    stream.read_exact(&mut byte).unwrap();
                    request.push(byte[0]);
                }
                stream.write_all(response.as_bytes()).unwrap();
            });
            let result = request_loopback_json::<serde_json::Value>(
                "127.0.0.1",
                &port,
                "GET /api/health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
                2000,
            );
            server.join().unwrap();
            match expected {
                Some(message) => assert!(result.unwrap_err().to_string().contains(message)),
                None => assert_eq!(result.unwrap(), serde_json::json!({"ok": true})),
            }
        }
    }
}
