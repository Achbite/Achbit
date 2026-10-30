# Achbit brand and icon usage

## Brand marks

The product name is **Achbit**, and the primary brand uses the complete wordmark. The standalone **AC** abbreviation places A and C side by side, joined by curves while retaining clear counters and an open outline. Both use original geometric paths, respectively for full branding and abbreviated contexts. Brand masters contain no `<text>` elements and do not embed or distribute font files.

| Context | Asset | Suggested minimum size |
| --- | --- | --- |
| Navigation, headings, full branding | `brand/svg/achbit-wordmark-*.svg` | 120 px wide |
| Standalone AC abbreviation | `brand/svg/achbit-mark-*.svg` | 24 × 24 px |

- `light` is for light backgrounds; `dark` is for dark backgrounds.
- `mono` uses `currentColor` for inline monochrome interfaces or print.
- Scale proportionally. Leave clear space of at least one quarter of the visible symbol height around the symbol, and one quarter of the capital height around the wordmark.
- Use the complete wordmark and AC mark separately. Primary brand areas use the wordmark alone.
- Keep the AC mark transparent and monochrome, preserving its outline and open spaces.
- Wordmark PNGs are 1016 × 224 px; AC PNGs are 512 × 512 px. Both have transparent light/dark variants.

## Interface icons

Icons share a `0 0 24 24` coordinate system with rounded caps and joins. Optical stroke widths vary with target size so small icons retain weight and large icons do not become too heavy.

| Export size | Coordinate-space stroke-width | Approximate pixel width |
| ---: | ---: | ---: |
| 16 px | 2 | 1.33 px |
| 20 px | 1.85 | 1.54 px |
| 24 px | 1.75 | 1.75 px |
| 32 px | 1.65 | 2.20 px |
| 64 px | 1.5 | 4.00 px |

The 16 px `ai-agent` omits one decorative star; the 16 px `kernel` uses a solid core to reduce fragmented edges. Other icons retain their outline with the corresponding optical stroke. Select the export for the target size; do not substitute the 64 px asset for a dedicated 16 px version.

Icons primarily use outlines. Ellipses, information dots, activity grids, and similar details use filled areas. States must retain distinct shapes and readable text, not depend on color alone. `refresh` uses two arrows; `in-progress` uses a clock and open ring; `chart-donut` uses a segmented ring to distinguish it from a generic status circle.

Icon dimensions are not interaction target dimensions. The host interface supplies padding, focus indication, and text labels.

## Light and dark themes

| Meaning | CSS token | Light background | Dark background |
| --- | --- | --- | --- |
| Neutral | `--ac-icon-neutral` | `#424854` | `#D9DEE7` |
| Muted | `--ac-icon-muted` | `#737C89` | `#929BAA` |
| Blue / selected | `--ac-icon-accent` | `#0868CE` | `#459CFF` |
| Success | `--ac-icon-success` | `#187D4B` | `#40D98B` |
| Warning | `--ac-icon-warning` | `#996000` | `#FFBD59` |
| Error | `--ac-icon-error` | `#CE3541` | `#FF746C` |

`tokens/achbit-icon-tokens.css` defaults to the dark theme. The host explicitly sets `data-ac-theme="light"` or `data-ac-theme="dark"`; this asset package does not create theme persistence or application preferences.

### Inline SVG

Use the SVG inline or as a component and set its outer color. React/Vite `?react` imports apply only when the host already configures SVGR; this package does not require another transform plugin.

```html
<div data-ac-theme="light">
  <button type="button" aria-label="Open terminal">
    <svg class="ac-icon" viewBox="0 0 24 24" aria-hidden="true">
      <use href="/icons/sprite/achbit-icons.svg#ac-icon-terminal"></use>
    </svg>
  </button>
</div>
```

Sprite `ac-icon-*` IDs use 24 px outlines. `ac-icon-ai-agent-16` and `ac-icon-kernel-16` provide simplified outlines. For exact 16 / 20 / 32 / 64 px optical strokes, use the individual SVG in the corresponding directory.

### Images

An SVG inside `<img>` does not inherit the page's `currentColor`. Select the fixed theme variant; do not infer resource colors from a parent color or CSS filter.

```html
<!-- Light background -->
<img src="/icons/svg/themed-light/20/icon-folder-20.svg"
     width="20" height="20" alt="Folder">
<!-- Dark background; themed retains the original path -->
<img src="/icons/svg/themed/20/icon-folder-20.svg"
     width="20" height="20" alt="Folder">
```

Choose PNGs the same way: `png/` for dark backgrounds and `png/light/` for light backgrounds. Both sets are transparent. Decorative images use empty `alt`; icon buttons supply their action name on the button to avoid duplicate announcements.

## Asset maintenance

1. Edit geometry and metadata in `sources/icons.json`, or brand masters under `brand/masters/`.
2. Edit preview layout in `sources/preview.html`, and colors/export specifications in `scripts/generate-assets.mjs`.
3. Run the complete export in the project development container mounting the intended worktree.
4. Inspect light/dark sheets, 16 px outlines, resource references, and PNG dimensions. Resolve export failures before treating existing PNGs as current output.

```sh
# Install the PNG renderer inside the development container if it is unavailable:
apt-get update
apt-get install -y --no-install-recommends librsvg2-bin

# Export from /workspace inside the container:
node source/achbit-ui-icon-resources/scripts/generate-assets.mjs
```

Generated `preview/index.html` embeds the actual SVGs and opens directly without a server, network fonts, framework, or external scripts. Filtering and size selection affect only the preview; download links follow the selected size.

## Design references

- [Apple HIG — Icons](https://developer.apple.com/design/human-interface-guidelines/icons): coordinate visual weight with the host interface.
- [Apple HIG — Typography](https://developer.apple.com/design/human-interface-guidelines/typography): prioritize legibility and establish hierarchy with weight, proportion, and spacing.

This package follows design principles without copying Apple brand graphics, SF Symbols, or font assets.
