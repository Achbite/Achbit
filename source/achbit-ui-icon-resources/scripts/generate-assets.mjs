import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

// Editable geometry lives in sources/icons.json and brand/masters/*.svg.
// Run inside the project development container; librsvg exports the PNGs.
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
if (!process.argv.includes('--svg-only')) execFileSync('rsvg-convert', ['--version'], { stdio: 'ignore' });
const icons = JSON.parse(readFileSync(join(root, 'sources/icons.json'), 'utf8'));
const sizes = [16, 20, 24, 32, 64];
const strokes = { 16: 2, 20: 1.85, 24: 1.75, 32: 1.65, 64: 1.5 };
const palettes = {
  dark: {
    bg_primary: '#111214', surface_1: '#191A1D', surface_2: '#222428', surface_3: '#2B2D32',
    border: '#383B42', text_primary: '#F5F5F7', text_muted: '#A1A5AE', text_disabled: '#767C88',
    icon_neutral: '#D9DEE7', icon_muted: '#929BAA', accent_blue: '#459CFF',
    success: '#40D98B', warning: '#FFBD59', error: '#FF746C',
  },
  light: {
    bg_primary: '#F5F5F7', surface_1: '#FFFFFF', surface_2: '#EBEDF1', surface_3: '#E2E5EB',
    border: '#D9DDE4', text_primary: '#1D1D1F', text_muted: '#616773', text_disabled: '#797F8A',
    icon_neutral: '#424854', icon_muted: '#737C89', accent_blue: '#0868CE',
    success: '#187D4B', warning: '#996000', error: '#CE3541',
  },
};
const tokenNames = {
  bg_primary: 'bg-primary', surface_1: 'surface-1', surface_2: 'surface-2', surface_3: 'surface-3',
  border: 'border', text_primary: 'text-primary', text_muted: 'text-muted', text_disabled: 'text-disabled',
  icon_neutral: 'neutral', icon_muted: 'muted', accent_blue: 'accent', success: 'success', warning: 'warning', error: 'error',
};
function write(path, content) {
  const target = join(root, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, content);
}
function svg(width, height, label, body, attributes = '') {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="${label}" ${attributes}>\n<title>${label}</title>\n${body}\n</svg>\n`;
}
function masterBody(name) {
  return readFileSync(join(root, `brand/masters/achbit-${name}.svg`), 'utf8')
    .replace(/^[\s\S]*?<svg[^>]*>/, '').replace(/<title>[\s\S]*?<\/title>/, '').replace(/<\/svg>\s*$/, '').trim();
}
const mark = masterBody('mark');
const nativeIcons = resolve(root, '../../shells/achbit-gui/src-tauri/icons');

const wordmark = masterBody('wordmark');
function iconBody(icon, size) {
  return size === 16 && icon.compact_body ? icon.compact_body : icon.body;
}
function iconSvg(icon, size, color = 'currentColor') {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="${strokes[size]}" stroke-linecap="round" stroke-linejoin="round"${color === 'currentColor' ? '' : ` color="${color}"`} role="img" aria-label="${icon.label}">\n<title>${icon.label}</title>\n${iconBody(icon, size)}\n</svg>\n`;
}
const pngJobs = [];
// Native application tile and in-app monochrome mark share the same editable geometry.
write('brand/svg/achbit-app.svg', svg(1024, 1024, 'Achbit AC', `<rect x="64" y="64" width="896" height="896" rx="204" fill="#F5F5F7"/><g transform="translate(192 192) scale(5)" fill="#1D1D1F">${mark}</g>`));
mkdirSync(nativeIcons, { recursive: true });
writeFileSync(resolve(root, '../../userspace/gui/src/assets/achbit-mark.svg'), svg(128, 128, 'Achbit AC', mark, 'fill="currentColor"'));

for (const icon of icons) {
  for (const size of sizes) {
    const filename = `icon-${icon.name}-${size}`;
    write(`svg/currentColor/${size}/${filename}.svg`, iconSvg(icon, size));
    for (const theme of ['dark', 'light']) {
      const dir = theme === 'dark' ? 'themed' : 'themed-light';
      const pngDir = theme === 'dark' ? 'png' : 'png/light';
      const svgPath = `svg/${dir}/${size}/${filename}.svg`;
      write(svgPath, iconSvg(icon, size, palettes[theme][icon.color_token]));
      pngJobs.push([svgPath, `${pngDir}/${size}/${filename}.png`, size]);
    }
  }
  write(`svg/24/icon-${icon.name}-24.svg`, iconSvg(icon, 24));
}
const symbols = icons.map(icon =>
  `<symbol id="ac-icon-${icon.name}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round">${icon.body}</symbol>`
  + (icon.compact_body ? `\n<symbol id="ac-icon-${icon.name}-16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${icon.compact_body}</symbol>` : '')
).join('\n');
write('sprite/achbit-icons.svg', `<svg xmlns="http://www.w3.org/2000/svg">\n${symbols}\n</svg>\n`);

