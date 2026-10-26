import { watchServicePlugins, type ServicePluginStatus } from '../../../services/servicePlugins';
import { openExternalUrl } from '../../../services/runtimeAdapter';
import ToggleSwitch from '../../shared/ToggleSwitch';
import { localizePlugin } from '../../../pluginLocalization';
import { useUiLanguage } from '../../../useUiLanguage';
import { useSettingsSearchEntries } from '../settingsSearch';
import { useInterfaceReloadGuard } from '../../../services/interfaceReload';
import ModalDialog from '../../shared/ModalDialog';
import { useEffect, useMemo, useRef, useState } from 'react';
import type { PluginCatalogItem } from '@achbit/protocol';
import { normalizeUiLanguage, t, activeT } from '../../../i18n';
import { getPluginCatalog } from '../../../services/localAgentApi';
import { useLocalAgentStore } from '../../../state/localAgentStore';
import { useSettingsStore } from '../../../state/settingsStore';
import { useUiPlugins } from '../../../ui-plugins/UiPlugins';
import { inspectLocalPlugin, type LocalPluginInspection } from '../../../ui-plugins/source';
import { UiPluginShowcase } from '../../../ui-plugins/UiPluginShowcase';
import { errorText } from '../../../ui-plugins/runtime';
import AchbitShellIcon from '../../shared/AchbitShellIcon';
import ProjectFolderDialog from '../../workspace-open-dialog/ProjectFolderDialog';
import { captureFocusReturn, returnInteractionFocus, useInteractionFocus, type FocusReturn } from '../../shared/interactionFocus';

type Source = {
  id?: string;
  path?: string;
  name?: string;
  description?: string;
  command?: string;
  args?: string;
  enabled?: boolean;
  transport?: string;
};
type Item = {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  key: string;
  sourceId: string;
  path?: string;
  error?: string;
  status: string;
  kind: 'ui' | 'tool' | 'guidance' | 'service';
  service?: ServicePluginStatus;
  source?: Source;
};
function sourceList(value: unknown): Source[] {
  const decoded: unknown = JSON.parse(String(value ?? '[]'));
  if (!Array.isArray(decoded) || decoded.some((item) => !item || typeof item !== 'object'))
    throw new Error(activeT('settings.plugins.invalidSources'));
  return decoded;
}
const filename = (path: string) => path.split(/[\\/]/u).filter(Boolean).at(-1) ?? path;

