---
name: achbit-documents
description: Create a requested HTML, PDF or Markdown document with readable typography and explicit artifact delivery.
---

# Document output

Achbit is the current product name. Built-in Skill IDs and product commands use the `achbit-*` prefix.

Use only when the user wants a document, not for an ordinary reply. Preserve the content, language, audience and requested format.

Read relevant resources with `skill.read`, name `achbit-documents`:

- [references/formats.md](references/formats.md): tool inputs and delivery.
- [references/design.md](references/design.md): layout and typography.
- [assets/document.html](assets/document.html): optional self-contained HTML starting point.

Choose the workspace destination, author the content and call `document.render`. HTML/PDF inputs are complete HTML; Markdown input is Markdown. Respect existing file-write permission. PDF requires the configured renderer; missing dependencies do not authorize installation or a substitute format.

Inspect the generated output appropriately. Text extraction is not visual verification. Present the successful artifact with `artifact.present` and cite its returned URI; archive existing files with `artifact.prepare` first. Keep temporary sources/logs internal unless requested. A short note needs no title page, report system or extra export.
