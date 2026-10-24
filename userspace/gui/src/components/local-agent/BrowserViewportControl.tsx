import type { BrowserViewport } from '../../services/nativeBrowser';
import { type UiLanguage, t } from '../../i18n';
import { DEFAULT_BROWSER_VIEWPORT } from './browserViewport';

export function BrowserViewportControl({ value, onChange, language, disabled = false }: {
  value: BrowserViewport; onChange(value: BrowserViewport): void; language: UiLanguage; disabled?: boolean;
}) {
  const fixed = value.mode === 'fixed' ? value : DEFAULT_BROWSER_VIEWPORT;
  return <select className="browser-viewport-control" aria-label={t(language, 'reader.viewport.label')}
    title={t(language, 'reader.viewport.label')} value={value.mode} disabled={disabled}
    onChange={event => onChange(event.target.value === 'adaptive' ? { mode: 'adaptive' } : fixed)}>
    <option value="fixed">{t(language, 'reader.viewport.fixed')}{fixed.mode === 'fixed' ? ` ${fixed.width} × ${fixed.height}` : ''}</option>
    <option value="adaptive">{t(language, 'reader.viewport.adaptive')}</option>
  </select>;
}
