/* Only the resolved appearance travels between the two documents. Never forward the settings store. */
const colors = ['--ac-surface-raised', '--ac-surface-hover', '--ac-surface-active', '--ac-border', '--ac-foreground', '--ac-muted', '--ac-success', '--ac-success-soft', '--ac-accent', '--ac-danger'] as const;

export function captureCompletionAppearance(language: string): string {
  const root = document.documentElement;
  const style = getComputedStyle(root);
  return JSON.stringify({ language, dark: root.dataset.theme === 'dark',
    font: style.getPropertyValue('--ac-font-ui').trim(), scale: Number(style.getPropertyValue('--ac-ui-font-scale')) || 1,
    colors: Object.fromEntries(colors.map(key => [key, style.getPropertyValue(key).trim()])) });
}

export function applyCompletionAppearance(raw: string | null): void {
  const root = document.documentElement;
  root.dataset.theme = matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  if (!raw) return;
  let value;
  try { value = JSON.parse(raw); } catch { return; }
  if (!value || typeof value !== 'object') return;
  if (typeof value.dark === 'boolean') root.dataset.theme = value.dark ? 'dark' : 'light';
  if (value.language === 'en-US' || value.language === 'zh-CN') root.lang = value.language;
  if (typeof value.scale === 'number' && value.scale >= 12 / 14 && value.scale <= 18 / 14) root.style.setProperty('--ac-ui-font-scale', String(value.scale));
  if (typeof value.font === 'string' && CSS.supports('font-family', value.font)) root.style.setProperty('--ac-font-ui', value.font);
  for (const key of colors) {
    const color = value.colors?.[key];
    if (typeof color === 'string' && CSS.supports('color', color)) root.style.setProperty(key, color);
  }
}
