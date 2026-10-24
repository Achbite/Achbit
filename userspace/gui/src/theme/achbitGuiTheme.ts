export const GUI_THEME_PREFERENCES = ['system', 'light', 'dark'] as const;
export const GUI_ACCENT_COLORS = ['blue', 'purple', 'green'] as const;

export type GuiThemePreference = (typeof GUI_THEME_PREFERENCES)[number];
export type GuiResolvedTheme = Exclude<GuiThemePreference, 'system'>;
export type GuiAccentColor = (typeof GUI_ACCENT_COLORS)[number];

export function normalizeGuiThemePreference(value: unknown): GuiThemePreference {
  if (value === 'system') return 'system';
  if (value === 'dark' || value === 'achbit-gui-dark') return 'dark';
  return 'light';
}

export function normalizeGuiAccentColor(value: unknown): GuiAccentColor {
  if (value === 'purple' || value === 'green') return value;
  return 'blue';
}

export function resolveGuiTheme(
  preference: GuiThemePreference,
  prefersDark: boolean,
): GuiResolvedTheme {
  return preference === 'system' ? (prefersDark ? 'dark' : 'light') : preference;
}