function paletteCss(theme) {
  const selector = theme === 'dark' ? ':root, [data-ac-theme="dark"]' : '[data-ac-theme="light"]';
  return `${selector} {\n  color-scheme: ${theme};\n${Object.entries(palettes[theme]).map(([key, value]) => `  --ac-icon-${tokenNames[key]}: ${value};`).join('\n')}\n}`;
}
write('tokens/achbit-icon-tokens.css', `${paletteCss('dark')}\n${paletteCss('light')}\n
.ac-icon { width: 20px; height: 20px; color: var(--ac-icon-neutral); display: inline-block; vertical-align: -0.125em; flex: 0 0 auto; }
.ac-icon--sm { width: 16px; height: 16px; }
.ac-icon--md { width: 20px; height: 20px; }
.ac-icon--lg { width: 24px; height: 24px; }
.ac-icon--xl { width: 32px; height: 32px; }
.ac-icon--active { color: var(--ac-icon-accent); }
.ac-icon--muted { color: var(--ac-icon-muted); }
.ac-icon--success { color: var(--ac-icon-success); }
.ac-icon--warning { color: var(--ac-icon-warning); }
.ac-icon--error { color: var(--ac-icon-error); }
`);

const brandFiles = { mark: {}, wordmark: {} };
for (const [appearance, color] of Object.entries({ light: '#0868CE', dark: '#67ACFF', mono: 'currentColor' })) {
  const path = `brand/svg/achbit-mark-${appearance}.svg`;
  write(path, svg(128, 128, 'Achbit', mark, `fill="${color}"`));
  brandFiles.mark[appearance] = path;
  if (appearance !== 'mono') pngJobs.push([path, `brand/png/achbit-mark-${appearance}-512.png`, 512]);
}
for (const [appearance, color] of Object.entries({ light: '#1D1D1F', dark: '#F5F5F7', mono: 'currentColor' })) {
  const path = `brand/svg/achbit-wordmark-${appearance}.svg`;
  write(path, svg(508, 112, 'Achbit', wordmark, `fill="${color}"`));
  brandFiles.wordmark[appearance] = path;
  if (appearance !== 'mono') {
    pngJobs.push([path, `brand/png/achbit-wordmark-${appearance}-1016.png`, 1016]);
  }
}

