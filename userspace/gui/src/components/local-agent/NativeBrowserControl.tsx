import { useEffect, useState } from 'react';
import { watchNativePages, type NativeHostBinding } from '../../services/nativeBrowser';
import { t, type UiLanguage } from '../../i18n';

/** Subscribe before reading the Host snapshot so mounting cannot miss an end event. */
export function NativeBrowserControl({ binding, previewId, language, onError }: {
  binding: NativeHostBinding; previewId: string; language: UiLanguage; onError(message: string): void;
}) {
  const [active, setActive] = useState(false);
  useEffect(() => {
    let ended = false;
    let unlisten: (() => void) | undefined;
    void watchNativePages(binding, pages => {
      if (!ended) setActive((pages.find(page => page.previewId === previewId)?.control?.activeRuns.length ?? 0) > 0);
    }).then(dispose => {
      if (ended) dispose(); else unlisten = dispose;
    }).catch(error => { if (!ended) onError(String(error)); });
    return () => { ended = true; unlisten?.(); };
  }, [binding.hostInstanceId, binding.windowLabel, binding.sessionId, previewId, onError]);
  return active ? <div className="native-browser-control" role="status" title={t(language, 'reader.controlActive')}>
    <span aria-hidden="true" /><span className="native-browser-control__label">{t(language, 'reader.controlActive')}</span>
  </div> : null;
}
