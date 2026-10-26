//! Built-in document contribution. Kernel prepares the destination and owns
//! authority; this executor writes that file and reports the actual artifact.
use crate::{ToolError, ToolResult};
use achbit_host_connection::process::{
    spawn_owned_host_process, terminate_owned_process_tree, OwnedHostProcess,
};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::io::{Read, Write};
use std::path::Path;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

const MAX_SOURCE_BYTES: usize = 1024 * 1024;
const MAX_PDF_BYTES: usize = 32 * 1024 * 1024;
const PDF_TIMEOUT: Duration = Duration::from_secs(90);

#[derive(Debug, Clone, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct DocumentInput {
    pub path: String,
    format: String,
    content: String,
}

pub struct DocumentContext<'a> {
    pub invocation_id: &'a str,
    pub workspace_id: &'a str,
    pub target: &'a Path,
    pub renderer: &'a Path,
    pub cancelled: &'a dyn Fn() -> bool,
}

pub fn input_schema() -> Value {
    json!({
        "type":"object", "additionalProperties":false,
        "required":["path","format","content"],
        "properties": {
            "path":{"type":"string", "minLength":1, "description":"Workspace-relative output filename, ending in .html, .pdf or .md."},
            "format":{"type":"string", "enum":["html","pdf","markdown"]},
            "content":{"type":"string", "minLength":1, "description":"Complete self-contained Typst source for pdf, HTML source for html, or Markdown source for markdown. For PDF, images must use inline bytes; external files and imports are unavailable. Up to 1 MiB UTF-8."}
        }
    })
}

pub fn prepare(input: Value) -> ToolResult<DocumentInput> {
    let input: DocumentInput = serde_json::from_value(input)
        .map_err(|error| ToolError::new("tool_input_invalid", error.to_string()))?;
    if input.path.trim().is_empty() || input.content.trim().is_empty() {
        return Err(ToolError::new(
            "tool_input_invalid",
            "Document path and content must not be empty.",
        ));
    }
    if input.content.len() > MAX_SOURCE_BYTES {
        return Err(ToolError::new(
            "document_source_too_large",
            "Document source exceeds 1 MiB.",
        ));
    }
    let suffix = Path::new(&input.path)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let matches_format = match input.format.as_str() {
        "html" => matches!(suffix.as_str(), "html" | "htm"),
        "markdown" => matches!(suffix.as_str(), "md" | "markdown"),
        "pdf" => suffix == "pdf",
        _ => false,
    };
    if !matches_format {
        return Err(ToolError::new(
            "document_format_invalid",
            "Output extension must match html, pdf or markdown format.",
        ));
    }
    Ok(input)
}

pub fn render(input: &DocumentInput, context: DocumentContext<'_>) -> ToolResult<Value> {
    check_cancelled(context.cancelled)?;
    let bytes = if input.format == "pdf" {
        render_pdf(
            &input.content,
            context.renderer,
            context.cancelled,
            PDF_TIMEOUT,
        )?
    } else {
        input.content.as_bytes().to_vec()
    };
    check_cancelled(context.cancelled)?;
    let parent = context
        .target
        .parent()
        .filter(|parent| !parent.as_os_str().is_empty())
        .ok_or_else(|| {
            ToolError::new(
                "document_target_invalid",
                "Prepared document destination has no parent directory.",
            )
        })?;
    std::fs::create_dir_all(parent).map_err(write_error)?;
    let mut temporary = tempfile::NamedTempFile::new_in(parent).map_err(write_error)?;
    temporary.write_all(&bytes).map_err(write_error)?;
    temporary.flush().map_err(write_error)?;
    check_cancelled(context.cancelled)?;
    temporary
        .persist(context.target)
        .map_err(|error| write_error(error.error))?;
    let media_type = match input.format.as_str() {
        "pdf" => "application/pdf",
        "html" => "text/html",
        _ => "text/markdown",
    };
    Ok(json!({
        "workspaceId":context.workspace_id, "path":input.path,
        "mediaType":media_type, "sizeBytes":bytes.len(),
        "artifacts":[{
            "artifactId":format!("artifact:{}", context.invocation_id),
            "contentType":media_type, "contentMode":"live",
            "label":Path::new(&input.path).file_name().and_then(|name| name.to_str()).unwrap_or(&input.path),
            "workspaceId":context.workspace_id, "logicalPath":input.path,
        }]
    }))
}

