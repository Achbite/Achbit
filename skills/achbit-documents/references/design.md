# Document design

## Hierarchy and rhythm

- Choose one clear title, then headings that describe the document's real structure. Keep heading levels consecutive.
- Use comfortable reading width, consistent spacing and a restrained accent color. The included template uses warm neutral surfaces and ink blue.
- Prefer system fonts with Chinese and Latin fallbacks. Keep an explicit user font or brand choice. Do not require a remote font for a complete document.
- For reading documents, use body line height around 1.5–1.65 and tighter headings. Keep captions and metadata quieter than the body without making them hard to read.
- Use tables to compare parallel information, not to position all page content. Let long words and URLs wrap.
- Preserve semantic code, quotes, lists, figures and captions. Avoid ornamental cards around every paragraph.

## HTML and print

- Keep the delivered HTML self-contained: inline CSS and embedded images or SVG where appropriate. Local or remote file dependencies should be an explicit user choice, not a hidden requirement of the template.
- Set UTF-8, the document language and a meaningful HTML title. Use semantic elements so reading order survives copying and PDF extraction.
- Use `@page` and print styles for PDF margins. Keep headings with the next paragraph, and avoid splitting short figures and table rows across pages.
- Allow long sections and tables to flow. Fixed heights, absolute positioning and forcing an entire large table onto one page commonly clip content.
- Use selectable text. Render formulas and diagrams as self-contained SVG when they require more than HTML/CSS; an exported PDF does not execute JavaScript.
- Use a white print surface unless the user requests a colored page. Screen styling may use a warmer surrounding canvas.

## Content-sized effort

A short note needs good typography and spacing, not a title page, table of contents or full report system. A long document may need page numbers, navigation and section summaries. Add these only when they improve the requested document.
