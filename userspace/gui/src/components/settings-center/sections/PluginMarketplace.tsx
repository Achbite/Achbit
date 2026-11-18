import { useEffect, useRef, useState, type ReactNode } from 'react';
import { t, type UiLanguage } from '../../../i18n';
import { Button, DisclosureSummary, IconButton, UiIcon } from '../../../ui-components';
import {
  fetchInstalledMarketplacePlugins, fetchPluginMarketplace, installMarketplacePlugin,
  PLUGIN_MARKETPLACE_REPOSITORY_URL, type PluginMarketplaceEntry,
} from '../../../services/pluginMarketplace';
import { openExternalUrl } from '../../../services/runtimeAdapter';
import { matchesSettingsQuery } from '../settingsSearch';
import { useAutoDismiss } from '../../shared/useAutoDismiss';

type Kind = PluginMarketplaceEntry['kind'];
type Installed = Awaited<ReturnType<typeof fetchInstalledMarketplacePlugins>>[number];
type Operation = { phase: 'busy' } | { phase: 'error'; message: string };
type Catalog = { phase: 'loading' } | { phase: 'ready'; entries: PluginMarketplaceEntry[] } | { phase: 'failed'; message: string };
const kinds = ['all', 'ui', 'guidance', 'cli', 'service'] as const;
const icons = { ui: 'extension', guidance: 'artifact', cli: 'terminal', service: 'network' } as const;
const pageSize = 12;

interface Props {
  active: boolean;
  language: UiLanguage;
  onInstalled(): void;
  onManage(path: string): void;
}

