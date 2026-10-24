import { DEFAULT_USER_SETTINGS, type UserSettings } from '@achbit/protocol';

// The base choice is shared by the three presentation groups until overridden.
export const UI_FONT_FAMILY_SETTING = 'gui.fontFamily';
export const INTERFACE_FONT_FAMILY_SETTING = 'gui.interfaceFontFamily';
export const CONTENT_FONT_FAMILY_SETTING = 'gui.contentFontFamily';
export const TERMINAL_FONT_FAMILY_SETTING = 'gui.terminalFontFamily';
export const UI_FONT_SIZE_SETTING = 'gui.fontSize';
export const CONTENT_FONT_SIZE_SETTING = 'gui.contentFontSize';
export const CODE_FONT_SIZE_SETTING = 'gui.codeFontSize';
const SYSTEM_UI = '-apple-system, BlinkMacSystemFont, "SF Pro Text", "PingFang SC", "Segoe UI", sans-serif';
const SYSTEM_MONO = 'ui-monospace, "SFMono-Regular", Menlo, Consolas, monospace';
export const UI_FONT_PRESETS = {
  warm: `"Achbit Quiet Reading SC", ${SYSTEM_UI}`,
  'warm-sans': `"Achbit Quiet Reading Sans SC", ${SYSTEM_UI}`,
  'compact-kai': `"Achbit Quiet Mono Kai SC", ${SYSTEM_MONO}`,
  compact: `"Achbit Quiet Mono SC", ${SYSTEM_MONO}`,
  system: SYSTEM_UI,
  sans: 'Arial, "PingFang SC", "Microsoft YaHei", sans-serif',
  serif: 'Georgia, "Songti SC", "SimSun", serif',
  mono: SYSTEM_MONO,
} as const;
export const FONT_SETTING_KEYS = [UI_FONT_FAMILY_SETTING, INTERFACE_FONT_FAMILY_SETTING,
  CONTENT_FONT_FAMILY_SETTING, TERMINAL_FONT_FAMILY_SETTING, UI_FONT_SIZE_SETTING,
  CONTENT_FONT_SIZE_SETTING, CODE_FONT_SIZE_SETTING] as const;

export function uiFontFamily(value: unknown, terminal = false): string {
  if (value === undefined || value === null) value = DEFAULT_USER_SETTINGS[UI_FONT_FAMILY_SETTING];
  if (typeof value !== 'string' || !value.trim()) throw new Error('Font name cannot be empty.');
  if (value === 'system' && terminal) return SYSTEM_MONO;
  if (Object.hasOwn(UI_FONT_PRESETS, value)) return UI_FONT_PRESETS[value as keyof typeof UI_FONT_PRESETS];
  // A single installed family name, not a CSS declaration or a remote font URL.
  if (value.length > 120 || /[\x00-\x1f;{}<>]/.test(value)) throw new Error('Invalid font family name.');
  return `${JSON.stringify(value.trim())}, ${terminal ? SYSTEM_MONO : SYSTEM_UI}`;
}

export function fontChoice(settings: UserSettings, key: string): string {
  const choice = settings[key] ?? DEFAULT_USER_SETTINGS[key];
  return String(choice === 'inherit' ? settings[UI_FONT_FAMILY_SETTING] ?? DEFAULT_USER_SETTINGS[UI_FONT_FAMILY_SETTING] : choice);
}

export function uiFontSize(value: unknown): number {
  if (value === undefined || value === null) return 14;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 12 || value > 18) throw new Error('Text font size must be an integer from 12 to 18.');
  return value;
}

export function codeFontSize(value: unknown): number {
  if (value === undefined || value === null) return 12;
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 10 || value > 18) throw new Error('Code font size must be an integer from 10 to 18.');
  return value;
}

export function typographyStyles(settings: UserSettings): Record<string, string> {
  return {
    '--dc-font-ui': uiFontFamily(fontChoice(settings, INTERFACE_FONT_FAMILY_SETTING)),
    '--dc-font-reading': uiFontFamily(fontChoice(settings, CONTENT_FONT_FAMILY_SETTING)),
    '--dc-font-code': uiFontFamily(fontChoice(settings, TERMINAL_FONT_FAMILY_SETTING), true),
    '--dc-ui-font-scale': String(uiFontSize(settings[UI_FONT_SIZE_SETTING]) / 14),
    '--dc-font-reading-size': `${uiFontSize(settings[CONTENT_FONT_SIZE_SETTING])}px`,
    '--dc-font-code-size': `${codeFontSize(settings[CODE_FONT_SIZE_SETTING])}px`,
  };
}