fn write_error(error: std::io::Error) -> ToolError {
    ToolError::new("document_write_failed", error.to_string())
}

fn check_cancelled(cancelled: &dyn Fn() -> bool) -> ToolResult<()> {
    if cancelled() {
        Err(ToolError::new(
            "tool_cancelled",
            "Document generation was cancelled.",
        ))
    } else {
        Ok(())
    }
}

struct RendererProcess {
    owned: OwnedHostProcess,
    stopped: bool,
}
impl RendererProcess {
    fn stop(&mut self) {
        if !self.stopped {
            terminate_owned_process_tree(&mut self.owned);
            self.stopped = true;
        }
    }
}
impl Drop for RendererProcess {
    fn drop(&mut self) {
        self.stop();
    }
}

fn render_pdf(
    source: &str,
    program: &Path,
    cancelled: &dyn Fn() -> bool,
    timeout: Duration,
) -> ToolResult<Vec<u8>> {
    let mut command = Command::new(program);
    command
        .arg("--render-pdf")
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let owned = spawn_owned_host_process(&mut command).map_err(|error| {
        ToolError::new("document_renderer_unavailable", format!("Cannot start {}: {error}. The bundled document renderer is required for PDF output.", program.display()))
    })?;
    let mut process = RendererProcess {
        owned,
        stopped: false,
    };
    let mut stdin = process
        .owned
        .child
        .stdin
        .take()
        .expect("renderer stdin is piped");
    let stdout = process
        .owned
        .child
        .stdout
        .take()
        .expect("renderer stdout is piped");
    let stderr = process
        .owned
        .child
        .stderr
        .take()
        .expect("renderer stderr is piped");
    std::thread::scope(|scope| {
        let writer = scope.spawn(move || stdin.write_all(source.as_bytes()));
        let output = scope.spawn(move || read_bounded(stdout, MAX_PDF_BYTES));
        let errors = scope.spawn(move || read_bounded(stderr, 16 * 1024));
        let start = Instant::now();
        let status = loop {
            if cancelled() {
                process.stop();
                break Err(ToolError::new(
                    "tool_cancelled",
                    "PDF rendering was cancelled.",
                ));
            }
            if start.elapsed() >= timeout {
                process.stop();
                break Err(ToolError::new(
                    "document_render_timeout",
                    "PDF rendering exceeded 90 seconds.",
                ));
            }
            match process.owned.child.try_wait() {
                Ok(Some(status)) => break Ok(status),
                Ok(None) => std::thread::sleep(Duration::from_millis(25)),
                Err(error) => {
                    process.stop();
                    break Err(ToolError::new("document_render_failed", error.to_string()));
                }
            }
        };
        // Close the entire owned tree before joining readers, including a renderer
        // that exited after spawning a child which inherited one of its pipes.
        process.stop();
        let write = writer.join().map_err(|_| {
            ToolError::new("document_render_failed", "Renderer input thread failed.")
        })?;
        let pdf = output.join().map_err(|_| {
            ToolError::new("document_render_failed", "Renderer output thread failed.")
        })?;
        let stderr = errors.join().map_err(|_| {
            ToolError::new("document_render_failed", "Renderer error thread failed.")
        })?;
        let status = status?;
        let stderr = stderr.map_err(write_error)?;
        if !status.success() {
            return Err(ToolError::new(
                "document_render_failed",
                format!(
                    "PDF renderer exited with {status}: {}",
                    String::from_utf8_lossy(&stderr)
                ),
            ));
        }
        write.map_err(write_error)?;
        let pdf = pdf.map_err(write_error)?;
        if pdf.len() > MAX_PDF_BYTES || !pdf.starts_with(b"%PDF-") {
            return Err(ToolError::new(
                "document_output_invalid",
                "Renderer did not produce a PDF within the 32 MiB limit.",
            ));
        }
        Ok(pdf)
    })
}

