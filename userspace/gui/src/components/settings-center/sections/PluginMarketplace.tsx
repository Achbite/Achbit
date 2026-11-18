import { useEffect, useState, type ReactNode } from 'react';
import { t, type UiLanguage } from '../../../i18n';
import { Button, DisclosureSummary, IconButton, UiIcon } from '../../../ui-components';
import { fetchPluginMarketplace, PLUGIN_MARKETPLACE_REPOSITORY_URL, type PluginMarketplaceEntry } from '../../../services/pluginMarketplace';
import { openExternalUrl } from '../../../services/runtimeAdapter';
import { matchesSettingsQuery } from '../settingsSearch';

type CatalogState =
  | { phase: 'loading' }
  | { phase: 'ready'; entries: PluginMarketplaceEntry[] }
  | { phase: 'failed'; message: string };

export default function PluginMarketplace({ language }: { language: UiLanguage }) {
  const [catalog, setCatalog] = useState<CatalogState>({ phase: 'loading' });
  const [revision, setRevision] = useState(0);
  const [query, setQuery] = useState('');
  const [verified, setVerified] = useState(false);
  const [linkError, setLinkError] = useState('');
  const label = (key: string, vars?: Record<string, string>) => t(language, 'settings.plugins.market.' + key, vars);

  useEffect(() => {
    const controller = new AbortController();
    setCatalog({ phase: 'loading' });
    void fetchPluginMarketplace(controller.signal).then(entries => {
      if (!controller.signal.aborted) setCatalog({ phase: 'ready', entries });
    }).catch((reason: unknown) => {
      if (!controller.signal.aborted) setCatalog({ phase: 'failed', message: String(reason) });
    });
    return () => controller.abort();
  }, [revision]);

  const link = (url: string, text: ReactNode) => (
    <a className="plugin-market__link" href={url} target="_blank" rel="noreferrer" onClick={event => {
      event.preventDefault();
      setLinkError('');
      void openExternalUrl(url).catch(reason => setLinkError(String(reason)));
    }}>{text}</a>
  );
  const shown = catalog.phase === 'ready' ? catalog.entries.filter(entry =>
    (!verified || entry.verification) && matchesSettingsQuery(query, entry.name, entry.id, entry.description, entry.author, entry.kind, label(entry.kind))
  ) : [];
  const refresh = () => setRevision(value => value + 1);
  return <section aria-label={label('discover')}>
    <div className="plugin-market__tools">
      <label className="plugin-market__search"><UiIcon name="search" size={15} />
        <input type="search" aria-label={label('search')} placeholder={label('search')} value={query} onChange={event => setQuery(event.target.value)} />
      </label>
      <label className="plugin-market__verified"><input type="checkbox" checked={verified} onChange={event => setVerified(event.target.checked)} />{label('verifiedOnly')}</label>
      <IconButton icon="refresh" size="compact" aria-label={t(language, 'settings.plugins.refresh')} onClick={refresh} />
      {link(PLUGIN_MARKETPLACE_REPOSITORY_URL, label('contribute'))}
    </div>
    {linkError && <p role="alert" className="settings-error">{linkError}</p>}
    {catalog.phase === 'loading' && <p role="status">{label('loading')}</p>}
    {catalog.phase === 'failed' && <div>
      <p role="alert" className="settings-error">{label('failed', { error: catalog.message })}</p>
      <Button onClick={refresh}>{label('retry')}</Button>
    </div>}
    {catalog.phase === 'ready' && !shown.length &&
      <p role="status" className="settings-plugin-empty">{label(catalog.entries.length ? 'noMatch' : 'empty')}</p>}
    {shown.map(entry => <details className="plugin-manager__item" key={entry.id}>
      <DisclosureSummary className="plugin-market__summary">
        <span className="plugin-market__identity"><strong>{entry.name}</strong><small>{entry.author} · {label(entry.kind)} · {entry.version}</small></span>
        {entry.verification && <span className="plugin-market__verification">{entry.verification.kind === 'publisher' ? label('publisher')
          : label('installation', { platform: entry.verification.platform!, version: entry.version })}</span>}
      </DisclosureSummary>
      <div className="plugin-market__detail">
        <p>{entry.description}</p>
        <dl>
          <dt>{label('source')}</dt><dd>{link(entry.sourceUrl, <code>{entry.sourceCommit}</code>)}</dd>
          <dt>{label('license')}</dt><dd>{link(entry.licenseUrl, entry.licenseName)} · {label(entry.licenseKind)}</dd>
          {entry.verification?.evidenceUrl && <><dt>{label('evidence')}</dt><dd>{link(entry.verification.evidenceUrl, label('evidence'))}</dd></>}
        </dl>
        {link(entry.downloadUrl, label('download'))}
        <p className="plugin-market__facts">{label('next')}</p>
      </div>
    </details>)}
  </section>;
}