export default function PluginMarketplace({ active, language, onInstalled, onManage }: Props) {
  const [catalog, setCatalog] = useState<Catalog>({ phase: 'loading' });
  const [installed, setInstalled] = useState<Installed[]>([]);
  const [inventoryError, setInventoryError] = useState('');
  const [inventoryLoading, setInventoryLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [inventoryRevision, setInventoryRevision] = useState(0);
  const [query, setQuery] = useState('');
  const [kind, setKind] = useState<Kind | 'all'>('all');
  const [verified, setVerified] = useState(false);
  const [page, setPage] = useState(1);
  const [linkError, setLinkError] = useState('');
  const [lastInstalled, setLastInstalled] = useState<string | null>(null);
  useAutoDismiss(lastInstalled, () => setLastInstalled(null));
  const [operations, setOperations] = useState<Record<string, Operation | undefined>>({});
  const pending = useRef(new Set<string>());
  const inventoryGeneration = useRef(0);
  const label = (key: string, vars?: Record<string, string>) => t(language, 'settings.plugins.market.' + key, vars);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    setCatalog({ phase: 'loading' });
    void fetchPluginMarketplace(controller.signal).then(entries => {
      if (!controller.signal.aborted) setCatalog({ phase: 'ready', entries });
    }).catch((error: unknown) => {
      if (!controller.signal.aborted) setCatalog({ phase: 'failed', message: String(error) });
    });
    return () => controller.abort();
  }, [active, revision]);

  useEffect(() => {
    if (!active) return;
    const controller = new AbortController();
    const change = inventoryGeneration.current;
    setInventoryError('');
    setInventoryLoading(true);
    void fetchInstalledMarketplacePlugins(controller.signal).then(items => {
      if (!controller.signal.aborted && change === inventoryGeneration.current) setInstalled(items);
    }).catch((error: unknown) => {
      if (!controller.signal.aborted && change === inventoryGeneration.current) setInventoryError(String(error));
    }).finally(() => { if (!controller.signal.aborted && change === inventoryGeneration.current) setInventoryLoading(false); });
    return () => controller.abort();
  }, [active, revision, inventoryRevision]);

  const install = async (entry: PluginMarketplaceEntry, key: string) => {
    if (pending.current.has(key)) return;
    pending.current.add(key);
    setOperations(current => ({ ...current, [key]: { phase: 'busy' } }));
    try {
      const { plugin, application } = await installMarketplacePlugin(entry);
      setInstalled(current => [...current.filter(item => item.kind !== plugin.kind || item.id !== plugin.id), plugin]);
      const failure = application.status === 'failed'
        ? { phase: 'error' as const, message: [label('activationFailed'), application.error].filter(Boolean).join(' ') } : undefined;
      setOperations(current => ({ ...current, [key]: failure }));
      setLastInstalled(failure ? null : key);
      onInstalled();
    } catch (error) {
      setOperations(current => ({ ...current, [key]: { phase: 'error', message: String(error) } }));
    } finally {
      pending.current.delete(key);
      inventoryGeneration.current++;
      setInventoryLoading(true);
      setInventoryRevision(value => value + 1);
    }
  };
  if (!active) return null;

  const link = (url: string, text: ReactNode, className = 'plugin-market__link', description?: string) => (
    <a className={className} href={url} title={description} aria-label={description} target="_blank" rel="noreferrer" onClick={event => {
      event.preventDefault();
      setLinkError('');
      void openExternalUrl(url).catch(error => setLinkError(String(error)));
    }}>{text}</a>
  );
  const entries = catalog.phase === 'ready' ? catalog.entries : [];
  const shown = entries.filter(entry =>
    (kind === 'all' || entry.kind === kind) && (!verified || entry.verification)
    && matchesSettingsQuery(query, entry.name, entry.id, entry.description, entry.descriptionZhCN ?? '', entry.author, label('category.' + entry.kind), label(entry.kind))
  );
  const pageCount = Math.ceil(shown.length / pageSize);
  const currentPage = Math.min(page, Math.max(1, pageCount));
  const refresh = () => setRevision(value => value + 1);

  return <section className="plugin-market" aria-label={label('discover')}>
    <div className="plugin-market__tools">
      <label className="plugin-market__search"><UiIcon name="search" size={16} />
        <input type="search" aria-label={label('search')} placeholder={label('search')} value={query} onChange={event => { setQuery(event.target.value); setPage(1); }} />
      </label>
      <label className="plugin-market__verified"><input type="checkbox" checked={verified} onChange={event => { setVerified(event.target.checked); setPage(1); }} />{label('verifiedOnly')}</label>
      <IconButton icon="refresh" size="compact" aria-label={t(language, 'settings.plugins.refresh')} onClick={refresh} />
      {link(PLUGIN_MARKETPLACE_REPOSITORY_URL + '/blob/main/' + (language === 'zh-CN' ? 'CONTRIBUTING.zh-CN.md' : 'CONTRIBUTING.md'), label('contribute'))}
    </div>
    <div className="plugin-market__categories" role="group" aria-label={label('categories')}>
      {kinds.map(value => <Button key={value} size="compact" aria-pressed={kind === value} onClick={() => { setKind(value); setPage(1); }}>{label('category.' + value)}</Button>)}
    </div>
    {linkError && <p role="alert" className="settings-error">{linkError}</p>}
    {inventoryError && <p role="alert" className="settings-error">{label('inventoryFailed', { error: inventoryError })}</p>}
    {catalog.phase === 'loading' && <p role="status">{label('loading')}</p>}
    {catalog.phase === 'failed' && <div>
      <p role="alert" className="settings-error">{label('failed', { error: catalog.message })}</p>
      <Button onClick={refresh}>{label('retry')}</Button>
    </div>}
    {catalog.phase === 'ready' && shown.length === 0 && <p role="status" className="settings-plugin-empty">{label(entries.length ? 'noMatch' : 'empty')}</p>}
    {shown.slice((currentPage - 1) * pageSize, currentPage * pageSize).map(entry => {
      const key = entry.kind + ':' + (entry.install?.manifestId ?? entry.id);
      const manifestId = entry.install?.manifestId;
      const local = manifestId && installed.find(item => item.kind === entry.kind && item.id === manifestId);
      const operation = operations[key];
      const busy = operation?.phase === 'busy';
      const download = link(entry.downloadUrl, label('download'));
      return <article key={entry.id} aria-label={entry.name} className="plugin-market__entry">
        <span className="plugin-market__icon" aria-hidden="true"><UiIcon name={icons[entry.kind]} size={19} /></span>
        <div className="plugin-market__copy">
          <h3>{entry.name}</h3>
          <p className="plugin-market__description">{language === 'zh-CN' ? entry.descriptionZhCN ?? entry.description : entry.description}</p>
          <div className="plugin-market__meta">{entry.author} · {label(entry.kind)} · {entry.version}</div>
        </div>
        <div className="plugin-market__action">
          {busy ? <Button variant="secondary" size="compact" disabled aria-busy="true">{label('installing')}</Button>
            : local ? <Button variant="secondary" size="compact" onClick={() => onManage(local.path)}>{label('manage')}</Button>
            : entry.install ? <Button variant="primary" size="compact" disabled={inventoryLoading} onClick={() => void install(entry, key)}>{label('install')}</Button>
            : link(entry.downloadUrl, label('downloadShort'), 'plugin-market__download')}
        </div>
        {lastInstalled === key && local && <p role="status" className="plugin-market__success">{label('installed')}</p>}
        {operation?.phase === 'error' && <p role="alert" className="plugin-market__error settings-error">{operation.message}</p>}
        <details className="plugin-market__details">
          <DisclosureSummary>{label('details')}</DisclosureSummary>
          <dl>
            <dt>{label('source')}</dt><dd>{link(entry.sourceUrl, <code>{entry.sourceCommit.slice(0, 12)}</code>, undefined, label('source') + ' ' + entry.sourceCommit)}</dd>
            <dt>{label('license')}</dt><dd>{link(entry.licenseUrl, entry.licenseName)} · {label(entry.licenseKind)}</dd>
            {entry.verification && <><dt>{label('verification')}</dt><dd>{entry.verification.kind === 'publisher' ? label('publisher')
              : label('installation', { platform: entry.verification.platform!, version: entry.version })}
              {entry.verification.evidenceUrl && <> · {link(entry.verification.evidenceUrl, label('evidence'))}</>}
            </dd></>}
            <dt>{label('package')}</dt><dd>{download}</dd>
          </dl>
        </details>
      </article>;
    })}
    {pageCount > 1 && <nav className="plugin-market__pages" aria-label={label('pages')}>
      <Button size="compact" variant="secondary" disabled={currentPage === 1} onClick={() => setPage(currentPage - 1)}>{label('previous')}</Button>
      <span aria-live="polite">{label('page', { current: String(currentPage), total: String(pageCount) })}</span>
      <Button size="compact" variant="secondary" disabled={currentPage === pageCount} onClick={() => setPage(currentPage + 1)}>{label('nextPage')}</Button>
    </nav>}
  </section>;
}
