# Achbit interface styling

`palette.json` is the single source of built-in interface colors. `tokens` defines GUI and Editor semantic colors, `themes` defines named light and dark palettes, and `terminal` and `diff` define terminal and diff colors. Components reference semantic variables; do not embed new color values in component CSS or TSX.

Interface variables and saved palette keys use the `--ac-*` prefix. Reading and saving validate the same keys and retain errors for unknown keys or invalid colors.

The default Achbit theme retains its light appearance. Dark mode distinguishes the background, sidebar, content surfaces, and overlays by brightness. Catppuccin, Gruvbox, and Nord palettes are adaptations to Achbit's interface roles, not official ports. References: [Catppuccin](https://github.com/catppuccin/catppuccin#-palette), [Gruvbox](https://github.com/morhetz/gruvbox/blob/master/colors/gruvbox.vim), and [Nord](https://www.nordtheme.com/docs/colors-and-palettes/).

Selections and edits use the existing user settings store, leaving installed default JSON files unchanged. `workbench.styleTokenOverrides` is the applied palette; the selected theme name is derived from actual colors. `gui.themeLibrary` stores imported theme documents only. Adding a theme does not apply it. Light and dark palettes are selected independently; `gui.colorTheme` determines the active mode. Custom accent colors take priority. Selecting an accent preset clears accent overrides for both modes.

## Import format

Use **Appearance → Theme configuration → Copy theme** to copy both complete palettes, then save the JSON or paste it into Import:

```json
{
  "name": "My Theme",
  "light": { "background": "#f4f4f6", "accent": "#0066cc" },
  "dark": { "background": "#1c1c1e", "accent": "#73b2ff" }
}
```

A document may contain one mode, and each mode may contain a subset of fields. Missing fields use built-in Achbit semantic colors. Values support `#RRGGBB` and `#RRGGBBAA`, not arbitrary CSS. Unknown fields, invalid colors, and empty themes report errors and cannot be submitted. A duplicate theme name is not silently replaced.

`PALETTE_FIELDS` in `userspace/gui/src/theme/palette.ts` registers supported fields: background, sidebar, content surface, overlay, body text, secondary text, accent, separator, secondary surface, hover, pressed, emphasized text, helper text, control border, code background, success, notice, and error. Theme files use the English names in that registry.

## Fonts and icons

`userspace/gui/src/theme/typography.ts` resolves fonts, with all selections saved in the same user settings store. `gui.fontFamily` defaults to the full Achbit Quiet Reading Sans SC (`warm-sans`); existing explicit selections remain unchanged. Other choices are Quiet Reading Kai (`warm`), Compact Terminal Kai (`compact-kai`), Compact Terminal Sans (`compact`), system default, and installed custom fonts. Each pair shares Latin glyphs and differs in CJK style. Both compact variants use 500-unit ASCII and 1000-unit CJK widths. Kai is a Chinese handwriting style; the sans variants use rounded sans-serif glyphs. Themes control colors only.

Appearance initially shows the overall font and preview. Font details groups interface, content, and terminal/code choices. `gui.interfaceFontFamily`, `gui.contentFontFamily`, and `gui.terminalFontFamily` default to `inherit`. Changing the overall font resets all three to inherit; each can then be overridden. Interface `gui.fontSize` and content `gui.contentFontSize` default to 14 px (range 12–18). Code `gui.codeFontSize` defaults to 12 px (range 10–18). Sizes are independent of family selection. GUI code, command output, files, and diffs use the terminal font; measurements requiring fixed width and numeric labels may still use dedicated monospace tokens.

Font details provides font and size selection, without a separate TUI preference store, font download, or terminal configuration export. macOS `Achbit-TUI.command` and the installed `achbit-tui` load fonts in a dedicated Terminal window; Windows uses a dedicated console. Both read `gui.terminalFontFamily`, falling back to `gui.fontFamily` when it is `inherit`, and use `gui.codeFontSize`. In TUI, `/font` lists choices, `/font compact` overrides the current window, and `/font follow` reloads GUI choices. Ordinary terminal defaults remain unchanged. `--in-place`, noninteractive pipes, and `--smoke` retain the current terminal. Linux glyph rendering remains controlled by the external terminal. Font sources and reproduction instructions are in `userspace/gui/src/assets/fonts/README.md`.

`userspace/gui/src/icons/registry.tsx` registers built-in UI icons. `UI_ICON_ROLES` maps settings categories and activity-bar roles. Use `UiIcon`; do not define SVG paths in business components or simulate icons with Unicode characters. Icons use a 24 × 24 grid, 1.65 stroke, and `currentColor`. Brand wordmarks and resource-content images are separate from action icons.

The four TUI fonts use terminal variants with matching outlines and one-cell Latin/two-cell CJK widths; GUI fonts retain their original proportional widths. Font changes preserve the dedicated window's size, and the TUI reflows for updated rows and columns. Custom terminal fonts must have fixed widths; proportional fonts cannot be applied directly to a character grid.

## Scope and activation

The default palette covers application-owned GUI/Editor styles, terminal colors, and diff backgrounds. User theme imports and visual palette editing target GUI semantic colors. Syntax highlighting, external HTML/PDF/images, and plugin content belong to their renderers; this entrypoint does not rewrite their colors.

After changing built-in colors, build frontend resources through the project's Docker entrypoint. User-saved themes and fonts apply immediately to the GUI without rebuilding. Existing dedicated macOS TUI windows use `/font follow` to reload fonts and sizes, or apply them on next launch. Source changes to TUI binaries, terminal fonts, or native window scripts require an updated platform package and a TUI restart.
