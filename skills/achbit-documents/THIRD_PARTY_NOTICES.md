# Kami reference

The document workflow and typography guidance were informed by Kami, by Tw93.
Achbit provides its own focused Skill, HTML template and tool integration;
it does not install or run Kami's application or update workflow.

Kami is distributed under the MIT license:

MIT License

Copyright (c) 2026 Tw93

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

# Typst and embedded font resources

The local Documents PDF renderer uses typst, typst-kit and typst-pdf 0.13.1
from [the Typst project](https://github.com/typst/typst/tree/v0.13.1),
whose package author is The Typst Project Developers. These components use
the Apache License 2.0. Its unmodified upstream text is distributed in
[licenses/typst-0.13.1-LICENSE.txt](licenses/typst-0.13.1-LICENSE.txt),
copied from the project's `v0.13.1` tag.

Font embedding uses `typst-assets` 0.13.1 through typst-kit's `fonts` and
`embed-fonts` features. The assets crate comes from
[typst/typst-assets at ad8080d46d42fca909562572cfa14a86f00eb945](https://github.com/typst/typst-assets/tree/ad8080d46d42fca909562572cfa14a86f00eb945).
The published crate's original
[LICENSE](licenses/typst-assets-0.13.1-LICENSE.txt) and
[NOTICE](licenses/typst-assets-0.13.1-NOTICE.txt) are retained verbatim.
The NOTICE contains the complete font license terms, copyright statements,
reserved font names and the bundled ICC profile notices.

The 17 embedded font files are the unmodified files supplied by that crate:

| Font family | Version recorded in the bundled fonts | Upstream files | License and attribution |
| --- | --- | --- | --- |
| Libertinus Serif | 7.051 | `files/fonts/LibertinusSerif-*.otf` (6 files) | SIL Open Font License 1.1; Copyright © 2012–2024 The Libertinus Project Authors; reserved names are preserved in NOTICE |
| New Computer Modern text | 7.0.1 | `files/fonts/NewCM10-*.otf` (4 files) | GUST Font License 1.0; Antonis Tsolomitis; per-file copyright records are preserved below |
| New Computer Modern Math | 4.0 (Regular and Book), 5.3.0 (Bold) | `files/fonts/NewCMMath-*.otf` (3 files) | GUST Font License 1.0; Antonis Tsolomitis; per-file copyright records are preserved below |
| DejaVu Sans Mono | 2.37 | `files/fonts/DejaVuSansMono*.ttf` (4 files) | Bitstream Vera terms; Copyright (c) 2003 Bitstream, Inc.; DejaVu changes are in the public domain; the upstream Arev notices are also retained |

[licenses/typst-assets-0.13.1-font-copyrights.txt](licenses/typst-assets-0.13.1-font-copyrights.txt)
copies the copyright and version strings from each bundled font's OpenType
or TrueType `name` table. This retains the differing copyright years and
version strings of the New Computer Modern files without rewriting them.

The GUST Font License refers to the LaTeX Project Public License 1.3c or
later. The complete, unmodified
[LPPL 1.3c text](licenses/LPPL-1.3c.txt) is included from
[the LaTeX Project's versioned source](https://www.latex-project.org/lppl/lppl-1-3c.txt).

These materials belong to the local Documents renderer. System fonts used
for additional glyph coverage are discovered on the user's machine and are
not redistributed by these embedded-font resources.
