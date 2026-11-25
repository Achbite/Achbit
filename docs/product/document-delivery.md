# Creating and delivering documents

Activate the Documents plugin (plugin://documents@builtin) and call document.render with the requested workspace destination. The achbit-documents Skill provides reusable design guidance and template assets.

| Requested output | `document.render` input |
| --- | --- |
| HTML | `format: "html"`, `.html` path, complete UTF-8 HTML in `content` |
| PDF | `format: "pdf"`, `.pdf` path, complete UTF-8 Typst source in `content` |
| Markdown | `format: "markdown"`, `.md` path, Markdown in `content` |

PDF is compiled locally from Typst. Author one self-contained source with inline definitions, data and images. HTML and Markdown remain their own output formats.

After successful generation, call `artifact.present` with the returned artifact ID and readable label, then cite the returned URI. For an existing file, call `artifact.prepare` first. For a live HTTP(S) preview, `artifact.preview` registers the URL without fetching or verifying it.

Re-prepare modified files and reuse the `deliveryId` for updates. Deliver source plus PDF only when requested or useful to the stated goal. Keep scratch files and inspection logs intermediate; do not claim visual review, publication or printing merely because generation succeeded.

See [interactive previews](interactive-previews.md) for embedding an archived HTML component in a conversation.
