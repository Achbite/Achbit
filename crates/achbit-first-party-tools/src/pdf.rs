use crate::{input_object, limit_text, optional_u64, required_string, ToolError, ToolResult};
use serde_json::{json, Value};
use std::fmt::Write as _;
use std::io::Read;
use std::ops::Range;
use std::path::Path;

const MAX_PDF_BYTES: u64 = 16 * 1024 * 1024;
const MAX_PDF_PAGES: usize = 50;
const MAX_OUTPUT_BYTES: usize = 128 * 1024;

pub(crate) fn call(name: &str, input: &Value, metadata: Option<&Value>) -> ToolResult<Value> {
    if name != "read" {
        return Err(ToolError::new(
            "tool_not_found",
            format!("PDF plugin does not provide {name}"),
        ));
    }
    read(input, metadata)
}

fn read(input: &Value, metadata: Option<&Value>) -> ToolResult<Value> {
    let object = input_object(input, &["path", "startPage", "endPage"])?;
    let logical_path = required_string(object, "path")?;
    let requested_start = optional_u64(object, "startPage", 1, 1, u64::MAX)? as usize;
    let requested_end = match object.get("endPage") {
        None => None,
        Some(_) => Some(optional_u64(object, "endPage", 1, 1, u64::MAX)? as usize),
    };
    if requested_end.is_some_and(|end| end < requested_start) {
        return Err(ToolError::new(
            "tool_input_invalid",
            "endPage must be greater than or equal to startPage",
        ));
    }
    let binding = metadata
        .and_then(|value| value.get("achbit"))
        .and_then(Value::as_object)
        .ok_or_else(|| {
            ToolError::new(
                "workspace_binding_required",
                "PDF reads require a Kernel-prepared workspace binding",
            )
        })?;
    let workspace_id = binding
        .get("workspaceId")
        .and_then(Value::as_str)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ToolError::new("workspace_binding_invalid", "workspaceId is missing"))?;
    let resolved_targets = binding
        .get("resolvedWorkspaceTargets")
        .and_then(Value::as_array)
        .ok_or_else(|| {
            ToolError::new(
                "workspace_binding_invalid",
                "resolved workspace targets are missing",
            )
        })?;
    if resolved_targets.len() != 1 {
        return Err(ToolError::new(
            "workspace_binding_invalid",
            "PDF reads require exactly one resolved workspace target",
        ));
    }
    let target = resolved_targets[0]
        .as_str()
        .filter(|value| !value.is_empty())
        .ok_or_else(|| ToolError::new("workspace_binding_invalid", "resolved target is invalid"))?;
    let target = Path::new(target);
    let metadata = std::fs::metadata(target)
        .map_err(|error| ToolError::new("pdf_read_failed", format!("read metadata: {error}")))?;
    if !metadata.is_file() {
        return Err(ToolError::new(
            "pdf_target_invalid",
            "PDF target is not a file",
        ));
    }
    let too_large = || {
        ToolError::new(
            "pdf_target_too_large",
            format!("PDF exceeds {MAX_PDF_BYTES} bytes"),
        )
    };
    if metadata.len() > MAX_PDF_BYTES {
        return Err(too_large());
    }
    let mut bytes = Vec::new();
    std::fs::File::open(target)
        .and_then(|file| file.take(MAX_PDF_BYTES + 1).read_to_end(&mut bytes))
        .map_err(|error| ToolError::new("pdf_read_failed", error.to_string()))?;
    if bytes.len() as u64 > MAX_PDF_BYTES {
        return Err(too_large());
    }
    let start = requested_start - 1;
    let requested_end = requested_end.unwrap_or(usize::MAX);
    let range_end = requested_end.min(start.saturating_add(MAX_PDF_PAGES));
    let (total_pages, pages) = extract_pages(&bytes, start..range_end)
        .map_err(|message| ToolError::new("pdf_extract_failed", message))?;
    if total_pages == 0 {
        return Err(ToolError::new(
            "pdf_page_range_invalid",
            "PDF contains no readable pages",
        ));
    }
    if requested_start > total_pages {
        return Err(ToolError::new(
            "pdf_page_range_invalid",
            format!("startPage {requested_start} exceeds PDF page count {total_pages}"),
        ));
    }
    let end = start + pages.len();
    let mut joined = String::new();
    for (index, content) in pages.iter().enumerate() {
        write!(joined, "\n--- page {} ---\n{}", start + index + 1, content)
            .expect("writing to String cannot fail");
    }
    let (text, truncated_output) = limit_text(&joined, MAX_OUTPUT_BYTES);
    Ok(json!({
        "workspaceId": workspace_id,
        "path": logical_path,
        "adapter": "pdf_extract",
        "startPage": start + 1,
        "endPage": end,
        "totalPages": total_pages,
        "text": text,
        "truncatedPages": end < requested_end.min(total_pages),
        "hasMorePages": end < total_pages,
        "truncatedOutput": truncated_output,
        "sizeBytes": bytes.len()
    }))
}

