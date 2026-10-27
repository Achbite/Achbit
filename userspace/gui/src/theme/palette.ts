import palette from '../../../../config/ui/palette.json';
import type { GuiAccentColor, GuiResolvedTheme } from './achbitGuiTheme';
import './paletteBase.css';

export const PALETTE_SETTING = 'workbench.styleTokenOverrides';
export const UI_PALETTE = palette;
export const PALETTE_FIELDS = [
  'background', 'sidebar', 'surface', 'surface-raised', 'foreground', 'muted',
  'accent', 'border', 'surface-subtle', 'surface-hover', 'surface-active',
  'foreground-strong', 'faint', 'border-strong', 'code-background',
  'success', 'warning', 'danger',
] as const;
export type PaletteField = typeof PALETTE_FIELDS[number];
export type PaletteOverrides = Record<string, string>;

export function paletteToken(theme: GuiResolvedTheme, field: PaletteField): string {
  return field === 'accent' ? `--ac-custom-${theme}-accent` : `--ac-theme-${theme}-${field}`;
}

const editableTokens = new Set(['light', 'dark'].flatMap((theme) =>
  PALETTE_FIELDS.map((field) => paletteToken(theme as GuiResolvedTheme, field))));

export function isPaletteColor(value: string): boolean {
  return /^#[\da-f]{6}(?:[\da-f]{2})?$/i.test(value);
}

/** Parse all entries before applying anything; malformed settings retain their original error. */
export function decodePaletteOverrides(encoded: string): PaletteOverrides {
  const value: unknown = JSON.parse(encoded);
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Palette must be a JSON object.');
  }
  for (const [key, color] of Object.entries(value)) {
    if (!editableTokens.has(key)) throw new Error(`Unknown palette token: ${key}`);
    if (typeof color !== 'string' || !isPaletteColor(color)) {
      throw new Error(`Invalid color for ${key}: ${String(color)} (use #RRGGBB or #RRGGBBAA).`);
    }
  }
  return value as PaletteOverrides;
}

export function paletteColor(overrides: PaletteOverrides, theme: GuiResolvedTheme, field: PaletteField, accent: GuiAccentColor): string {
  const token = paletteToken(theme, field);
  const defaultToken = field === 'accent' ? `--ac-accent-${accent}-${theme}` : token;
  return overrides[token] ?? palette.tokens[defaultToken as keyof typeof palette.tokens];
}

export function resetPaletteTheme(overrides: PaletteOverrides, theme: GuiResolvedTheme): PaletteOverrides {
  const removed = new Set(PALETTE_FIELDS.map((field) => paletteToken(theme, field)));
  return Object.fromEntries(Object.entries(overrides).filter(([key]) => !removed.has(key)));
}

export function paletteOverrideCss(encoded: string): string {
  const overrides = decodePaletteOverrides(encoded);
  const rules = Object.entries(overrides).map(([key, value]) => `${key}:${value};`);
  // A custom accent needs a matching foreground, including when the user chooses a very light color.
  for (const theme of ['light', 'dark'] as const) {
    const color = overrides[paletteToken(theme, 'accent')];
    if (!color) continue;
    const rgb = [1, 3, 5].map((offset) => {
      const channel = parseInt(color.slice(offset, offset + 2), 16) / 255;
      return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
    });
    const luminance = rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722;
    rules.push(`--ac-custom-${theme}-accent-contrast:var(${luminance > 0.179 ? '--ac-shadow-color' : '--ac-fixed-white'});`);
  }
  return `:root{${rules.join('')}}`;
}

/** Installed once by each frontend entry; no duplicate color table in component styles. */
export function installPaletteDefaults(): () => void {
  const style = document.createElement('style');
  style.dataset.achbitPalette = 'defaults';
  style.textContent = `:root{${Object.entries(palette.tokens).map(([key, value]) => `${key}:${value};`).join('')}}`;
  document.head.append(style);
  return () => style.remove();
}