function sheetIcon(icon, x, y, size, theme) {
  const color = palettes[theme][icon.color_token];
  return `<g transform="translate(${x} ${y}) scale(${size / 24})" color="${color}" fill="none" stroke="${color}" stroke-width="${strokes[size] ?? 1.75}" stroke-linecap="round" stroke-linejoin="round">${iconBody(icon, size).replaceAll('currentColor', color)}</g>`;
}
function brandSheet() {
  let body = `<rect width="1440" height="1380" fill="#F5F5F7"/>
<text x="72" y="65" fill="#616773" font-size="14" letter-spacing="3">ACHBIT / VISUAL IDENTITY</text>
<text x="1368" y="65" fill="#616773" font-size="14" text-anchor="end">ARTWORK / 2.0</text>
<g transform="translate(212 105) scale(2)" fill="#1D1D1F">${wordmark}</g>
<text x="720" y="355" fill="#616773" font-size="18" text-anchor="middle">Achbit / Original outlined wordmark</text>
<rect x="72" y="400" width="636" height="200" rx="28" fill="#FFFFFF"/>
<g transform="translate(136 435)" fill="#1D1D1F">${wordmark}</g>
<text x="104" y="574" fill="#616773" font-size="13" letter-spacing="1.5">LIGHT / WORDMARK</text>
<rect x="732" y="400" width="636" height="200" rx="28" fill="#191A1D"/>
<g transform="translate(796 435)" fill="#F5F5F7">${wordmark}</g>
<text x="764" y="574" fill="#A1A5AE" font-size="13" letter-spacing="1.5">DARK / WORDMARK</text>
<text x="72" y="672" fill="#1D1D1F" font-size="24" font-weight="600">AC / Independent monogram</text>
<text x="72" y="708" fill="#616773" font-size="16">AC / Accepted. Clear geometry.</text>
<g transform="translate(1176 610) scale(1.25)" fill="#0868CE">${mark}</g>
<path d="M72 764h1296" stroke="#D9DDE4"/>
<text x="72" y="812" fill="#1D1D1F" font-size="26" font-weight="600">Interface symbols</text>
<text x="1368" y="812" fill="#616773" font-size="14" text-anchor="end">31 SYMBOLS / 5 OPTICAL SIZES</text>`;
  icons.forEach((icon, index) => {
    const x = 72 + (index % 8) * 162;
    const y = 846 + Math.floor(index / 8) * 110;
    body += sheetIcon(icon, x + 58, y + 14, 32, 'light');
    body += `<text x="${x + 74}" y="${y + 78}" fill="#616773" font-size="12" text-anchor="middle">${icon.label}</text>`;
  });
  body += '<path d="M72 1316h1296" stroke="#D9DDE4"/><text x="72" y="1352" fill="#616773" font-size="13">Original vector artwork / Outlined lettering / Light + dark</text><text x="1368" y="1352" fill="#616773" font-size="13" text-anchor="end">Achbit</text>';
  return svg(1440, 1380, 'Achbit wordmark, independent AC monogram and interface icons', `<g font-family="DejaVu Sans, sans-serif">${body}</g>`);
}
write('preview/achbit-brand-sheet.svg', brandSheet());
pngJobs.push(['preview/achbit-brand-sheet.svg', 'preview/achbit-brand-sheet.png', 1440]);
let darkSheet = `<rect width="1440" height="850" fill="#111214"/><g transform="translate(65 38) scale(.9)" fill="#F5F5F7">${wordmark}</g><text x="1368" y="100" fill="#A1A5AE" font-size="16" text-anchor="end">INTERFACE SYMBOLS / DARK</text>`;
icons.forEach((icon, index) => {
  const x = 72 + index % 8 * 162;
  const y = 180 + Math.floor(index / 8) * 150;
  darkSheet += `<rect x="${x}" y="${y}" width="148" height="132" rx="18" fill="#191A1D"/>`;
  darkSheet += sheetIcon(icon, x + 54, y + 25, 40, 'dark');
  darkSheet += `<text x="${x + 74}" y="${y + 103}" fill="#A1A5AE" font-size="12" text-anchor="middle">${icon.label}</text>`;
});
write('preview/achbit-icon-sheet.svg', svg(1440, 850, 'Achbit interface icons — dark', `<g font-family="DejaVu Sans, sans-serif">${darkSheet}</g>`));
pngJobs.push(['preview/achbit-icon-sheet.svg', 'preview/achbit-icon-sheet.png', 1440]);

let sizeSheet = '';
for (const [column, theme] of ['light', 'dark'].entries()) {
  const left = column * 640;
  const palette = palettes[theme];
  sizeSheet += `<rect x="${left}" width="640" height="730" fill="${palette.bg_primary}"/><text x="${left + 28}" y="48" fill="${palette.text_primary}" font-size="20" font-weight="600">Achbit / ${theme}</text>`;
  sizes.forEach((size, index) => {
    sizeSheet += `<text x="${left + 185 + index * 94}" y="105" fill="${palette.text_muted}" font-size="12" text-anchor="middle">${size} px</text>`;
  });
  ['ai-agent', 'kernel', 'workflow-task', 'chart-donut', 'warning', 'folder-tree'].forEach((name, row) => {
    const icon = icons.find(candidate => candidate.name === name);
    const centerY = 163 + row * 84;
    sizeSheet += `<text x="${left + 28}" y="${centerY + 4}" fill="${palette.text_muted}" font-size="12">${name}</text>`;
    sizes.forEach((size, index) => { sizeSheet += sheetIcon(icon, left + 185 + index * 94 - size / 2, centerY - size / 2, size, theme); });
  });
  sizeSheet += `<text x="${left + 28}" y="685" fill="${palette.text_muted}" font-size="12">View at 100% / Actual optical sizes / SVG source geometry</text>`;
}
write('preview/achbit-size-sheet.svg', svg(1280, 730, 'Achbit optical sizes in light and dark', `<g font-family="DejaVu Sans, sans-serif">${sizeSheet}</g>`));
pngJobs.push(['preview/achbit-size-sheet.svg', 'preview/achbit-size-sheet.png', 1280]);

const cards = icons.map(icon => `<a class="icon-card ink-${icon.color_token}" data-name="${icon.name}" data-label="${icon.label.toLowerCase()}" data-category="${icon.category}" data-compact="${Boolean(icon.compact_body)}" href="../svg/currentColor/24/icon-${icon.name}-24.svg" download aria-label="下载 ${icon.label} SVG"><span class="icon-stage">${iconSvg(icon, 24).replace('role="img"', 'aria-hidden="true"')}</span><span class="icon-name">${icon.label}</span><span class="icon-id">${icon.name}</span></a>`).join('\n');
let html = readFileSync(join(root, 'sources/preview.html'), 'utf8');
html = html.replace('<!-- ICON_CARDS -->', cards);
// The preview embeds each actual optical variant, so the 16px check is not a scaled 24px drawing.
const previewData = Object.fromEntries(icons.map(icon => [icon.name, Object.fromEntries(sizes.map(size => [size, iconSvg(icon, size).replace('role="img"', 'aria-hidden="true"')]))]));
html = html.replace('/* ICON_VARIANTS */', `const iconVariants = ${JSON.stringify(previewData)};`);
write('preview/index.html', html);

