//! Transport evidence retained with a Session's outputs. This is not a semantic
//! journal: Session remains the sole owner of conversation state and replay.
use base64::Engine;
use serde_json::{json, Value};
use std::fs::{File, OpenOptions};
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::time::{Instant, SystemTime, UNIX_EPOCH};

pub struct ExecutionArchive {
    file: Option<File>,
    path: Option<PathBuf>,
    started: Instant,
    sequence: u64,
    finished: bool,
}

impl ExecutionArchive {
    /// The caller supplies the existing Session/attempt-owned output directory.
    /// None is used by callers that do not retain outputs (e.g. direct tool tests).
    pub fn open(directory: Option<&Path>, identity: Value) -> io::Result<Self> {
        let path = directory.map(|directory| directory.join("timeline.jsonl"));
        let file = if let Some(path) = &path {
            std::fs::create_dir_all(path.parent().expect("archive parent"))?;
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            Some(options.open(path)?)
        } else {
            None
        };
        let mut archive = Self {
            file,
            path,
            started: Instant::now(),
            sequence: 0,
            finished: false,
        };
        archive.record("archive.opened", identity)?;
        Ok(archive)
    }

    pub fn path(&self) -> Option<&Path> {
        self.path.as_deref()
    }

    /// One write per event; no per-token fsync or cumulative transcript rewrite.
    pub fn record(&mut self, kind: &str, data: Value) -> io::Result<()> {
        let Some(file) = &mut self.file else {
            return Ok(());
        };
        let mut line = serde_json::to_vec(&json!({
            "sequence": self.sequence,
            "occurredAtMs": SystemTime::now().duration_since(UNIX_EPOCH).unwrap_or_default().as_millis(),
            "elapsedMicros": self.started.elapsed().as_micros(),
            "type": kind,
            "data": data,
        }))?;
        line.push(b'\n');
        file.write_all(&line)?;
        self.sequence += 1;
        Ok(())
    }

    /// Bytes are preserved across UTF-8 and SSE boundaries, including invalid
    /// payloads that cannot be represented by normalized Provider events.
    pub fn bytes(&mut self, kind: &str, bytes: &[u8]) -> io::Result<()> {
        self.record(
            kind,
            json!({
                "byteLength": bytes.len(),
                "base64": base64::engine::general_purpose::STANDARD.encode(bytes),
            }),
        )
    }

    pub fn finish(&mut self, outcome: &str, data: Value) -> io::Result<()> {
        self.record(
            "archive.closed",
            json!({ "outcome": outcome, "detail": data }),
        )?;
        self.finished = true;
        Ok(())
    }
}

impl Drop for ExecutionArchive {
    fn drop(&mut self) {
        if !self.finished {
            // Includes a dropped HTTP response stream. A hard process crash is
            // instead identifiable by the absence of archive.closed.
            if let Err(error) = self.finish(
                "interrupted",
                json!({
                    "reason": "archive owner dropped before a terminal result"
                }),
            ) {
                eprintln!("execution archive close failed: {error}");
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn timeline_retains_bytes_order_identity_and_drop_without_overwriting() {
        let directory = std::env::temp_dir().join(format!(
            "deepcode-archive-{}-{}",
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        {
            let mut archive =
                ExecutionArchive::open(Some(&directory), json!({"requestId":"request:1"})).unwrap();
            archive.bytes("response.chunk", &[0xe4, 0xb8]).unwrap();
            archive.bytes("response.chunk", &[0xad, 0xff]).unwrap();
            assert!(ExecutionArchive::open(Some(&directory), json!({})).is_err());
        }
        let lines: Vec<Value> = std::fs::read_to_string(directory.join("timeline.jsonl"))
            .unwrap()
            .lines()
            .map(|line| serde_json::from_str(line).unwrap())
            .collect();
        assert_eq!(lines[0]["data"]["requestId"], "request:1");
        let mut bytes = Vec::new();
        for line in &lines[1..3] {
            bytes.extend(
                base64::engine::general_purpose::STANDARD
                    .decode(line["data"]["base64"].as_str().unwrap())
                    .unwrap(),
            );
        }
        assert_eq!(bytes, [0xe4, 0xb8, 0xad, 0xff]);
        for (index, line) in lines.iter().enumerate() {
            assert_eq!(line["sequence"], index);
            if index > 0 {
                assert!(
                    line["elapsedMicros"].as_u64().unwrap()
                        >= lines[index - 1]["elapsedMicros"].as_u64().unwrap()
                );
            }
        }
        assert_eq!(lines.last().unwrap()["data"]["outcome"], "interrupted");
        std::fs::remove_dir_all(directory).unwrap();
    }
}
