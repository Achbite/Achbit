use achbit_first_party_tools::documents::{prepare, render, DocumentContext};
use serde_json::json;
use std::path::Path;
use std::time::{Duration, Instant};

const RENDERER: &str = env!("CARGO_BIN_EXE_achbit-first-party-provider");

fn context<'a>(target: &'a Path, cancelled: &'a dyn Fn() -> bool) -> DocumentContext<'a> {
    DocumentContext {
        invocation_id: "attempt:real-document",
        workspace_id: "workspace:documents",
        target,
        renderer: Path::new(RENDERER),
        cancelled,
    }
}

#[test]
fn pdf_export_retains_chinese_table_pagination_and_inline_images() {
    let directory = tempfile::tempdir().unwrap();
    let target = directory.path().join("report.pdf");
    let source = format!(
        "{}\n#image(bytes((255,0,0,0,255,0,0,0,255,255,255,0)), format:(encoding:\"rgb8\",width:2,height:2), width:10mm)\nReadable output from the real renderer.",
        include_str!("../../../skills/achbit-documents/assets/document.typ")
    );
    let result = render(
        &prepare(json!({"path":"report.pdf", "format":"pdf", "content":source})).unwrap(),
        context(&target, &|| false),
    )
    .unwrap();
    assert_eq!(result["mediaType"], "application/pdf");
    assert_eq!(result["artifacts"][0]["workspaceId"], "workspace:documents");
    assert_eq!(result["artifacts"][0]["logicalPath"], "report.pdf");
    let bytes = std::fs::read(&target).unwrap();
    assert!(bytes.starts_with(b"%PDF-"));
    assert_eq!(result["sizeBytes"], bytes.len());
    let pages = pdf_extract::extract_text_by_pages(&target).unwrap();
    assert_eq!(pages.len(), 2);
    for text in [
        "文档标题",
        "项目",
        "数量",
        "金额",
        "示例条目",
        "30.50",
        "English",
    ] {
        assert!(
            pages[0].contains(text),
            "page one lost {text}: {}",
            pages[0]
        );
    }
    assert!(pages[1].contains("嵌入式矢量图"));
    assert!(pages[1].contains("Readable output from the real renderer"));
}

#[test]
fn syntax_error_and_external_access_report_errors_without_replacing_output() {
    let directory = tempfile::tempdir().unwrap();
    let target = directory.path().join("report.pdf");
    let secret = directory.path().join("external.txt");
    std::fs::write(&secret, "not document input").unwrap();
    for (source, expected) in [
        ("#let value =".to_string(), "expected expression"),
        (format!("#read(\"{}\")", secret.display()), "self-contained"),
        (
            "#import \"@preview/tablex:0.0.9\": *".to_string(),
            "self-contained",
        ),
    ] {
        std::fs::write(&target, "original output").unwrap();
        let error = render(
            &prepare(json!({"path":"report.pdf", "format":"pdf", "content":source})).unwrap(),
            context(&target, &|| false),
        )
        .unwrap_err();
        assert_eq!(error.code, "document_render_failed");
        assert!(error.message.contains(expected), "{}", error.message);
        assert_eq!(std::fs::read_to_string(&target).unwrap(), "original output");
    }
    assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 2);
}

#[test]
fn active_typst_compilation_can_be_cancelled_without_replacing_output() {
    let directory = tempfile::tempdir().unwrap();
    let target = directory.path().join("report.pdf");
    std::fs::write(&target, "original output").unwrap();
    let started = Instant::now();
    let cancelled = || started.elapsed() >= Duration::from_millis(500);
    let error = render(
        &prepare(json!({"path":"report.pdf", "format":"pdf", "content":"#while true {}"})).unwrap(),
        context(&target, &cancelled),
    )
    .unwrap_err();
    assert_eq!(error.code, "tool_cancelled");
    assert!(started.elapsed() < Duration::from_secs(5));
    assert_eq!(std::fs::read_to_string(&target).unwrap(), "original output");
    assert_eq!(std::fs::read_dir(directory.path()).unwrap().count(), 1);
}
