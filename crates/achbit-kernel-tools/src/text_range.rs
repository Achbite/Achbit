use crate::file_content::{
    binary_magic, has_high_control_byte_ratio, lightweight_file_classification,
};
use serde_json::{json, Value};
use std::fs::File;
use std::io::{BufReader, Read};
use std::path::Path;

/// Read a UTF-8 window without allocating the file or even an unbounded line.
/// Scan the file for UTF-8 validity and range metadata while retaining only the window.
pub fn read_text_range(
    path: &Path,
    start_line: u64,
    start_byte: Option<u64>,
    max_lines: usize,
    max_bytes: usize,
) -> Result<Value, String> {
    if start_line == 0
        || max_lines == 0
        || max_lines > 5000
        || !(1024..=1048576).contains(&max_bytes)
    {
        return Err("invalid_text_read_range".into());
    }
    let file = File::open(path).map_err(|error| error.to_string())?;
    let metadata = file.metadata().map_err(|error| error.to_string())?;
    if !metadata.is_file() {
        return Err("not_regular_file".into());
    }
    let mut reader = BufReader::new(file);
    let mut chunk = [0u8; 8192];
    let mut output = Vec::with_capacity(max_bytes);
    let mut utf8_tail = Vec::new();
    let mut offset = 0u64;
    let mut line = 1u64;
    let mut selected_start = None;
    let mut selected_line = start_line;
    let mut returned_breaks = 0usize;
    let mut classification = lightweight_file_classification(path, &metadata);
    if classification.binary {
        return Err("unsupported_file_content: binary_extension".into());
    }
    let mut script = false;
    loop {
        let count = reader.read(&mut chunk).map_err(|error| error.to_string())?;
        if count == 0 {
            break;
        }
        let bytes = &chunk[..count];
        if offset == 0 {
            if binary_magic(bytes).is_some() || has_high_control_byte_ratio(bytes) {
                return Err("unsupported_file_content: binary_content".into());
            }
            script = bytes.starts_with(b"#!");
        }
        if bytes.contains(&0) {
            return Err("unsupported_file_content: binary_content".into());
        }
        utf8_tail.extend_from_slice(bytes);
        match std::str::from_utf8(&utf8_tail) {
            Ok(_) => utf8_tail.clear(),
            Err(error) if error.error_len().is_none() => {
                utf8_tail.drain(..error.valid_up_to());
            }
            Err(_) => return Err("unsupported_file_content: invalid_utf8".into()),
        }
        for &byte in bytes {
            let reached = start_byte.map_or(line >= start_line, |start| offset >= start);
            if reached && selected_start.is_none() {
                if byte & 0xc0 == 0x80 {
                    return Err("startByte_not_utf8_boundary".into());
                }
                selected_start = Some(offset);
                selected_line = line;
            }
            if reached && returned_breaks < max_lines && output.len() < max_bytes {
                output.push(byte);
                if byte == b'\n' {
                    returned_breaks += 1;
                }
            }
            if byte == b'\n' {
                line += 1;
            }
            offset += 1;
        }
    }
    if !utf8_tail.is_empty() {
        return Err("unsupported_file_content: invalid_utf8".into());
    }
    if start_byte.is_some_and(|start| start > offset) || (start_byte.is_none() && start_line > line)
    {
        return Err("text_read_range_beyond_end".into());
    }
    // A byte window may end inside a scalar; leave that scalar for nextByte.
    let valid = std::str::from_utf8(&output).map_or_else(|error| error.valid_up_to(), str::len);
    output.truncate(valid);
    let content = String::from_utf8(output).map_err(|error| error.to_string())?;
    let start = selected_start.unwrap_or(offset);
    let end = start + content.len() as u64;
    let truncated = end < offset;
    let byte_truncated = truncated && returned_breaks < max_lines;
    classification.kind = if classification.executable {
        if script {
            "textExecutableScript"
        } else {
            "textExecutable"
        }
    } else {
        "text"
    }
    .into();
    classification.readable_text = true;
    classification.binary = false;
    classification.reason = None;
    classification.size_bytes = offset;
    let breaks = content.bytes().filter(|byte| *byte == b'\n').count();
    let end_line = selected_line + breaks as u64 - u64::from(content.ends_with('\n'));
    let mut result = json!({ "content": content, "sizeBytes": content.len(), "fileSizeBytes": offset,
        "startLine": selected_line, "endLine": if content.is_empty() { selected_line.saturating_sub(1) } else { end_line },
        "startByte": start, "endByte": end, "maxLines": max_lines, "maxBytes": max_bytes,
        "truncated": truncated, "byteTruncated": byte_truncated, "binary": false,
        "fileClassification": classification });
    if truncated {
        result["nextByte"] = json!(end);
        if !byte_truncated {
            result["nextStartLine"] = json!(end_line + 1);
        }
    }
    Ok(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Sample(std::path::PathBuf);
    impl Drop for Sample {
        fn drop(&mut self) {
            let _ = std::fs::remove_file(&self.0);
        }
    }
    #[test]
    fn large_utf8_line_is_read_completely_in_bounded_windows() {
        let path = std::env::temp_dir().join(format!(
            "deepcode-range-{}-{}.txt",
            std::process::id(),
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos()
        ));
        let sample = Sample(path);
        let content = "中文🙂".repeat(450_000);
        std::fs::write(&sample.0, &content).unwrap();
        let mut next = None;
        let mut recovered = String::new();
        loop {
            let value = read_text_range(&sample.0, 1, next, 2000, 1_048_576).unwrap();
            let text = value["content"].as_str().unwrap();
            assert!(text.len() <= 1_048_576);
            assert!(!text.is_empty());
            recovered.push_str(text);
            match value["nextByte"].as_u64() {
                Some(offset) => {
                    assert!(offset > next.unwrap_or(0));
                    next = Some(offset);
                }
                None => break,
            }
        }
        assert_eq!(recovered, content);
        assert!(read_text_range(&sample.0, 1, Some(1), 2000, 1024)
            .unwrap_err()
            .contains("utf8_boundary"));
    }
}
