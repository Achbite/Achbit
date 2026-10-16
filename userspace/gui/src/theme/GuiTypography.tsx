import { useEffect } from 'react';
import { normalizeUiLanguage, t } from '../i18n';
import { useSettingsStore } from '../state/settingsStore';
import { typographyStyles } from './typography';
import './builtinFonts.css';

export default function GuiTypography() {
  const settings = useSettingsStore((state) => state.effectiveSettings);
  let styles: Record<string, string> | null = null;
  let error: string | null = null;
  try { styles = typographyStyles(settings); }
  catch (reason) { error = String(reason); }
  const serialized = JSON.stringify(styles);
  useEffect(() => {
    const values = JSON.parse(serialized) as Record<string, string> | null;
    if (!values) return;
    const root = document.documentElement;
    for (const [key, value] of Object.entries(values)) root.style.setProperty(key, value);
    return () => { for (const key of Object.keys(values)) root.style.removeProperty(key); };
  }, [serialized]);
  return error ? <div className="ui-palette-error" role="alert">
    {t(normalizeUiLanguage(settings['workbench.language']), 'settings.font.invalid')} {error}
  </div> : null;
}