/// The upstream by-pages shortcut treats the first page error as end of document.
pub(crate) fn extract_pages(
    bytes: &[u8],
    range: Range<usize>,
) -> Result<(usize, Vec<String>), String> {
    // The parser can panic on malformed page objects. Its state stays inside this
    // boundary; only the current page number survives to identify the failure.
    let mut page = None;
    let decoded = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        let mut document =
            pdf_extract::Document::load_mem(bytes).map_err(|error| error.to_string())?;
        if document.is_encrypted() {
            document.decrypt("").map_err(|error| error.to_string())?;
        }
        let mut pages = Vec::new();
        let page_numbers = document.get_pages();
        let count = page_numbers.len();
        for number in page_numbers.into_keys().skip(range.start).take(range.len()) {
            page = Some(number);
            let mut text = String::new();
            pdf_extract::output_doc_page(
                &document,
                &mut pdf_extract::PlainTextOutput::new(&mut text),
                number,
            )
            .map_err(|error| error.to_string())?;
            pages.push(text);
        }
        Ok((count, pages))
    }))
    .unwrap_or_else(|panic| {
        let reason = panic
            .downcast_ref::<String>()
            .map(String::as_str)
            .or_else(|| panic.downcast_ref::<&str>().copied())
            .unwrap_or("The PDF parser could not decode the document");
        Err(reason.to_owned())
    });
    decoded.map_err(|error| match page {
        Some(number) => format!("Page {number}: {error}"),
        None => error,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use pdf_extract::{dictionary, Document, Object};

    #[test]
    fn local_read_reports_the_failed_page_instead_of_returning_a_short_document() {
        let mut doc = Document::with_version("1.5");
        let pages = doc.new_object_id();
        let mut kids = Vec::new();
        for number in 1..=3 {
            let mut page = dictionary! { "Type" => "Page", "Parent" => pages };
            if number != 2 {
                page.set("MediaBox", vec![0.into(), 0.into(), 100.into(), 100.into()]);
            }
            kids.push(Object::Reference(doc.add_object(page)));
        }
        doc.objects.insert(
            pages,
            dictionary! {
                "Type" => "Pages", "Count" => 3, "Kids" => kids
            }
            .into(),
        );
        let catalog = doc.add_object(dictionary! { "Type" => "Catalog", "Pages" => pages });
        doc.trailer.set("Root", catalog);
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("paper.pdf");
        doc.save(&path).unwrap();
        let context = json!({"achbit": {"workspaceId":"test", "resolvedWorkspaceTargets":[path]}});
        let error = call(
            "read",
            &json!({"path":"paper.pdf","startPage":1,"endPage":3}),
            Some(&context),
        )
        .unwrap_err();
        assert_eq!(error.code, "pdf_extract_failed");
        assert!(error.message.contains("Page 2"), "{}", error.message);
        assert!(error.message.contains("MediaBox"), "{}", error.message);
        for number in [1, 3] {
            let output = call(
                "read",
                &json!({"path":"paper.pdf", "startPage":number, "endPage":number}),
                Some(&context),
            )
            .unwrap();
            assert_eq!(output["totalPages"], 3);
            assert_eq!(output["startPage"], number);
            assert_eq!(output["endPage"], number);
        }
    }
}
