//! PDF compiler for the provider executable only. The Kernel adapter supervises
//! this process and publishes its output after successful completion.
use std::io::{Read, Write};

use typst::diag::{FileError, FileResult, SourceDiagnostic};
use typst::foundations::{Bytes, Datetime};
use typst::layout::PagedDocument;
use typst::syntax::{FileId, Source, VirtualPath};
use typst::text::{Font, FontBook};
use typst::utils::LazyHash;
use typst::{Library, World};
use typst_kit::fonts::{FontSearcher, FontSlot};

const MAX_SOURCE_BYTES: usize = 1024 * 1024;
const MAX_PDF_BYTES: usize = 32 * 1024 * 1024;

pub(crate) fn run() -> Result<(), String> {
    let mut source = String::new();
    std::io::stdin()
        .take(MAX_SOURCE_BYTES as u64 + 1)
        .read_to_string(&mut source)
        .map_err(|error| format!("Read Typst source: {error}"))?;
    if source.len() > MAX_SOURCE_BYTES || source.trim().is_empty() {
        return Err("Typst source must be nonempty and at most 1 MiB UTF-8.".into());
    }
    let world = DocumentWorld::new(source);
    let result = typst::compile::<PagedDocument>(&world);
    for warning in &result.warnings {
        eprintln!("warning: {}", diagnostic(&world.source, warning));
    }
    let document = result
        .output
        .map_err(|errors| diagnostics(&world.source, &errors))?;
    let pdf = typst_pdf::pdf(&document, &typst_pdf::PdfOptions::default())
        .map_err(|errors| diagnostics(&world.source, &errors))?;
    if pdf.len() > MAX_PDF_BYTES {
        return Err("Rendered PDF exceeds the 32 MiB limit.".into());
    }
    let mut output = std::io::stdout().lock();
    output
        .write_all(&pdf)
        .map_err(|error| format!("Write PDF: {error}"))?;
    output
        .flush()
        .map_err(|error| format!("Flush PDF: {error}"))
}

struct DocumentWorld {
    library: LazyHash<Library>,
    source: Source,
    book: LazyHash<FontBook>,
    fonts: Vec<FontSlot>,
}

impl DocumentWorld {
    fn new(text: String) -> Self {
        // Fonts are the sole filesystem resources available to the compiler.
        // No document-controlled directory is added to the font search path.
        let fonts = FontSearcher::new().search();
        Self {
            library: LazyHash::new(Library::default()),
            source: Source::new(FileId::new(None, VirtualPath::new("document.typ")), text),
            book: LazyHash::new(fonts.book),
            fonts: fonts.fonts,
        }
    }
}

fn external_file_error() -> FileError {
    FileError::Other(Some(
        "document source must be self-contained; external files and imports are not supported"
            .into(),
    ))
}

impl World for DocumentWorld {
    fn library(&self) -> &LazyHash<Library> {
        &self.library
    }

    fn book(&self) -> &LazyHash<FontBook> {
        &self.book
    }

    fn main(&self) -> FileId {
        self.source.id()
    }

    fn source(&self, id: FileId) -> FileResult<Source> {
        if id == self.source.id() {
            Ok(self.source.clone())
        } else {
            Err(external_file_error())
        }
    }

    fn file(&self, _id: FileId) -> FileResult<Bytes> {
        Err(external_file_error())
    }

    fn font(&self, index: usize) -> Option<Font> {
        self.fonts.get(index)?.get()
    }

    fn today(&self, _offset: Option<i64>) -> Option<Datetime> {
        None
    }
}

fn diagnostics(source: &Source, errors: &[SourceDiagnostic]) -> String {
    errors
        .iter()
        .map(|error| diagnostic(source, error))
        .collect::<Vec<_>>()
        .join("\n")
}

fn diagnostic(source: &Source, error: &SourceDiagnostic) -> String {
    let location = source
        .range(error.span)
        .map(|range| {
            let line = source.byte_to_line(range.start).unwrap_or(0) + 1;
            let column = source.byte_to_column(range.start).unwrap_or(0) + 1;
            format!("document.typ:{line}:{column}: ")
        })
        .unwrap_or_default();
    let mut result = format!("{location}{}", error.message);
    for hint in &error.hints {
        result.push_str(&format!("\nhint: {hint}"));
    }
    result
}
