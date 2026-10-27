import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useId,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';
import { createPortal } from 'react-dom';
import { withBuiltinRegions } from './builtins';
import { useSettingsStore } from '../state/settingsStore';
import { createPluginScope, errorText, UiPluginRuntime, type UiPluginEntry } from './runtime';
import { decodePluginSources, watchUiPlugins } from './source';
import type {
  UiPluginInput,
  UiPluginModule,
  UiPluginSlot,
  UiPluginView,
  UiPluginFile,
  UiViewActions,
} from './types';
import { queryModelUsage, startModelAuth, getModelAuth, cancelModelAuth, logoutModelConnection, getModelQuota } from '../services/apiClient';
import type { ApiResponse } from '@achbit/protocol';
import './uiPlugins.css';
function result<T>(response: ApiResponse<T>): T {
  if (!response.ok || response.data === undefined) throw new Error(response.message ?? response.error ?? 'Empty response');
  return response.data;
}


function insertStyle(css: string): () => void {
  const style = document.createElement('style');
  style.dataset.achbitUiPlugin = '';
  style.textContent = css;
  document.head.append(style);
  return () => style.remove();
}

async function importUiModule(source: string): Promise<UiPluginModule> {
  const url = URL.createObjectURL(new Blob([source], { type: 'text/javascript' }));
  try {
    return (await import(/* @vite-ignore */ url)).default;
  } finally {
    URL.revokeObjectURL(url);
  }
}

interface RuntimeContext {
  runtime: UiPluginRuntime;
  connectionError: string | null;
  refresh(path?: string): void;
}
const Context = createContext<RuntimeContext | null>(null);
const EMPTY: readonly UiPluginEntry[] = [];
const emptySnapshot = () => EMPTY;
const noSubscription = () => () => {};