write('manifest.json', JSON.stringify({
  name: 'Achbit UI Icon Set', version: '2.0.0', style: 'Optically balanced outline, a primary wordmark and an independent AC monogram',
  viewBox: '0 0 24 24', stroke: { width: 1.75, linecap: 'round', linejoin: 'round', by_size: strokes },
  sizes, palette: palettes.dark, palettes, default_themed_appearance: 'dark',
  sources: { icons: 'sources/icons.json', mark: 'brand/masters/achbit-mark.svg', wordmark: 'brand/masters/achbit-wordmark.svg', preview: 'sources/preview.html', generator: 'scripts/generate-assets.mjs' },
  brand: { name: 'Achbit', primary: 'wordmark', secondary: 'mark', lettering: 'Original outlined glyphs, not an installable font', files: brandFiles },
  previews: { interactive: 'preview/index.html', brand: 'preview/achbit-brand-sheet.png', icons: 'preview/achbit-icon-sheet.png', sizes: 'preview/achbit-size-sheet.png' },
  icons: icons.map(({ body, compact_body, ...icon }) => ({ ...icon,
    files: { svg_currentColor_24: `svg/currentColor/24/icon-${icon.name}-24.svg`, svg_themed_24: `svg/themed/24/icon-${icon.name}-24.svg`, svg_themed_light_24: `svg/themed-light/24/icon-${icon.name}-24.svg`, png_24: `png/24/icon-${icon.name}-24.png`, png_light_24: `png/light/24/icon-${icon.name}-24.png`, sprite_id: `ac-icon-${icon.name}` },
    ...(compact_body ? { compact_sprite_id: `ac-icon-${icon.name}-16` } : {}),
  })),
  references: ['https://developer.apple.com/design/human-interface-guidelines/icons', 'https://developer.apple.com/design/human-interface-guidelines/typography'],
}, null, 2) + '\n');

if (!process.argv.includes('--svg-only')) {
  for (const [source, destination, width] of pngJobs) {
    mkdirSync(dirname(join(root, destination)), { recursive: true });
    execFileSync('rsvg-convert', ['--width', String(width), '--output', join(root, destination), join(root, source)], { stdio: 'pipe' });
  }
}
if (!process.argv.includes('--svg-only')) {
  execFileSync('rsvg-convert', ['--width', '1024', '--output', join(nativeIcons, 'icon.png'), join(root, 'brand/svg/achbit-app.svg')]);
  const pngs = [16, 32, 64, 128, 256, 512, 1024].map(size => execFileSync('rsvg-convert', ['--width', String(size), join(root, 'brand/svg/achbit-app.svg')]));
  // ICO PNG entries and ICNS PNG chunks need no image-processing dependency.
  const icoPngs = pngs.slice(0, 5), header = Buffer.alloc(6 + 16 * icoPngs.length);
  header.writeUInt16LE(1, 2); header.writeUInt16LE(icoPngs.length, 4);
  let offset = header.length;
  icoPngs.forEach((png, i) => {
    const at = 6 + 16 * i, size = [16, 32, 64, 128, 256][i];
    header[at] = header[at + 1] = size === 256 ? 0 : size;
    header.writeUInt16LE(1, at + 4); header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(png.length, at + 8); header.writeUInt32LE(offset, at + 12); offset += png.length;
  });
  writeFileSync(join(nativeIcons, 'icon.ico'), Buffer.concat([header, ...icoPngs]));
  const chunks = ['icp4', 'icp5', 'icp6', 'ic07', 'ic08', 'ic09', 'ic10'].map((type, i) => {
    const chunk = Buffer.alloc(8); chunk.write(type); chunk.writeUInt32BE(8 + pngs[i].length, 4);
    return Buffer.concat([chunk, pngs[i]]);
  });
  const icns = Buffer.alloc(8); icns.write('icns'); icns.writeUInt32BE(8 + chunks.reduce((n, chunk) => n + chunk.length, 0), 4);
  writeFileSync(join(nativeIcons, 'icon.icns'), Buffer.concat([icns, ...chunks]));
}
console.log(`Exported ${icons.length} icons at ${sizes.join('/')}px, brand SVGs, manifest and preview${process.argv.includes('--svg-only') ? ' (SVG only)' : `, and ${pngJobs.length} PNGs`}.`);
