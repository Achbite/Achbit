import { DisclosureSummary } from '../../ui-components';
import { requestInterfaceReload } from '../../services/interfaceReload';
import React, { useSyncExternalStore } from 'react';
import { t, activeT } from '../../i18n';
import { useUiLanguage } from '../../useUiLanguage';
import { interfaceUpdateSnapshot, subscribeInterfaceUpdates, reportInterfaceLoadError } from '../../services/interfaceUpdates';
import './interfaceUpdateNotice.css';

export function InterfaceUpdateNotice() {
  const language = useUiLanguage();
  const update = useSyncExternalStore(subscribeInterfaceUpdates, interfaceUpdateSnapshot);
  if (!update.available && !update.error) return null;
  return <aside className="interface-update-notice" role="status">
    <div><strong>{t(language, update.available ? 'interfaceUpdate.available' : 'interfaceUpdate.failed')}</strong>
      <span>{t(language, 'interfaceUpdate.saveFirst')}</span>
      {update.error && <details><DisclosureSummary>{t(language, 'interfaceUpdate.details')}</DisclosureSummary><pre>{update.error}</pre></details>}
    </div>
    <button type="button" onClick={() => requestInterfaceReload()}>{t(language, 'interfaceUpdate.reload')}</button>
  </aside>;
}

/** A failed lazy surface must leave the conversation and its draft mounted. */
export class InterfaceLoadBoundary extends React.Component<{ children: React.ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };
  static getDerivedStateFromError(error: Error) { return { error }; }
  componentDidCatch(error: Error) { reportInterfaceLoadError(error); }
  render() {
    if (!this.state.error) return this.props.children;
    return <section className="interface-load-error" role="alert">
      <h3>{activeT('interfaceUpdate.failed')}</h3><p>{activeT('interfaceUpdate.saveFirst')}</p>
      <pre>{this.state.error.message}</pre>
      <button type="button" onClick={() => requestInterfaceReload()}>{activeT('interfaceUpdate.reload')}</button>
    </section>;
  }
}
