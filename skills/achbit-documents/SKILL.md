---
name: achbit-documents
description: Create and deliver standalone HTML, PDF or Markdown documents.
---

# Document output

Use this workflow for a requested document file. Preserve its content, language, audience and format. For an interactive component within a reply, use the frontend design Skill and [references/interactive-previews.md](references/interactive-previews.md). Inline Mermaid diagrams and Markdown tables can go directly in the reply.

Read relevant resources with `skill.read`, name `achbit-documents`:

- [references/formats.md](references/formats.md): tool inputs and delivery.
- [references/design.md](references/design.md): layout and typography.
- [assets/document.typ](assets/document.typ): self-contained Typst starting point for PDF.
- [assets/document.html](assets/document.html): self-contained HTML starting point for HTML.

Activate `plugin://documents@builtin` through `plugin.activate` to use `document.render`. Choose the workspace destination and author the complete source: Typst for PDF, HTML for HTML, or Markdown for Markdown. Keep definitions, data and graphics self-contained, and respect existing file-write permission. For PDF, use Typst headings, tables, math and byte-backed images; pass the source directly in `content` without Markdown fences. Read `references/formats.md` for a minimal example.

Check the requested content and structure. Use an available preview to check layout, and report which checks were possible. If rendering fails, use the returned error to fix the source; do not deliver another format as a successful PDF. Present the successful artifact with `artifact.present` and cite its returned URI; prepare existing files with `artifact.prepare` first. Keep temporary sources/logs internal unless requested. A short note needs no title page, report system or extra export.
