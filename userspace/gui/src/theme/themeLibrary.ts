import { PALETTE_FIELDS, UI_PALETTE, decodePaletteOverrides, paletteToken, resetPaletteTheme, type PaletteField, type PaletteOverrides } from './palette';
import type { GuiResolvedTheme } from './achbitGuiTheme';

export const THEME_LIBRARY_SETTING = 'gui.themeLibrary';
export interface ThemeDocument {
  name: string;
  light?: Partial<Record<PaletteField, string>>;
  dark?: Partial<Record<PaletteField, string>>;
}
export interface SavedTheme extends ThemeDocument { id: string }

export function builtinThemes(): SavedTheme[] {
  return UI_PALETTE.themes.map((theme) => ({ id: `builtin:${theme.name}`, ...readTheme(theme) }));
}

function readTheme(value: unknown): ThemeDocument {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Theme must be a JSON object.');
  const data = value as Record<string, unknown>;
  for (const key of Object.keys(data)) {
    if (!['name', 'light', 'dark'].includes(key)) throw new Error(`Unknown theme field: ${key}`);
  }
  if (typeof data.name !== 'string' || !data.name.trim() || data.name.trim().length > 80) {
    throw new Error('Theme name must contain 1–80 characters.');
  }
  const result: ThemeDocument = { name: data.name.trim() };
  for (const mode of ['light', 'dark'] as const) {
    if (data[mode] === undefined) continue;
    const colors = data[mode];
    if (!colors || typeof colors !== 'object' || Array.isArray(colors)) throw new Error(`${mode} must be a color object.`);
    const entries = Object.entries(colors);
    for (const [field] of entries) {
      if (!(PALETTE_FIELDS as readonly string[]).includes(field)) throw new Error(`Unknown ${mode} color: ${field}`);
    }
    decodePaletteOverrides(JSON.stringify(Object.fromEntries(entries.map(([field, color]) => [paletteToken(mode, field as PaletteField), color]))));
    result[mode] = Object.fromEntries(entries.map(([field, color]) => [field, (color as string).toLowerCase()]));
  }
  if (!Object.keys(result.light ?? {}).length && !Object.keys(result.dark ?? {}).length) throw new Error('Theme needs at least one light or dark color.');
  return result;
}

export function importTheme(encoded: string): ThemeDocument { return readTheme(JSON.parse(encoded)); }

export function decodeThemeLibrary(encoded: string): SavedTheme[] {
  const value: unknown = JSON.parse(encoded);
  if (!Array.isArray(value)) throw new Error('Theme library must be a JSON array.');
  const ids = new Set<string>();
  return value.map((item) => {
    if (!item || typeof item !== 'object' || Array.isArray(item)) throw new Error('Invalid saved theme.');
    const { id, ...document } = item;
    if (typeof id !== 'string' || !id.trim() || id.startsWith('builtin:') || ['default', 'custom'].includes(id) || ids.has(id)) throw new Error('Invalid or duplicate theme ID.');
    ids.add(id);
    return { id, ...readTheme(document) };
  });
}

export function themeOverrides(theme: ThemeDocument): PaletteOverrides {
  return Object.fromEntries((['light', 'dark'] as const).flatMap((mode) =>
    Object.entries(theme[mode] ?? {}).map(([field, color]) => [paletteToken(mode, field as PaletteField), color])));
}

/** Selection is derived from the applied palette, so editing colors never leaves a stale theme name. */
export function applyThemePalette(overrides: PaletteOverrides, theme: ThemeDocument | null, mode: GuiResolvedTheme): PaletteOverrides {
  return { ...resetPaletteTheme(overrides, mode), ...(theme ? themeOverrides({ name: theme.name, [mode]: theme[mode] }) : {}) };
}

export function selectedThemeId(library: SavedTheme[], overrides: PaletteOverrides, mode: GuiResolvedTheme): string {
  const tokens = new Set(PALETTE_FIELDS.map((field) => paletteToken(mode, field)));
  const entries = Object.entries(overrides).filter(([key]) => tokens.has(key));
  if (!entries.length) return 'default';
  return library.find((theme) => {
    const colors = themeOverrides({ name: theme.name, [mode]: theme[mode] });
    return Object.keys(colors).length === entries.length && entries.every(([key, value]) => colors[key]?.toLowerCase() === value.toLowerCase());
  })?.id ?? 'custom';
}
