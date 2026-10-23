import { useState } from 'react';
import type { UserSettings } from '@achbit/protocol';
import ModalDialog from '../components/shared/ModalDialog';
import { normalizeUiLanguage, settingText, t } from '../i18n';
import { useSettingsStore } from '../state/settingsStore';
import { useInterfaceReloadGuard } from '../services/interfaceReload';
import { usageCostDisplay } from './usageCost';
import './usageWidgetSettings.css';

export function UsageWidgetSettings({ onClose }: { onClose(): void }) {
  const settings = useSettingsStore(state => state.effectiveSettings);
  const language = normalizeUiLanguage(settings['workbench.language']);
  const currencyText = settingText(language, 'gui.usageWidget.currency')!;
  const enabled = settings['gui.usageWidget.enabled'] !== false;
  const currency = usageCostDisplay(settings['gui.usageWidget.currency']).currency;
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useInterfaceReloadGuard(false, t(language, 'gui.usageWidget.settings'), busy);
  const save = async (patches: UserSettings) => {
    setBusy(true); setError('');
    try {
      const activation = await useSettingsStore.getState().patchUserSettingsBatch(patches);
      if (!activation) throw new Error(useSettingsStore.getState().errorMessage ?? t(language, 'settings.common.saveFailed'));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  };
  return <ModalDialog className="usage-widget-settings" aria-label={t(language, 'gui.usageWidget.settings')} onClose={onClose} busy={busy}>
    <div className="usage-widget-settings__body">
      <header><strong>{t(language, 'gui.usageWidget.settings')}</strong><button type="button" disabled={busy} onClick={onClose} aria-label={t(language, 'window.close')}>×</button></header>
      <label className="usage-widget-settings__row"><span>{t(language, 'gui.usageWidget.showWidget')}</span><input type="checkbox" checked={enabled} disabled={busy} onChange={event => void save({ 'gui.usageWidget.enabled': event.target.checked })} /></label>
      <label className="usage-widget-settings__row"><span>{currencyText.label}</span><select value={currency} disabled={busy} onChange={event => void save({ 'gui.usageWidget.currency': event.target.value })}><option value="USD">USD · {currencyText.options?.USD}</option><option value="CNY">CNY · {currencyText.options?.CNY}</option></select></label>
      <p>{currencyText.description}</p>
      {error && <p role="alert">{error}</p>}
    </div>
  </ModalDialog>;
}
