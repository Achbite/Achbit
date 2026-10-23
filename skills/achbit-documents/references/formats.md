# Output formats

| Requested output | `document.render` input |
| --- | --- |
| HTML | `format: "html"`, `.html` path, complete UTF-8 HTML in `content` |
| PDF | `format: "pdf"`, `.pdf` path, complete HTML in `content` |
| Markdown | `format: "markdown"`, `.md` path, Markdown in `content` |

For HTML/PDF, embed CSS and required images/SVG. PDF uses WeasyPrint and does not execute JavaScript; use fonts available in that rendering environment. A missing renderer is an error, not a successful export or permission to install dependencies. HTML/Markdown are not automatic substitutes for a requested PDF.

Use semantic headings, readable code and tables only where useful. Adapt `assets/document.html` rather than retaining its example sections. An available PDF reader can check text/pages; text extraction alone does not prove layout.

After successful generation, call `artifact.present` with the returned artifact ID and readable label, then cite the returned URI. For an existing file, call `artifact.prepare` first. For a live HTTP(S) preview, `artifact.preview` registers the URL without fetching or verifying it.

Re-prepare modified files and reuse the `deliveryId` for updates. Deliver source plus PDF only when requested or useful to the stated goal. Keep scratch files and inspection logs intermediate; do not claim visual review, publication or printing merely because generation succeeded.
