---
name: achbit-documents
description: Create a requested HTML, PDF or Markdown document with readable typography and explicit artifact delivery.
---

# Document output

Use only when the user wants a document, not for an ordinary reply. Preserve the content, language, audience and requested format.

Read relevant resources with `skill.read`, name `achbit-documents`:

- [references/formats.md](references/formats.md): tool inputs and delivery.
- [references/design.md](references/design.md): layout and typography.
- [assets/document.typ](assets/document.typ): self-contained Typst starting point for PDF.
- [assets/document.html](assets/document.html): self-contained HTML starting point for HTML.

Activate `plugin://documents@builtin` through `plugin.activate` to use `document.render`. Choose the workspace destination and author the complete source: Typst for PDF, HTML for HTML, or Markdown for Markdown. Keep definitions, data and graphics self-contained, and respect existing file-write permission. For PDF, use Typst headings, tables, math and byte-backed images; pass the source directly in `content` without Markdown fences. Read `references/formats.md` for a minimal example.

Inspect the generated output appropriately. Text extraction is not visual verification. If rendering fails, use the returned error to fix the source; do not deliver another format as a successful PDF. Present the successful artifact with `artifact.present` and cite its returned URI; prepare existing files with `artifact.prepare` first. Keep temporary sources/logs internal unless requested. A short note needs no title page, report system or extra export.
