# Output formats

| Requested output | `document.render` input |
| --- | --- |
| HTML | `format: "html"`, `.html` path, complete UTF-8 HTML in `content` |
| PDF | `format: "pdf"`, `.pdf` path, complete UTF-8 Typst source in `content` |
| Markdown | `format: "markdown"`, `.md` path, Markdown in `content` |

PDF is compiled locally from Typst. Author one self-contained source with inline definitions, data and images. HTML and Markdown remain their own output formats.

## PDF source

Start from `assets/document.typ` and replace its example content. Set the page and text style, then use Typst markup for the document:

```typst
#set page(paper: "a4", margin: 20mm)
#set text(size: 11pt, lang: "zh")

= Document title

Body text can include *emphasis*, equations such as $a^2 + b^2 = c^2$, and lists.

#table(
  columns: (1fr, auto),
  table.header([Item], [Amount]),
  [Example], [30.50],
)
```

Pass this source string as `content`, without the code fence. Keep user content separate from Typst syntax: escape markup characters such as `#`, `$`, `[` and `]` when they must appear literally, or use `raw` for code. Use `#pagebreak()` only where the document needs an explicit new page; otherwise let content flow.

Embed diagrams as SVG bytes, for example:

```typst
#let svg = "<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 80 30'><rect width='80' height='30' fill='#1b365d'/></svg>"
#image(bytes(svg), format: "svg", width: 30mm)
```

For raster graphics, pass the complete encoded image bytes to `image` with the appropriate format. Keep assets in the source rather than referencing file paths, URLs or external packages. Use available fonts and keep font fallback enabled for mixed Chinese and Latin text.

## HTML and Markdown

For HTML, embed CSS and required images/SVG. Set UTF-8 and the document language, and adapt `assets/document.html` rather than retaining its example sections. Markdown input is ordinary Markdown. Use semantic headings, readable code and tables only where useful.

## Inspection and delivery

An available PDF reader can check text and pages; text extraction alone does not prove layout. A rendering error is a failed export. Fix its cause and render the requested format again; HTML/Markdown are not substitutes for a requested PDF.

After successful generation, call `artifact.present` with the returned artifact ID and readable label, then cite the returned URI. For an existing file, call `artifact.prepare` first. For a live HTTP(S) preview, `artifact.preview` registers the URL without fetching or verifying it.

Re-prepare modified files and reuse the `deliveryId` for updates. Deliver source plus PDF only when requested or useful to the stated goal. Keep scratch files and inspection logs intermediate; do not claim visual review, publication or printing merely because generation succeeded.
