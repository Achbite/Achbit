use serde::{Deserialize, Serialize};
use std::ffi::OsStr;
use std::fs;
use std::path::Path;

pub const MAX_LLM_TEXT_FILE_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct FileContentClassification {
    pub kind: String,
    pub readable_text: bool,
    pub binary: bool,
    pub executable: bool,
    pub size_bytes: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub extension: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub magic: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub reason: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SafeTextFile {
    pub content: String,
    pub classification: FileContentClassification,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FileContentSkip {
    pub reason: String,
    pub message: String,
    pub classification: Box<FileContentClassification>,
}

pub fn read_text_file_for_llm(path: &Path) -> Result<SafeTextFile, FileContentSkip> {
    let metadata = match fs::metadata(path) {
        Ok(metadata) => metadata,
        Err(error) => {
            return Err(skip(
                path,
                0,
                false,
                "stat_failed",
                format!("stat {}: {error}", path.display()),
                None,
                None,
            ));
        }
    };
    if !metadata.is_file() {
        return Err(skip(
            path,
            metadata.len(),
            executable_bit(&metadata),
            "not_regular_file",
            format!("{} is not a regular file", path.display()),
            None,
            None,
        ));
    }

    let executable = executable_bit(&metadata);
    let extension = lower_extension(path);
    if let Some(extension) = extension.as_deref() {
        if binary_extension(extension) {
            return Err(skip(
                path,
                metadata.len(),
                executable,
                "binary_extension",
                format!(
                    "{} is treated as binary content by extension .{extension}",
                    path.display()
                ),
                Some(extension.to_string()),
                None,
            ));
        }
    }

    if metadata.len() > MAX_LLM_TEXT_FILE_BYTES {
        return Err(skip(
            path,
            metadata.len(),
            executable,
            "too_large",
            format!(
                "{} is larger than the Kernel text read limit of {} bytes",
                path.display(),
                MAX_LLM_TEXT_FILE_BYTES
            ),
            extension,
            None,
        ));
    }

    let bytes = match fs::read(path) {
        Ok(bytes) => bytes,
        Err(error) => {
            return Err(skip(
                path,
                metadata.len(),
                executable,
                "read_failed",
                format!("read {}: {error}", path.display()),
                extension,
                None,
            ));
        }
    };

    if let Some(magic) = binary_magic(&bytes) {
        return Err(skip(
            path,
            metadata.len(),
            executable,
            "binary_magic",
            format!("{} is binary content ({magic})", path.display()),
            extension,
            Some(magic.to_string()),
        ));
    }

    if bytes.contains(&0) {
        return Err(skip(
            path,
            metadata.len(),
            executable,
            "binary_content",
            format!("{} contains NUL bytes", path.display()),
            extension,
            None,
        ));
    }

    if has_high_control_byte_ratio(&bytes) {
        return Err(skip(
            path,
            metadata.len(),
            executable,
            "binary_content",
            format!(
                "{} contains too many non-text control bytes",
                path.display()
            ),
            extension,
            None,
        ));
    }

    let content = match String::from_utf8(bytes) {
        Ok(content) => content,
        Err(error) => {
            return Err(skip(
                path,
                metadata.len(),
                executable,
                "invalid_utf8",
                format!("{} is not valid UTF-8 text: {error}", path.display()),
                extension,
                None,
            ));
        }
    };
    let kind = if executable {
        if content.starts_with("#!") {
            "textExecutableScript"
        } else {
            "textExecutable"
        }
    } else {
        "text"
    };
    Ok(SafeTextFile {
        content,
        classification: FileContentClassification {
            kind: kind.to_string(),
            readable_text: true,
            binary: false,
            executable,
            size_bytes: metadata.len(),
            extension,
            magic: None,
            reason: None,
        },
    })
}

pub fn lightweight_file_classification(
    path: &Path,
    metadata: &fs::Metadata,
) -> FileContentClassification {
    let executable = executable_bit(metadata);
    let extension = lower_extension(path);
    let binary_by_extension = extension.as_deref().is_some_and(binary_extension);
    let too_large = metadata.len() > MAX_LLM_TEXT_FILE_BYTES;
    let (kind, readable_text, binary, reason) = if !metadata.is_file() {
        (
            "nonRegular",
            false,
            false,
            Some("not_regular_file".to_string()),
        )
    } else if binary_by_extension {
        (
            "binaryCandidate",
            false,
            true,
            Some("binary_extension".to_string()),
        )
    } else if too_large {
        ("largeFile", false, false, Some("too_large".to_string()))
    } else if executable {
        ("executableCandidate", true, false, None)
    } else {
        ("file", true, false, None)
    };
    FileContentClassification {
        kind: kind.to_string(),
        readable_text,
        binary,
        executable,
        size_bytes: metadata.len(),
        extension,
        magic: None,
        reason,
    }
}

fn skip(
    path: &Path,
    size_bytes: u64,
    executable: bool,
    reason: &str,
    message: String,
    extension: Option<String>,
    magic: Option<String>,
) -> FileContentSkip {
    FileContentSkip {
        reason: reason.to_string(),
        message,
        classification: Box::new(FileContentClassification {
            kind: skipped_kind(reason).to_string(),
            readable_text: false,
            binary: matches!(
                reason,
                "binary_extension" | "binary_magic" | "binary_content" | "invalid_utf8"
            ),
            executable,
            size_bytes,
            extension: extension.or_else(|| lower_extension(path)),
            magic,
            reason: Some(reason.to_string()),
        }),
    }
}

fn skipped_kind(reason: &str) -> &'static str {
    match reason {
        "binary_extension" | "binary_magic" | "binary_content" => "binary",
        "invalid_utf8" => "nonUtf8",
        "too_large" => "largeFile",
        "not_regular_file" => "nonRegular",
        _ => "unreadable",
    }
}

fn lower_extension(path: &Path) -> Option<String> {
    path.extension()
        .and_then(OsStr::to_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| value.to_ascii_lowercase())
}

fn binary_extension(extension: &str) -> bool {
    matches!(
        extension,
        "a" | "app"
            | "bin"
            | "class"
            | "dll"
            | "dylib"
            | "exe"
            | "jar"
            | "lib"
            | "node"
            | "o"
            | "obj"
            | "pdf"
            | "png"
            | "jpg"
            | "jpeg"
            | "gif"
            | "rlib"
            | "rmeta"
            | "so"
            | "wasm"
            | "zip"
            | "gz"
            | "xz"
            | "7z"
    )
}

pub(crate) fn binary_magic(bytes: &[u8]) -> Option<&'static str> {
    if bytes.len() >= 4 {
        let head4 = &bytes[..4];
        if head4 == b"\x7FELF" {
            return Some("elf");
        }
        if head4 == b"\0asm" {
            return Some("wasm");
        }
        if matches!(
            head4,
            [0xFE, 0xED, 0xFA, 0xCE]
                | [0xFE, 0xED, 0xFA, 0xCF]
                | [0xCE, 0xFA, 0xED, 0xFE]
                | [0xCF, 0xFA, 0xED, 0xFE]
                | [0xCA, 0xFE, 0xBA, 0xBE]
        ) {
            return Some("mach_o_or_class");
        }
        if head4 == b"PK\x03\x04" {
            return Some("zip");
        }
        if head4 == b"%PDF" {
            return Some("pdf");
        }
    }
    if bytes.len() >= 2 {
        if &bytes[..2] == b"MZ" {
            return Some("pe");
        }
        if bytes[..2] == [0x1F, 0x8B] {
            return Some("gzip");
        }
    }
    if bytes.len() >= 8 && &bytes[..8] == b"!<arch>\n" {
        return Some("archive");
    }
    if bytes.len() >= 8 && bytes[..8] == [0x89, b'P', b'N', b'G', b'\r', b'\n', 0x1A, b'\n'] {
        return Some("png");
    }
    if bytes.len() >= 3 && bytes[..3] == [0xFF, 0xD8, 0xFF] {
        return Some("jpeg");
    }
    None
}