export function UiPluginsProvider({ children }: { children: React.ReactNode }) {
  const encoded = String(
    useSettingsStore((state) => state.effectiveSettings['workbench.uiPlugins']) ?? '[]',
  );
  const usageEnabled = useSettingsStore(state => state.effectiveSettings['gui.usageWidget.enabled']) !== false;
  const runtime = useMemo(() => new UiPluginRuntime(importUiModule, insertStyle), []);
  const [connectionError, setConnectionError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const latestFiles = useRef<UiPluginFile[]>([]);
  const refresh = useCallback(
    (path?: string) => {
      if (path)
        void runtime
          .replace(latestFiles.current, path)
          .catch((error) => setConnectionError(errorText(error)));
      else setRevision((value) => value + 1);
    },
    [runtime],
  );
  useEffect(() => {
    const controller = new AbortController();
    setConnectionError(null);
    try {
      const sources = decodePluginSources(encoded);
      void runtime.select([...sources, { path: 'builtin:regions', enabled: true }, { path: 'builtin:usage', enabled: usageEnabled }]).catch((error) => setConnectionError(errorText(error)));
      if (sources.length === 0) {
        latestFiles.current = withBuiltinRegions([], usageEnabled);
        void runtime.replace(latestFiles.current).catch((error) => setConnectionError(errorText(error)));
      } else {
        void watchUiPlugins(sources, controller.signal, (files) => {
          latestFiles.current = withBuiltinRegions(files, usageEnabled);
          void runtime.replace(latestFiles.current).catch((error: unknown) => {
            if (!controller.signal.aborted) setConnectionError(errorText(error));
          });
        }).catch((error: unknown) => {
          if (!controller.signal.aborted) setConnectionError(errorText(error));
        });
      }
    } catch (error) {
      setConnectionError(errorText(error));
      void runtime.dispose().catch((error) => setConnectionError(errorText(error)));
    }
    return () => controller.abort();
  }, [encoded, revision, runtime, usageEnabled]);
  useEffect(
    () => () => {
      void runtime.dispose().catch(console.error);
    },
    [runtime],
  );
  return (
    <Context.Provider
      value={useMemo(
        () => ({ runtime, connectionError, refresh }),
        [runtime, connectionError, refresh],
      )}
    >
      {children}
    </Context.Provider>
  );
}

export function useUiPlugins() {
  const context = useContext(Context);
  const entries = useSyncExternalStore(
    context?.runtime.subscribe ?? noSubscription,
    context?.runtime.getSnapshot ?? emptySnapshot,
    emptySnapshot,
  );
  return { entries, connectionError: context?.connectionError ?? null, refresh: context?.refresh };
}

/** Only this mount is replaced. The React owner retains the draft, scroll and conversation. */
export function UiPluginSlotView({
  slot,
  input,
  children,
  pluginPath,
  onConnectionChanged,
  regions,
  actions,
  debugActions,
}: {
  slot: Exclude<UiPluginSlot, 'theme'>;
  input: UiPluginInput;
  children: React.ReactNode;
  pluginPath?: string;
  onConnectionChanged?(): Promise<void>;
  regions?: Record<string, React.ReactNode>;
  actions?: UiViewActions;
  debugActions?: import('../debug/registry').DebugActionStates;
}) {
  const context = useContext(Context);
  const { entries } = useUiPlugins();
  const entry = entries.find(
    (candidate) => candidate.status !== 'disabled' && candidate.manifest?.slots.includes(slot)
      && (!pluginPath || candidate.path === pluginPath)
      && (slot !== 'tool.result' || (input.kind === 'tool.result' && candidate.manifest.toolId === input.toolId))
      && (slot !== 'settings.connection.detail' || !candidate.manifest.adapterId || (input.kind === 'settings.connection' && candidate.manifest.adapterId === input.connection.adapterId)),
  );
  const renderer = entry?.renderers.get(slot);
  const container = useRef<HTMLDivElement>(null);
  const mounted = useRef<UiPluginView | null>(null);
  const connectionChanged = useRef(onConnectionChanged); connectionChanged.current = onConnectionChanged;
  const latestInput = useRef(input);
  latestInput.current = input;
  const liveActions = useRef(actions); liveActions.current = actions;
  const liveDebugActions = useRef(debugActions); liveDebugActions.current = debugActions;
  const names = Object.keys(regions ?? {}).join('|');
  const regionHosts = useMemo(() => Object.fromEntries(context && typeof document !== 'undefined' && names ? names.split('|').map(name => {
    const host = document.createElement('div'); host.style.display = 'contents'; host.dataset.uiRegion = name;
    return [name, host];
  }) : []), [names]);
  const portals = Object.entries(regions ?? {}).flatMap(([name, child]) => regionHosts[name] ? [createPortal(child, regionHosts[name], name)] : []);
  const positions = useRef<Array<{ element: HTMLElement; top: number; left: number }>>([]);
  const retiredView = useRef<Promise<void>>(Promise.resolve());
  const debugId = useId();
  useLayoutEffect(() => {
    if (typeof __ACHBIT_DEBUG__ === 'undefined' || !__ACHBIT_DEBUG__) return;
    return window.__ACHBIT_DEBUG_UI__?.register(debugId, {
      slot, pluginId: entry?.manifest?.id ?? null,
      read: () => latestInput.current,
      actions: () => (liveActions.current ?? {}) as Record<string, (...args: never[]) => unknown>,
      actionStates: () => liveDebugActions.current ?? {},
    });
  }, [debugId, slot, entry?.manifest?.id]);

  useLayoutEffect(() => {
    const root = container.current;
    if (!root || !entry || !renderer || !context) return;
    const scope = createPluginScope(insertStyle, (error) => context.runtime.report(entry, error));
    const previousView = retiredView.current;
    let disposal: Promise<void> | undefined;
    const dispose = () => {
      scope.abort();
      if (!disposal) retiredView.current = disposal = previousView.then(() => scope.dispose());
      return disposal;
    };
    const detach = context.runtime.attachView(entry, dispose);
    const mount = async () => {
      // StrictMode and hot updates must finish the old view's effects before reusing its container.
      await previousView;
      if (scope.signal.aborted) return;
      try {
        const value = latestInput.current;
        const authFlows = new Set<string>();
        scope.onDispose(async () => { await Promise.all([...authFlows].map(async id => { result(await cancelModelAuth(id)); })); authFlows.clear(); });
        const requireFlow = (id: string) => { if (!authFlows.has(id)) throw new Error('Auth flow is outside this view scope.'); };
        const viewScope = {
          ...scope,
          ...((slot.startsWith('settings.') || slot === 'usage.widget') && entry.manifest?.capabilities?.includes('usage.read') ? {
            usage: { query: async (query: import('@achbit/protocol').UsageQuery, signal: AbortSignal) => result(await queryModelUsage(query, AbortSignal.any([scope.signal, signal]))) },
          } : {}),
          ...(slot === 'usage.widget' && entry.manifest?.capabilities?.includes('quota.read') ? {
            quota: { read: async (signal: AbortSignal) => {
              const current = latestInput.current;
              if (current.kind !== 'usage.widget' || !current.connection) throw new Error('No connection selected.');
              return result(await getModelQuota(current.connection.id, AbortSignal.any([scope.signal, signal])));
            } },
          } : {}),
          actions: Object.fromEntries(Object.keys(liveActions.current ?? {}).map(name => [name, (...args: unknown[]) => {
            if (scope.signal.aborted) throw new Error('View disposed.');
            const action = liveActions.current?.[name as keyof UiViewActions] as ((...args: unknown[]) => unknown) | undefined;
            if (!action) throw new Error('View action unavailable.');
            return action(...args);
          }])),
          regions: { mount: (name: string, target: HTMLElement) => {
            const host = regionHosts[name];
            if (!host || (target !== root && !root.contains(target))) throw new Error('Invalid UI region mount.');
            target.append(host);
          } },
          ...(slot === 'settings.connection.detail' && value.kind === 'settings.connection' && entry.manifest?.capabilities?.includes('connection.auth') ? {
            connection: {
              startLogin: async (method: 'browser' | 'deviceCode') => {
                if (scope.signal.aborted) throw new Error('View disposed.');
                const flow = result(await startModelAuth(value.connection.id, method));
                if (scope.signal.aborted) { result(await cancelModelAuth(flow.id)); throw new Error('View disposed.'); }
                authFlows.add(flow.id); return flow;
              },
              readLogin: async (id: string, signal: AbortSignal) => {
                requireFlow(id); const flow = result(await getModelAuth(id, AbortSignal.any([scope.signal, signal])));
                if (flow.status !== 'pending') { authFlows.delete(id); if (flow.status === 'complete') await connectionChanged.current?.(); }
                return flow;
              },
              cancelLogin: async (id: string) => { requireFlow(id); const flow = result(await cancelModelAuth(id)); authFlows.delete(id); return flow; },
              logout: async () => { if (scope.signal.aborted) throw new Error('View disposed.'); result(await logoutModelConnection(value.connection.id)); await connectionChanged.current?.(); },
              readQuota: async (signal: AbortSignal) => result(await getModelQuota(value.connection.id, AbortSignal.any([scope.signal, signal]))),
            },
          } : {}),
        };
        scope.onDispose(() => { Object.values(regionHosts).forEach(host => host.remove()); });
        const debugStartedAt = typeof __ACHBIT_DEBUG__ !== 'undefined' && __ACHBIT_DEBUG__ ? performance.now() : 0;
        let view: UiPluginView;
        try { view = renderer(root, value, viewScope); }
        catch (error) {
          if (typeof __ACHBIT_DEBUG__ !== 'undefined' && __ACHBIT_DEBUG__) window.__ACHBIT_DEBUG_UI__?.measure(debugId, 'plugin.mount', debugStartedAt, 'failed');
          throw error;
        }
        if (typeof __ACHBIT_DEBUG__ !== 'undefined' && __ACHBIT_DEBUG__) window.__ACHBIT_DEBUG_UI__?.measure(debugId, 'plugin.mount', debugStartedAt, 'completed');
        if (!view || typeof view.update !== 'function' || typeof view.dispose !== 'function')
          throw new Error('UI renderer must return update and dispose functions.');
        mounted.current = view;
        scope.onDispose(() => view.dispose());
        for (const position of positions.current) {
          position.element.scrollTop = position.top;
          position.element.scrollLeft = position.left;
        }
        positions.current = [];
      } catch (error) {
        void dispose().catch(console.error).finally(detach);
        root.replaceChildren();
        context.runtime.report(entry, error);
      }
    };
    void mount().catch(error => context.runtime.report(entry, error));
    return () => {
      positions.current = [];
      for (let element = root.parentElement; element; element = element.parentElement) {
        if (
          element.scrollHeight > element.clientHeight ||
          element.scrollWidth > element.clientWidth
        )
          positions.current.push({ element, top: element.scrollTop, left: element.scrollLeft });
      }
      mounted.current = null;
      void dispose()
        .catch((error) => context.runtime.report(entry, error))
        .finally(detach);
      root.replaceChildren();
    };
  }, [entry?.generation, renderer, context?.runtime, regionHosts]);

  useLayoutEffect(() => {
    if (!mounted.current || !entry || !context) return;
    const debugStartedAt = typeof __ACHBIT_DEBUG__ !== 'undefined' && __ACHBIT_DEBUG__ ? performance.now() : 0;
    try {
      mounted.current.update(input);
      if (typeof __ACHBIT_DEBUG__ !== 'undefined' && __ACHBIT_DEBUG__) window.__ACHBIT_DEBUG_UI__?.measure(debugId, 'plugin.update', debugStartedAt, 'completed');
    } catch (error) {
      if (typeof __ACHBIT_DEBUG__ !== 'undefined' && __ACHBIT_DEBUG__) window.__ACHBIT_DEBUG_UI__?.measure(debugId, 'plugin.update', debugStartedAt, 'failed');
      context.runtime.report(entry, error);
    }
  }, [input, entry, context?.runtime]);

  if (!entry) return <>{children}{Object.values(regions ?? {})}</>;
  if (entry.status === 'error')
    return (
      <><div role="alert" className="ui-plugin-error">
        <strong>{entry.manifest?.name}</strong>
        <pre>{entry.error}</pre>
      </div>{portals}</>
    );
  if (entry.status === 'loading')
    return (
      <><div className="ui-plugin-loading" role="status">
        {input.locale === 'zh-CN' ? '正在更新展示插件…' : 'Updating display plugin…'}
      </div>{portals}</>
    );
  return (
    <><div
      className="ui-plugin-view"
      data-ui-plugin={entry.manifest?.id}
      data-ui-generation={entry.generation}
      ref={container}
    />{portals}</>
  );
}

function observeDisplayTheme(listener: () => void) {
  const observer = new MutationObserver(listener);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
  return () => observer.disconnect();
}
function displayTheme() {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

/** Consume the shell's resolved appearance, including changes while following the system. */
export function useDisplayTheme(): string {
  return useSyncExternalStore(observeDisplayTheme, displayTheme, () => 'light');
}

/** Settings contributions compose in installation order instead of replacing built-in controls. */
export function UiSettingsContributions({ slot, input, onConnectionChanged }: {
  slot: Extract<UiPluginSlot, `settings.${string}`>;
  input: Extract<UiPluginInput, { kind: `settings.${string}` }>;
  onConnectionChanged?(): Promise<void>;
}) {
  const { entries } = useUiPlugins();
  return <>{entries.filter(entry => entry.status !== 'disabled' && entry.manifest?.slots.includes(slot)
    && (slot !== 'settings.connection.detail' || !entry.manifest?.adapterId || (input.kind === 'settings.connection' && entry.manifest.adapterId === input.connection.adapterId)))
    .map(entry => <section key={entry.path} className="ui-settings-contribution"><UiPluginSlotView slot={slot} input={input} pluginPath={entry.path} onConnectionChanged={onConnectionChanged}>{null}</UiPluginSlotView></section>)}</>;
}