/** Inventory reads the existing settings owners and live display registry; saving does not invent runtime state. */
export default function PluginsSection() {
  const settings = useSettingsStore((state) => state.effectiveSettings);
  const patch = useSettingsStore((state) => state.patchUserSetting);
  const language = normalizeUiLanguage(settings['workbench.language']),
    chinese = language === 'zh-CN';
  const ui = useUiPlugins();
  const [services, setServices] = useState<ServicePluginStatus[]>([]);
  const [serviceError, setServiceError] = useState<string | null>(null);
  const [catalog, setCatalog] = useState<PluginCatalogItem[]>([]);
  const [metadata, setMetadata] = useState<Record<string, LocalPluginInspection>>({});
  const [metadataErrors, setMetadataErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null),
    [itemErrors, setItemErrors] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false),
    [revision, setRevision] = useState(0),
    [search, setSearch] = useState('');
  const [filter, setFilter] = useState<'all' | 'enabled'>('all');
  const [expanded, setExpanded] = useState<string | null>(null),
    [choosing, setChoosing] = useState(false);
  const [candidate, setCandidate] = useState<LocalPluginInspection | null>(null);
  const addButton = useRef<HTMLButtonElement>(null);
  const readButton = useRef<HTMLButtonElement>(null);
  const interaction = useInteractionFocus();
  const inspectionTrigger = useRef<FocusReturn | null>(null);
  useEffect(() => {
    if (!candidate && !busy && inspectionTrigger.current) {
      if (interaction) interaction.restore(inspectionTrigger.current);
      else returnInteractionFocus(inspectionTrigger.current, true);
      inspectionTrigger.current = null;
    }
  }, [candidate, busy]);
  const [manualPath, setManualPath] = useState('');
  const [connection, setConnection] = useState<Source | null>(null);
  const config = useMemo(() => {
    try {
      return { ui: sourceList(settings['workbench.uiPlugins']), error: null };
    } catch (reason) {
      return { ui: [], error: errorText(reason) };
    }
  }, [settings['workbench.uiPlugins']]);
  useEffect(() => {
    const controller = new AbortController();
    setError(null);
    void getPluginCatalog(controller.signal)
      .then((value) => setCatalog(value.plugins))
      .catch((reason) => {
        if (!controller.signal.aborted) setError(errorText(reason));
      });
    return () => controller.abort();
  }, [
    settings['skills.mounts'],
    settings['mcp.servers'],
    settings['plugins.sources'],
    settings['plugins.disabled'],
    revision,
  ]);
  useEffect(() => {
    const controller = new AbortController();
    void watchServicePlugins(controller.signal, (value) => {
      setServices(value);
      setServiceError(null);
    }).catch((reason) => {
      if (!controller.signal.aborted) setServiceError(errorText(reason));
    });
    return () => controller.abort();
  }, [settings['plugins.services'], revision]);
  useEffect(() => {
    const controller = new AbortController();
    for (const source of config.ui) {
      if (!source.path) continue;
      const path = source.path;
      void inspectLocalPlugin(path, controller.signal)
        .then((value) => {
          if (!controller.signal.aborted) {
            setMetadata((old) => ({ ...old, [path]: value }));
            setMetadataErrors((old) => {
              const next = { ...old };
              delete next[path];
              return next;
            });
          }
        })
        .catch((reason) => {
          if (!controller.signal.aborted)
            setMetadataErrors((old) => ({ ...old, [path]: errorText(reason) }));
        });
    }
    return () => controller.abort();
  }, [config, revision]);
  const items: Item[] = catalog
    .filter((plugin) => plugin.management)
    .map((plugin) => localizePlugin(plugin, language))
    .map((plugin) => {
      const owner = plugin.management!;
      let source: Source | undefined;
      try {
        if (owner.key !== 'plugins.disabled')
          source = sourceList(settings[owner.key]).find((item) => item.id === owner.id);
      } catch {
        /* The directory reports malformed settings. */
      }
      return {
        id: plugin.uri,
        name: plugin.displayName,
        description: plugin.shortDescription,
        enabled: plugin.enabled,
        key: owner.key,
        sourceId: owner.id,
        path: owner.path,
        error: plugin.error ? `${plugin.error.code}: ${plugin.error.message}` : undefined,
        status: plugin.enabled ? (plugin.available ? t(language, 'settings.plugins.chooseReady') : t(language, 'settings.plugins.unavailable')) : t(language, 'settings.plugins.disabled'),
        kind: plugin.contributionKind === 'skill' ? 'guidance' : 'tool',
        source,
      };
    });
  for (const source of config.ui) {
    const path = source.path ?? '',
      entry = ui.entries.find((item) => item.path === path),
      info = metadata[path];
    items.push({
      id: 'ui:' + path,
      name: entry?.manifest?.name ?? info?.name ?? filename(path),
      description:
        entry?.manifest?.description ?? info?.description ?? t(language, 'settings.plugins.description'),
      enabled: source.enabled === true,
      key: 'workbench.uiPlugins',
      sourceId: path,
      path,
      error: entry?.error ?? metadataErrors[path],
      status:
        entry?.status === 'error'
          ? t(language, 'settings.plugins.failed')
          : !source.enabled
            ? t(language, 'settings.plugins.disabled')
            : entry?.status === 'active'
              ? t(language, 'settings.plugins.loaded')
              : entry?.status === 'loading'
                ? t(language, 'settings.plugins.updating')
                : t(language, 'settings.plugins.waiting'),
      kind: 'ui',
      source,
    });
  }
  for (const service of services) {
    items.push({
      id: `service:${service.id}`, name: service.name, description: service.description,
      enabled: service.enabled, key: 'plugins.services', sourceId: service.id, path: service.path,
      error: service.error ?? undefined, kind: 'service', service,
      status: service.status === 'running' ? (chinese ? '运行中' : 'Running')
        : service.status === 'failed' ? t(language, 'settings.plugins.failed')
        : service.enabled ? (chinese ? '已停止' : 'Stopped') : t(language, 'settings.plugins.disabled'),
    });
  }
  useSettingsSearchEntries('plugins', items.map((item) => ({ id: `plugin-${item.id}`, title: item.name, keywords: item.description, category: 'plugins' })));
  const shown = items.filter(
    (item) =>
      (filter === 'all' || item.enabled) &&
      `${item.name} ${item.description}`
        .toLowerCase()
        .includes(search.trim().toLowerCase()),
  );
  const save = async (item: Item, enabled: boolean, remove = false, replacement?: Source) => {
    setBusy(true);
    setItemErrors((old) => {
      const next = { ...old };
      delete next[item.id];
      return next;
    });
    try {
      const current = useSettingsStore.getState().effectiveSettings[item.key];
      let value: unknown;
      if (item.key === 'plugins.disabled') {
        const disabled: unknown = JSON.parse(String(current ?? '[]'));
        if (!Array.isArray(disabled) || !disabled.every((value) => typeof value === 'string'))
          throw new Error(t(language, 'settings.plugins.invalidDisabled'));
        value = enabled
          ? disabled.filter((id) => id !== item.sourceId)
          : [...new Set([...disabled, item.sourceId])];
      } else {
        const list = sourceList(current),
          matches = (source: Source) =>
            item.kind === 'ui' ? source.path === item.path : source.id === item.sourceId;
        value = remove
          ? list.filter((source) => !matches(source))
          : list.map((source) =>
              matches(source) ? { ...(replacement ?? source), enabled } : source,
            );
      }
      if (!(await patch(item.key, JSON.stringify(value))))
        throw new Error(useSettingsStore.getState().errorMessage ?? t(language, 'settings.plugins.notSaved'));
      if (remove) setExpanded(null);
      setRevision((value) => value + 1);
      void useLocalAgentStore.getState().refreshPluginCatalog();
    } catch (reason) {
      setItemErrors((old) => ({ ...old, [item.id]: errorText(reason) }));
    } finally {
      setBusy(false);
    }
  };
  const inspect = async (path: string) => {
    const trigger = choosing ? addButton.current : readButton.current;
    inspectionTrigger.current = interaction ? interaction.capture(trigger) : captureFocusReturn(trigger);
    setChoosing(false);
    setBusy(true);
    setError(null);
    try {
      setCandidate(await inspectLocalPlugin(path));
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };
  const add = async () => {
    if (!candidate) return;
    setBusy(true);
    setError(null);
    try {
      const key =
        candidate.kind === 'ui'
          ? 'workbench.uiPlugins'
          : candidate.kind === 'service'
            ? 'plugins.services'
            : candidate.kind === 'cli'
            ? 'plugins.sources'
            : 'skills.mounts';
      const list = sourceList(useSettingsStore.getState().effectiveSettings[key]);
      if (
        list.some(
          (source) =>
            source.path === candidate.path ||
            (['cli', 'service'].includes(candidate.kind) && source.id === candidate.id),
        )
      )
        throw new Error(t(language, 'settings.plugins.duplicate'));
      const source =
        candidate.kind === 'ui'
          ? { path: candidate.path, enabled: true }
          : {
              id: ['cli', 'service'].includes(candidate.kind) ? candidate.id : crypto.randomUUID(),
              path: candidate.path,
              enabled: true,
            };
      if (!(await patch(key, JSON.stringify([...list, source]))))
        throw new Error(useSettingsStore.getState().errorMessage ?? t(language, 'settings.plugins.notSaved'));
      setCandidate(null);
      setManualPath('');
      setRevision((value) => value + 1);
      void useLocalAgentStore.getState().refreshPluginCatalog();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };
  const addConnection = async (source: Source) => {
    setBusy(true);
    setError(null);
    try {
      const list = sourceList(useSettingsStore.getState().effectiveSettings['mcp.servers']);
      const entry = { ...source, id: crypto.randomUUID(), transport: 'stdio', enabled: true };
      if (!(await patch('mcp.servers', JSON.stringify([...list, entry]))))
        throw new Error(useSettingsStore.getState().errorMessage ?? t(language, 'settings.plugins.notSaved'));
      setConnection(null);
      setRevision((value) => value + 1);
      void useLocalAgentStore.getState().refreshPluginCatalog();
    } catch (reason) {
      setError(errorText(reason));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="plugin-manager">
      <header className="plugin-manager__heading">
        <div>
          <h2 className="settings-title">{chinese ? '插件' : 'Plugins'}</h2>
        </div>
        <button
          className="settings-button plugin-manager__add"
          ref={addButton}
          disabled={busy}
          onClick={() => setChoosing(true)}
        >
          <AchbitShellIcon name="plus" />
          {chinese ? '添加…' : 'Add…'}
        </button>
      </header>
      <div className="plugin-manager__filters">
        <div role="group" aria-label={t(language, 'settings.plugins.filter')}>
          {(['all', 'enabled'] as const).map((key) => (
            <button
              key={key}

              aria-pressed={filter === key}
              onClick={() => setFilter(key)}
            >
              {key === 'all' ? (chinese ? '全部' : 'All') : chinese ? '已启用' : 'Enabled'}{' '}
              <small>
                {key === 'all' ? items.length : items.filter((item) => item.enabled).length}
              </small>
            </button>
          ))}
        </div>
        <label>
          <AchbitShellIcon name="search" />
          <input
            placeholder={chinese ? '搜索插件' : 'Search plugins'}
            aria-label={chinese ? '搜索插件' : 'Search plugins'}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <button
          className="reader-icon-button"
          title={t(language, 'settings.plugins.refresh')}
          aria-label={t(language, 'settings.plugins.refresh')}
          onClick={() => {
            setRevision((value) => value + 1);
            ui.refresh?.();
          }}
        >
          <AchbitShellIcon name="refresh" />
        </button>
      </div>
      {(error || config.error || ui.connectionError) && (
        <p role="alert" className="settings-error">
          {error ?? config.error ?? ui.connectionError}
        </p>
      )}
      <div className="plugin-manager__list">
        {shown.map((item) => (
          <section id={`setting-plugin-${item.id}`} tabIndex={-1} className="plugin-manager__item" key={item.id}>
            <div className="plugin-manager__row">
              <span className="plugin-manager__icon">
                <AchbitShellIcon
                  name={
                    item.kind === 'ui'
                      ? 'extension'
                      : item.kind === 'guidance'
                        ? 'artifact'
                        : 'tool'
                  }
                />
              </span>
              <button
                className="plugin-manager__summary"
                aria-expanded={expanded === item.id}
                onClick={() => setExpanded(expanded === item.id ? null : item.id)}
              >
                <strong>{item.name}</strong>
                <span>{item.description}</span>
              </button>
              <span
                className={
                  'plugin-manager__status' +
                  (item.error
                    ? ' plugin-manager__status--error'
                    : item.enabled
                      ? ' plugin-manager__status--enabled'
                      : '')
                }
                title={item.error ?? item.status}
                aria-label={item.error ? t(language, 'settings.plugins.failed') : item.status}
              />
              <ToggleSwitch
                  aria-label={`${chinese ? '启用' : 'Enable'} ${item.name}`}
                  checked={item.enabled}
                  disabled={busy}
                  onChange={(event) => void save(item, event.target.checked)}
              />
              <button
                className="reader-icon-button"
                aria-label={t(language, 'settings.plugins.details', { name: item.name })}
                aria-expanded={expanded === item.id}
                onClick={() => setExpanded(expanded === item.id ? null : item.id)}
              >
                <AchbitShellIcon name={expanded === item.id ? 'chevronDown' : 'chevronRight'} />
              </button>
            </div>
            {(item.error || itemErrors[item.id]) && (
              <p role="alert" className="settings-error">
                {itemErrors[item.id] ?? item.error}
              </p>
            )}
            {expanded === item.id && (
              <div className="plugin-manager__detail">
                <dl>
                  <dt>{t(language, 'settings.plugins.status')}</dt>
                  <dd>{item.status}</dd>
                  <dt>{t(language, 'settings.plugins.update')}</dt>
                  <dd>
                    {item.kind === 'ui'
                      ? t(language, 'settings.plugins.uiUpdate')
                      : item.kind === 'service' ? (chinese ? '停用后重新启用以加载更新。' : 'Disable and enable to load updates.')
                      : t(language, 'settings.plugins.toolUpdate')}
                  </dd>
                </dl>
                {item.service && (
                  <div>
                    {item.service.baseUrl && <p>{chinese ? '服务地址：' : 'Service URL: '}<code>{item.service.baseUrl}</code></p>}
                    {item.service.pageUrl && <button className="settings-button" onClick={() => void openExternalUrl(item.service!.pageUrl!).catch(reason => setItemErrors(old => ({ ...old, [item.id]: errorText(reason) })))}>{chinese ? '打开插件页面' : 'Open plugin page'}</button>}
                    {item.service.baseUrl && <button className="settings-button" onClick={() => void navigator.clipboard.writeText(item.service!.baseUrl!).catch(reason => setItemErrors(old => ({ ...old, [item.id]: errorText(reason) })))}>{chinese ? '复制服务地址' : 'Copy service URL'}</button>}
                    <details><summary>{chinese ? '插件数据位置' : 'Plugin data location'}</summary><code>{item.service.stateDirectory}</code></details>
                  </div>
                )}
                {item.path && (
                  <details>
                    <summary>{t(language, 'settings.plugins.location')}</summary>
                    <div className="plugin-manager__location">
                      <code>{item.path}</code>
                      <button
                        className="settings-button"
                        onClick={() =>
                          void navigator.clipboard
                            .writeText(item.path!)
                            .catch((reason) =>
                              setItemErrors((old) => ({ ...old, [item.id]: errorText(reason) })),
                            )
                        }
                      >
                        {t(language, 'settings.plugins.copy')}
                      </button>
                    </div>
                  </details>
                )}
                {item.key === 'mcp.servers' && item.source && (
                  <PluginConnectionForm
                    source={item.source}
                    busy={busy}
                    save={(source) => void save(item, item.enabled, false, source)}
                  />
                )}
                <div className="settings-actions">
                  {item.kind === 'ui' && (
                    <button
                      className="settings-button"
                      disabled={busy || !item.enabled}
                      onClick={() => ui.refresh?.(item.path)}
                    >
                      {t(language, 'settings.plugins.reload')}
                    </button>
                  )}
                  {item.key !== 'plugins.disabled' && (
                    <button
                      className="settings-button settings-button--quiet"
                      disabled={busy}
                      onClick={() => void save(item, false, true)}
                    >
                      {t(language, 'settings.plugins.remove')}
                    </button>
                  )}
                </div>
                {item.kind === 'ui' && item.enabled && (
                  <details>
                    <summary>{t(language, 'settings.plugins.showcase')}</summary>
                    <UiPluginShowcase language={language} />
                  </details>
                )}
              </div>
            )}
          </section>
        ))}
      </div>
      {serviceError && <p role="alert" className="settings-error">{serviceError}</p>}
      {!shown.length && !error && (
        <p className="settings-plugin-empty">
          {chinese ? '暂无匹配的插件。' : 'No matching plugins.'}
        </p>
      )}
      <details className="plugin-manager__manual">
        <summary>{chinese ? '手动指定位置' : 'Enter a location'}</summary>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void inspect(manualPath.trim());
          }}
        >
          <input
            aria-label={t(language, 'settings.plugins.locationLabel')}
            value={manualPath}
            onChange={(event) => setManualPath(event.target.value)}
          />
          <button ref={readButton} className="settings-button" disabled={busy || !manualPath.trim()}>
            {t(language, 'settings.plugins.read')}
          </button>
        </form>
      </details>
      <details className="plugin-manager__manual">
        <summary>{chinese ? '连接外部工具' : 'Connect external tools'}</summary>
        {connection ? (
          <>
            <PluginConnectionForm
              source={connection}
              busy={busy}
              save={(source) => void addConnection(source)}
              adding
            />
            <button className="settings-button" disabled={busy} onClick={() => setConnection(null)}>
              {t(language, 'settings.plugins.cancel')}
            </button>
          </>
        ) : (
          <button
            className="settings-button"
            disabled={busy}
            onClick={() => setConnection({ name: '', description: '', command: '', args: '' })}
          >
            {t(language, 'settings.plugins.addConnection')}
          </button>
        )}
      </details>
      {candidate && (
        <ModalDialog className="plugin-import-overlay" busy={busy} onClose={() => setCandidate(null)} aria-label={chinese ? '添加插件' : 'Add plugin'}>
          <section className="plugin-import">
            <h3>{t(language, 'settings.plugins.add')}</h3>
            <strong>{candidate.name}</strong>
            <p>{candidate.description}</p>
            <details>
              <summary>{t(language, 'settings.plugins.location')}</summary>
              <code>{candidate.path}</code>
            </details>
            {error && (
              <p role="alert" className="settings-error">
                {error}
              </p>
            )}
            <div className="settings-actions">
              <button
                className="settings-button"
                disabled={busy}
                onClick={() => setCandidate(null)}
              >
                {t(language, 'settings.plugins.cancel')}
              </button>
              <button
                className="settings-button settings-button--primary"
                disabled={busy}
                onClick={() => void add()}
              >
                {t(language, 'settings.plugins.addEnable')}
              </button>
            </div>
          </section>
        </ModalDialog>
      )}
      {choosing && (
        <ProjectFolderDialog
          language={language}
          selectionMode="path"
          title={chinese ? '选择插件文件或文件夹' : 'Choose plugin file or folder'}
          onCancel={() => setChoosing(false)}
          onSelect={(path) => void inspect(path)}
        />
      )}
    </div>
  );
}
function PluginConnectionForm({
  source,
  busy,
  save,
  adding = false,
}: {
  source: Source;
  busy: boolean;
  save(source: Source): void;
  adding?: boolean;
}) {
  const language = useUiLanguage();
  const [draft, setDraft] = useState(source);
  useInterfaceReloadGuard(JSON.stringify(draft) !== JSON.stringify(source), draft.name?.trim() || t(language, 'settings.plugins.addConnection'), busy);
  return (
    <form
      className="plugin-connection"
      onSubmit={(event) => {
        event.preventDefault();
        save(draft);
      }}
    >
      {(['name', 'command', 'args'] as const).map((key) => (
        <label key={key}>
          {key === 'name' ? t(language, 'settings.plugins.name') : key === 'command' ? t(language, 'settings.plugins.command') : t(language, 'settings.plugins.args')}
          <input
            required={key !== 'args'}
            value={draft[key] ?? ''}
            onChange={(event) => setDraft({ ...draft, [key]: event.target.value })}
          />
        </label>
      ))}
      <label>
        {t(language, 'settings.plugins.capabilities')}
        <textarea
          value={draft.description ?? ''}
          placeholder={t(language, 'settings.plugins.capabilitiesPlaceholder')}
          onChange={(event) => setDraft({ ...draft, description: event.target.value })}
        />
      </label>
      <button
        className="settings-button"
        disabled={
          busy ||
          !draft.name?.trim() ||
          !draft.command?.trim() ||
          (!adding && JSON.stringify(source) === JSON.stringify(draft))
        }
      >
        {adding ? t(language, 'settings.plugins.connect') : t(language, 'settings.plugins.save')}
      </button>
    </form>
  );
}