pub(crate) fn has_high_control_byte_ratio(bytes: &[u8]) -> bool {
    if bytes.is_empty() {
        return false;
    }
    let control = bytes
        .iter()
        .filter(|byte| matches!(**byte, 0x01..=0x08 | 0x0E..=0x1F | 0x7F))
        .count();
    control > 8 && control * 100 > bytes.len()
}

#[cfg(unix)]
fn executable_bit(metadata: &fs::Metadata) -> bool {
    use std::os::unix::fs::PermissionsExt;
    metadata.permissions().mode() & 0o111 != 0
}

#[cfg(not(unix))]
fn executable_bit(_metadata: &fs::Metadata) -> bool {
    false
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::atomic::{AtomicU64, Ordering};

    static TEMP_INDEX: AtomicU64 = AtomicU64::new(0);

    struct TempFileFixture {
        root: std::path::PathBuf,
        path: std::path::PathBuf,
    }

    impl TempFileFixture {
        fn path(&self) -> &Path {
            &self.path
        }
    }

    impl Drop for TempFileFixture {
        fn drop(&mut self) {
            match fs::remove_dir_all(&self.root) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) if std::thread::panicking() => eprintln!(
                    "failed to remove test-owned file-content root {} during panic: {error}",
                    self.root.display()
                ),
                Err(error) => panic!(
                    "remove test-owned file-content root {}: {error}",
                    self.root.display()
                ),
            }
        }
    }

    fn temp_file(name: &str, content: &[u8]) -> TempFileFixture {
        let root = std::env::temp_dir().join(format!(
            "deepcode-file-content-policy-{}-{}",
            std::process::id(),
            TEMP_INDEX.fetch_add(1, Ordering::SeqCst)
        ));
        fs::create_dir_all(&root).expect("create temp root");
        let path = root.join(name);
        fs::write(&path, content).expect("write temp file");
        TempFileFixture { root, path }
    }

    #[test]
    fn binary_magic_is_skipped() {
        let file = temp_file("generic.bin", b"\x7FELF\x02\x01\x01\0payload");
        let skipped = read_text_file_for_llm(file.path()).expect_err("ELF must be skipped");
        assert_eq!(skipped.reason, "binary_extension");
    }

    #[test]
    fn binary_magic_without_binary_extension_is_skipped() {
        let file = temp_file("generic.out", b"\x7FELF\x02\x01\x01\0payload");
        let skipped = read_text_file_for_llm(file.path()).expect_err("ELF must be skipped");
        assert_eq!(skipped.reason, "binary_magic");
        assert_eq!(skipped.classification.magic.as_deref(), Some("elf"));
    }

    #[test]
    fn executable_text_script_is_readable() {
        let file = temp_file("generic-script", b"#!/bin/sh\necho ok\n");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = fs::metadata(file.path()).expect("metadata").permissions();
            permissions.set_mode(0o755);
            fs::set_permissions(file.path(), permissions).expect("chmod");
        }
        let read = read_text_file_for_llm(file.path()).expect("script text is readable");
        assert!(read.content.contains("echo ok"));
        #[cfg(unix)]
        assert_eq!(read.classification.kind, "textExecutableScript");
    }
}