fn read_bounded(mut reader: impl Read, limit: usize) -> std::io::Result<Vec<u8>> {
    let mut retained = Vec::new();
    let mut buffer = [0; 8192];
    loop {
        let count = reader.read(&mut buffer)?;
        if count == 0 {
            return Ok(retained);
        }
        let remaining = (limit + 1).saturating_sub(retained.len());
        retained.extend_from_slice(&buffer[..count.min(remaining)]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn context<'a>(target: &'a Path, cancelled: &'a dyn Fn() -> bool) -> DocumentContext<'a> {
        DocumentContext {
            invocation_id: "attempt:document",
            workspace_id: "workspace:documents",
            target,
            renderer: Path::new("unused-renderer"),
            cancelled,
        }
    }

    #[test]
    fn html_and_markdown_publish_the_written_workspace_file() {
        let directory = tempfile::tempdir().unwrap();
        for (format, name, content) in [
            (
                "html",
                "报告.html",
                "<!doctype html><html lang=zh-CN><meta charset=utf-8><h1>项目报告</h1></html>",
            ),
            (
                "markdown",
                "notes.md",
                "# Project notes\n\nA useful document.\n",
            ),
        ] {
            let target = directory.path().join(name);
            let output = render(
                &prepare(json!({"path":name,"format":format,"content":content})).unwrap(),
                context(&target, &|| false),
            )
            .unwrap();
            assert_eq!(std::fs::read_to_string(&target).unwrap(), content);
            assert_eq!(output["sizeBytes"], content.len());
            assert_eq!(output["artifacts"][0]["workspaceId"], "workspace:documents");
            assert_eq!(output["artifacts"][0]["logicalPath"], name);
            assert_eq!(
                std::fs::read_dir(directory.path())
                    .unwrap()
                    .filter_map(Result::ok)
                    .filter(|entry| entry.file_name().to_string_lossy().starts_with(".tmp"))
                    .count(),
                0
            );
        }
    }

    #[test]
    fn invalid_or_cancelled_document_does_not_replace_existing_output() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("report.html");
        std::fs::write(&target, "original").unwrap();
        for input in [
            json!({"path":"", "format":"html", "content":"text"}),
            json!({"path":"report.html", "format":"pdf", "content":"text"}),
            json!({"path":"report.html", "format":"html", "content":" "}),
        ] {
            assert!(prepare(input).is_err());
        }
        let input =
            prepare(json!({"path":"report.html", "format":"html", "content":"updated"})).unwrap();
        assert_eq!(
            render(&input, context(&target, &|| true)).unwrap_err().code,
            "tool_cancelled"
        );
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "original");
        render(&input, context(&target, &|| false)).unwrap();
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "updated");
    }

    #[test]
    fn unavailable_pdf_renderer_keeps_the_existing_file() {
        let directory = tempfile::tempdir().unwrap();
        let target = directory.path().join("report.pdf");
        std::fs::write(&target, "original file").unwrap();
        let missing = directory.path().join("missing-renderer");
        let mut scope = context(&target, &|| false);
        scope.renderer = &missing;
        let error = render(
            &prepare(json!({"path":"report.pdf", "format":"pdf", "content":"= Report"})).unwrap(),
            scope,
        )
        .unwrap_err();
        assert_eq!(error.code, "document_renderer_unavailable");
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "original file");
    }

    #[cfg(unix)]
    fn renderer_script(directory: &Path, body: &str) -> std::path::PathBuf {
        use std::os::unix::fs::PermissionsExt;
        let path = directory.join("renderer");
        std::fs::write(&path, format!("#!/bin/sh\n{body}\n")).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o700)).unwrap();
        path
    }

    #[cfg(unix)]
    #[test]
    fn renderer_output_is_bounded_and_deadline_stops_the_process() {
        let directory = tempfile::tempdir().unwrap();
        let oversized = renderer_script(directory.path(), "head -c 33554433 /dev/zero");
        let error = render_pdf("= Report", &oversized, &|| false, PDF_TIMEOUT).unwrap_err();
        assert_eq!(error.code, "document_output_invalid");

        let pid_file = directory.path().join("pid");
        let script = renderer_script(
            directory.path(),
            &format!("echo $$ > '{}'\nexec sleep 30", pid_file.display()),
        );
        let started = Instant::now();
        let error =
            render_pdf("= Report", &script, &|| false, Duration::from_millis(250)).unwrap_err();
        assert_eq!(error.code, "document_render_timeout");
        assert!(started.elapsed() < Duration::from_secs(5));
        let pid = std::fs::read_to_string(pid_file).unwrap();
        assert!(!Command::new("kill")
            .args(["-0", pid.trim()])
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .unwrap()
            .success());
    }
}
