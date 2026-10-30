# Achbit Quiet SC

| Bundled option | Font family | CJK style |
| --- | --- | --- |
| Quiet Reading Kai | Achbit Quiet Reading SC | Kai handwriting |
| Quiet Reading Sans | Achbit Quiet Reading Sans SC | Rounded sans-serif |
| Compact Terminal Kai | Achbit Quiet Mono Kai SC | Kai handwriting |
| Compact Terminal Sans | Achbit Quiet Mono SC | Rounded sans-serif |

Both reading variants share proportional sans-serif Latin glyphs. Both compact variants share monospaced Latin glyphs, with Latin and CJK widths in a 1:2 ratio. Kai is a Chinese handwriting style, not a Western serif category. Both sans variants use sans-serif Latin and CJK glyphs.

The GUI loads bundled WOFF2 fonts directly; Appearance does not export terminal configuration. The default sans reading font retains its complete glyph set and disables WOFF2 glyf/loca transforms to reduce initial WebView glyph reconstruction work. The other three font encodings are unchanged.

Dedicated macOS and Windows TUI windows use independently named TTF variants in `Achbit-Quiet-Terminal-SC.zip`. All four use 500-unit ASCII and 1000-unit CJK widths. Reading variants retain their outlines while fitting wide Latin glyphs into one cell; proportional GUI WOFF2 fonts remain unchanged. macOS registers fonts with CoreText for the current login session so Terminal can load them, without copying them into system font directories or changing global defaults. Registration expires on logout.

Windows consoles use distinct short family names. Launch temporarily loads the required font, and normal process exit releases it. Custom fonts must already be installed and recognized by the console. macOS PostScript names are unchanged. Switching fonts preserves the dedicated window size; the terminal updates its row/column count, then the TUI reflows. Custom fonts must be monospaced.

Generate terminal variants with fonttools 4.67.0 in the development container:

```sh
python scripts/build-tui-fonts.py --source userspace/gui/src/assets/fonts/Achbit-Quiet-SC.zip --output userspace/gui/src/assets/fonts/Achbit-Quiet-Terminal-SC.zip
```

The terminal archive retains the four source fonts' licenses and attribution; this command does not regenerate GUI fonts.

All four fonts are renamed SIL OFL 1.1 derivatives. The accompanying notices must remain with redistributed fonts.
Reading Latin: Libertinus Sans 7.051. Mono Latin: Maple Mono NL CN 7.9.
Kai CJK: LXGW WenKai 1.522. Sans CJK and remaining glyphs: Maple Mono NL CN 7.9 (Resource Han Rounded).
These are not Claude or Optima fonts.
Regular only. No donor GSUB/GPOS or handcrafted small-size hinting.

The full WOFF2 fonts have the same cmap as their TTFs, not specimen subsets. sources.json records original downloads. To reproduce outlines, run build_fonts.py with fonttools 4.67.0 and brotli 1.2.0 inside the development container. Use --source-dir for the original fonts and --output-dir for generated TTFs and the receipt. The script also writes full WOFF2 fonts and the ZIP containing all four TTFs and these notices next to itself.
