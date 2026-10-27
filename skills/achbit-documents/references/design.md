# Document design

The layout approach is informed by Kami: restrained color, consistent typography and content-sized templates. Achbit provides its own self-contained HTML and Typst templates; this does not bundle Kami’s fonts, MCP tools or validation suite.

## Hierarchy and rhythm

- Choose one clear title, then headings that describe the document's real structure. Keep heading levels consecutive.
- Use comfortable reading width, consistent spacing and a restrained accent color. The included template uses warm neutral surfaces and ink blue.
- Prefer system fonts with Chinese and Latin fallbacks. Keep an explicit user font or brand choice. Do not require a remote font for a complete document.
- For reading documents, use comfortable paragraph spacing and tighter headings. HTML body line height around 1.5–1.65 or Typst paragraph leading around 0.5–0.65 em is a useful starting point. Keep captions and metadata quieter than the body without making them hard to read.
- Use tables to compare parallel information, not to position all page content. Let long words and URLs wrap.
- Preserve semantic code, quotes, lists, figures and captions. Avoid ornamental cards around every paragraph.

## PDF with Typst

- Use `#set page(paper: "a4", margin: 20mm)` as a starting point, adjusting page size and margins to the requested document. Add page numbering only when useful.
- Use Typst headings (`=`, `==`), lists, quotes, tables and native math so text remains selectable. Set the document language with `#set text(lang: ...)` and use fonts available to the renderer.
- Mark repeated table headers with `table.header`. Let long sections and tables flow across pages; use `#pagebreak()` only for deliberate section boundaries. Keep a short figure and caption together when needed, without putting a whole long section in an unbreakable block.
- Keep all definitions and assets in the source. Embed diagrams using `image(bytes(svg), format: "svg")` and raster graphics using image bytes. Use native Typst math for formulas.
- Start from `assets/document.typ`, remove example sections that the task does not need, and keep the page white unless the user requests a colored background.

## HTML

- Keep the delivered HTML self-contained: inline CSS and embedded images or SVG where appropriate. Local or remote file dependencies should be an explicit user choice, not a hidden requirement of the template.
- Set UTF-8, the document language and a meaningful HTML title. Use semantic elements so reading order survives copying.
- For browser printing, use `@page` and print styles. Keep headings with the next paragraph, and avoid splitting short figures and table rows across pages.
- Allow long sections and tables to flow. Fixed heights, absolute positioning and forcing an entire large table onto one page commonly clip content.
- Use selectable text. Render formulas and diagrams as self-contained SVG when they require more than HTML/CSS.
- Use a white print surface unless the user requests a colored page. Screen styling may use a warmer surrounding canvas.

## Content-sized effort

A short note needs good typography and spacing, not a title page, table of contents or full report system. A long document may need page numbers, navigation and section summaries. Add these only when they improve the requested document.
