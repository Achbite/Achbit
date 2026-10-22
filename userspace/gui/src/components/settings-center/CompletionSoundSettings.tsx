import { useEffect, useRef, useState } from 'react';
import { t, type UiLanguage } from '../../i18n';
import { getCompletionSound, hasDesktopNotifications, previewCompletionSound, setCompletionSound,
  type CompletionSoundInfo } from '../../services/runtimeAdapter';
import { useSettingsSearchTarget } from './settingsSearch';

export default function CompletionSoundSettings({ language }: { language: UiLanguage }) {
  const [info, setInfo] = useState<CompletionSoundInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  const target = useSettingsSearchTarget('gui.completionSound');
  const available = hasDesktopNotifications();
  useEffect(() => {
    if (!available) return;
    let disposed = false;
    void getCompletionSound().then(value => { if (!disposed) setInfo(value); })
      .catch(reason => { if (!disposed) setError(String(reason)); });
    return () => { disposed = true; };
  }, [available]);
  if (!available) return null;
  const perform = async (action: () => Promise<void>) => {
    setBusy(true); setError(null);
    try { await action(); } catch (reason) { setError(String(reason)); }
    finally { setBusy(false); }
  };
  return <div className="settings-field settings-completion" ref={target} tabIndex={-1}>
    <span className="settings-field__label">{t(language, 'settings.completion.title')}</span>
    <div className="settings-field__description">{t(language, 'settings.completion.behavior')}</div>
    <div className="settings-completion-actions">
      <span>{t(language, info?.custom ? 'settings.completion.custom' : 'settings.completion.default')}</span>
      <button type="button" className="settings-button" disabled={busy || !info}
        onClick={() => void perform(previewCompletionSound)}>{t(language, 'settings.completion.preview')}</button>
      <button type="button" className="settings-button" disabled={busy || !info}
        onClick={() => input.current?.click()}>{t(language, 'settings.completion.choose')}</button>
      {info?.custom && <button type="button" className="settings-button" disabled={busy}
        onClick={() => void perform(async () => { setInfo(await setCompletionSound(null)); })}>{t(language, 'settings.completion.reset')}</button>}
    </div>
    <input ref={input} type="file" accept=".wav,audio/wav,audio/x-wav" hidden onChange={event => {
      const file = event.currentTarget.files?.[0]; event.currentTarget.value = '';
      if (file) void perform(async () => {
        if (file.size > 8 * 1024 * 1024) throw new Error(t(language, 'settings.completion.format'));
        setInfo(await setCompletionSound(Array.from(new Uint8Array(await file.arrayBuffer()))));
      });
    }} />
    <div className="settings-field__description">{t(language, 'settings.completion.format')}</div>
    {info && <div className="settings-field__description settings-completion-path">{t(language, 'settings.completion.hotReplace')}<br /><code>{info.path}</code></div>}
    {error && <div className="settings-error" role="alert">{error}</div>}
  </div>;
}
