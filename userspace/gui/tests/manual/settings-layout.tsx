// Production settings with isolated desktop/HTTP fixtures; never updates a real installation.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { DEFAULT_USER_SETTINGS, type PluginCatalogItem } from '@achbit/protocol';
import { GuiSettingsSection } from '../../src/components/settings-center/sections/CategorizedSettingsSections';
import SettingsCenter from '../../src/components/settings-center/SettingsCenter';
import PluginsSection, { type PluginsView } from '../../src/components/settings-center/sections/PluginsSection';
import { useSettingsStore } from '../../src/state/settingsStore';
import { installProductUpdateMonitor, type ProductUpdateStatus } from '../../src/services/productUpdates';
import { installPaletteDefaults } from '../../src/theme/palette';
import { PLUGIN_MARKETPLACE_INDEX_URL } from '../../src/services/pluginMarketplace';
import type { UiLanguage } from '../../src/i18n';
import '../../src/achbit-gui/styles/achbitDesignTokens.css';
import '../../src/theme/paletteBase.css';
import '../../src/components/settings-center/settingsCenter.css';

installPaletteDefaults();
const handlers = new Map<string, (event: { payload: unknown }) => void>();
const calls: string[] = [];
const query = new URLSearchParams(location.search);
const largeMarket = query.has('largeMarket');
const fullSettings = query.has('fullSettings');
const sampleConnection = { id: 'fixture:local', name: 'Local reference connection', adapterId: 'custom', billingMode: 'metered', credentialKind: 'apiKey', authStatus: 'ready', baseUrl: 'https://example.invalid/v1' };
const modelTemplates = ['Reference Small', 'Reference Large'].map(name => ({ name, model: name.toLowerCase().replace(' ', '-'),
  kind: 'openaiCompatible', providerFlavor: 'openai', enabled: true, contextWindowTokens: 128000, maxOutputTokens: 8192 }));
const echoManifest = { id: 'Echo Demonstration', kind: 'guidance', path: '/fixture/installed/echo' };
const inventory = [{ id: echoManifest.id, kind: 'ui', path: '/fixture/other' }];
if (largeMarket) inventory.push({ id: 'quiet-theme', kind: 'ui', path: '/fixture/plugin' });
type InstallResult = 'success' | 'reject' | 'activation-failed';
const marketplace = {
  requests: 0, externalUrls: [] as string[], installations: [] as string[], commands: [] as unknown[],
  installElsewhere: () => inventory.push(echoManifest),
  holdNext: false, finish: undefined as ((result: InstallResult) => void) | undefined,
};
Object.assign(window, { marketplaceFixture: marketplace });
const repository = 'https://github.com/example/achbit-market-fixture';
const commit = 'a'.repeat(40);
const artifact = (id: string, kind: string, author: string, name: string) => ({
  id, kind, author, name, version: '1.0.0', description: 'Isolated marketplace example.', repositoryUrl: repository,
  sourceCommit: commit, sourceUrl: `${repository}/tree/${commit}`, licenseUrl: `${repository}/blob/${commit}/LICENSE`,
  downloadUrl: `${repository}/releases/download/1.0.0/${id}.zip`,
});
const more = largeMarket ? Array.from({ length: 13 }, (_, index) => ({
  ...artifact('extra-' + index, index === 0 ? 'service' : 'cli', 'Operations', 'Tool ' + (index + 1)), licenseName: 'MIT', licenseKind: 'open-source',
})) : [];
const marketplaceIndex = { schemaVersion: 1, plugins: [
  { ...artifact('echo', 'guidance', 'Anya', 'Echo Tools'), description: 'Return supplied text in a consistent format.', descriptionZhCN: '按原格式返回输入文本。', install: { sha256: 'b'.repeat(64), manifestId: echoManifest.id },
    licenseName: 'MIT', licenseKind: 'open-source',
    verification: { kind: 'installation', version: '1.0.0', platform: 'macos-arm64' } },
  { ...artifact('theme', 'ui', 'Lee', 'Quiet Theme'), description: 'A low-contrast color palette for the workbench.', descriptionZhCN: '为工作台提供柔和的配色。', install: { sha256: 'c'.repeat(64), manifestId: 'quiet-theme' },
    licenseName: 'Fixture Community License', licenseKind: 'source-available' },
  ...more,
] };
let status: ProductUpdateStatus = { phase: 'idle', currentVersion: 'preview', version: null, downloaded: 0, total: null, reason: null, error: null };
function publish(phase: string) {
  status = { ...status, phase, version: phase === 'waiting' ? '0.0.0-preview.with-a-long-version' : null,
    error: phase === 'error' ? `Update failed: /fixture/${'long-path/'.repeat(12)}download — original error retained` : null };
  handlers.get('achbit:product-update')?.({ payload: status });
}
const originalTauri = window.__TAURI__, originalFetch = window.fetch, originalPreview = window.__ACHBIT_BROWSER_PREVIEW__;
// Exercise desktop-only controls against our stub, even in Achbit's browser preview.
window.__ACHBIT_BROWSER_PREVIEW__ = false;
window.__TAURI__ = {
  core: { async invoke<T>(command: string, args?: Record<string, unknown>): Promise<T> {
    calls.push(command);
    if (command === 'achbit_open_external_url') marketplace.externalUrls.push(String(args?.url));
    if (command === 'achbit_update_status') return status as T;
    if (command === 'achbit_update_check') publish('current');
    if (command === 'achbit_completion_sound') return { path: '/fixture/completion.wav', custom: true } as T;
    if (command === 'achbit_set_completion_sound') return { path: '/fixture/default.wav', custom: false } as T;
    return undefined as T;
  } },
  event: { async listen<T>(name: string, listener: (event: { payload: T }) => void) {
    handlers.set(name, listener as (event: { payload: unknown }) => void);
    return () => { handlers.delete(name); };
  } },
};
window.fetch = async (input, init) => {
  const url = new URL(String(input), location.href);
  const path = url.pathname;
  if (url.href === PLUGIN_MARKETPLACE_INDEX_URL) {
    marketplace.requests++;
    return marketplace.requests === 1 ? new Response(null, { status: 503 }) : Response.json(marketplaceIndex);
  }
  if (path === '/api/llm/connections') return Response.json({ ok: true, data: { connections: [sampleConnection], adapters: [{ id: 'custom', name: 'Fixture', protocols: ['openaiCompatible'], billingModes: ['metered'], authMethods: ['apiKey'], models: modelTemplates, source: 'builtin' }] } });
  if (path === '/api/llm/profiles') return Response.json({ ok: true, data: { connections: [sampleConnection], profiles: [], defaultProfileId: null } });
  if (path === '/api/llm/usage') {
    const query = JSON.parse(String(init?.body));
    const totals = { calls: 2, reportedCalls: 2, pricedCalls: 0, estimatedCost: null, inputTokens: 240, outputTokens: 80, cacheReadInputTokens: 120, cacheMissInputTokens: 120 };
    return Response.json({ ok: true, data: { query, coverageFrom: query.from, totals, connections: [], models: [], buckets: [{ ...totals, start: query.from, end: query.to, label: '01' }] } });
  }
  if (path.endsWith('/host/plugins/install') || path.endsWith('/host/plugins/manage')) marketplace.installations.push(path);
  if (path.endsWith('/host/plugins')) return Response.json({ ok: true, data: { plugins: inventory } });
  if (path.endsWith('/host/plugins/install')) {
    marketplace.commands.push(JSON.parse(String(init?.body)));
    if (inventory.includes(echoManifest)) return Response.json({ ok: false, error: 'already_installed', message: 'Plugin already registered' });
    const outcome = marketplace.holdNext ? await new Promise<InstallResult>(resolve => { marketplace.finish = resolve; }) : 'success';
    marketplace.finish = undefined;
    marketplace.holdNext = false;
    if (outcome === 'reject') return Response.json({ ok: false, error: 'fixture_rejected', message: 'Archive checksum mismatch' });
    inventory.push(echoManifest);
    const application = outcome === 'activation-failed' ? { status: 'failed', error: 'Fixture startup failed' } : { status: 'available' };
    return Response.json({ ok: true, data: { plugin: echoManifest, application } });
  }
  if (path.endsWith('/conversation/plugins')) {
    const plugins: PluginCatalogItem[] = [{
      uri: 'plugin://github@first-party', displayName: 'GitHub', shortDescription: 'Read GitHub content.', activationMediaTypes: [],
      enabled: true, available: true, source: 'builtin', category: 'reference', contributionKind: 'host', discovery: 'searchOnly',
      management: { key: 'plugins.disabled', id: 'github' },
    }];
    if (inventory.includes(echoManifest)) plugins.push({
      uri: 'plugin://echo@fixture', displayName: 'Echo Tools', shortDescription: 'Echo sample.', activationMediaTypes: [],
      enabled: true, available: true, source: 'mounted', category: 'reference', contributionKind: 'skill', discovery: 'searchOnly',
      management: { key: 'skills.mounts', id: 'mount-fixture', path: echoManifest.path },
    });
    return Response.json({ ok: true, data: { revision: 'fixture', plugins } });
  }
  if (path.endsWith('/host/plugins/inspect')) return Response.json({ ok: true, data: {
    kind: 'ui', path: '/fixture/plugin', id: 'quiet-theme', name: 'Layout preview plugin', description: 'An isolated display plugin.', manifestPath: '/fixture/plugin/achbit-ui.json',
  } });
  if (path.endsWith('/plugin-services')) return Response.json({ ok: true, data: { services: [] } });
  if (path.endsWith('/plugin-services/events')) return new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('event: ready\ndata: {}\n\n'));
    init?.signal?.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')), { once: true });
  } }), { headers: { 'Content-Type': 'text/event-stream' } });
  throw new Error(`Unexpected fixture request: ${path}`);
};
useSettingsStore.setState({ loadUserSettings: async () => {}, loading: false, storePath: '/fixture/settings.json',
  environment: { os: 'windows', arch: 'x64', shell: { dialect: 'powershell7', executable: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe' }, developerCommands: ['git', 'node', 'python'], workspaceSandbox: { available: true } },
  effectiveSettings: { ...DEFAULT_USER_SETTINGS, 'workbench.language': query.get('lang') === 'en-US' ? 'en-US' : 'zh-CN',
    'workbench.uiPlugins': JSON.stringify([{ path: '/fixture/plugin', enabled: false }]) },
  patchUserSetting: async (key, value) => {
    useSettingsStore.setState(state => ({ effectiveSettings: { ...state.effectiveSettings, [key]: value } }));
    return 'immediate';
  },
});
const stopMonitor = installProductUpdateMonitor();
const frame = () => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
function bounds(element: Element) {
  const { x, y, width, height, right, bottom } = element.getBoundingClientRect();
  return { x, y, width, height, right, bottom };
}
function visible(element: Element) { return element.getClientRects().length > 0 && element.getBoundingClientRect().width > 0; }
function geometry() {
  const page = document.querySelector('.settings-page')!;
  const area = bounds(page), issues: string[] = [];
  const controls = [...page.querySelectorAll('button, input:not([hidden]), select, textarea, [role="alert"], [role="status"]')].filter(visible);
  for (const element of controls) {
    const rect = bounds(element), label = element.getAttribute('aria-label') ?? element.textContent?.trim() ?? element.tagName;
    if (rect.x < area.x - 1 || rect.right > area.right + 1) issues.push(`outside panel: ${label}`);
    for (let parent = element.parentElement; parent && parent !== page; parent = parent.parentElement) {
      if (['hidden', 'clip'].includes(getComputedStyle(parent).overflowX)) {
        const clip = bounds(parent);
        if (rect.x < clip.x - 1 || rect.right > clip.right + 1) issues.push(`clipped: ${label}`);
      }
    }
  }
  for (const row of page.querySelectorAll('.settings-actions, .settings-palette__field, .settings-field__edit-actions, .settings-palette__actions, .appearance-font-group__controls label')) {
    const children = [...row.childNodes].flatMap(node => {
      if (node.nodeType === Node.TEXT_NODE && node.textContent?.trim()) { const range = document.createRange(); range.selectNode(node); return [range.getBoundingClientRect()]; }
      return node instanceof Element && visible(node) ? [node.getBoundingClientRect()] : [];
    });
    for (let i = 0; i < children.length; i++) for (let j = i + 1; j < children.length; j++) {
      const a = children[i], b = children[j];
      if (Math.min(a.right, b.right) - Math.max(a.x, b.x) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.y, b.y) > 1)
        issues.push(`overlap: ${row.className || row.parentElement?.className}`);
    }
  }
  return { width: area.width, controls: controls.length, issues: [...new Set(issues)] };
}
type Page = 'about' | 'appearance' | 'general' | 'plugins';
function Fixture() {
  const [page, setPage] = useState<Page>('about');
  const [pluginsView, setPluginsView] = useState<PluginsView>({ tab: 'all', search: '' });
  const [width, setWidth] = useState(900);
  const [scale, setScale] = useState(1);
  const [language, setLanguage] = useState<UiLanguage>('zh-CN');
  const [result, setResult] = useState('Ready');
  const [running, setRunning] = useState(false);
  const configure = (next: Page, size: number, lang: UiLanguage, fontScale = 1) => {
    setPage(next); setWidth(size); setScale(fontScale); setLanguage(lang);
    useSettingsStore.setState(state => ({ effectiveSettings: { ...state.effectiveSettings, 'workbench.language': lang } }));
  };
  const check = async () => {
    setRunning(true); const results: object[] = []; const issues: string[] = [];
    try {
      for (const [size, lang, fontScale] of [[900, 'zh-CN', 1], [620, 'en-US', 1], [380, 'en-US', 1.5]] as const) {
        configure('about', size, lang, fontScale); publish('idle'); await frame();
        const buttons = () => [...document.querySelectorAll('.settings-runtime-card button')];
        const baseline = buttons().map(bounds);
        for (const phase of ['current', 'error', 'checking', 'waiting', 'disabled']) {
          publish(phase); await frame();
          const measured = geometry();
          if (['current', 'error'].includes(phase)) buttons().forEach((button, index) => {
            const rect = bounds(button);
            if (Math.abs(rect.x - baseline[index].x) > 1 || Math.abs(rect.y - baseline[index].y) > 1) measured.issues.push(`feedback moved action ${index + 1}`);
          });
          const actionBottom = Math.max(...buttons().map(button => bounds(button).bottom));
          document.querySelectorAll('.settings-runtime-card [role="status"], .settings-runtime-card [role="alert"]').forEach(feedback => {
            if (bounds(feedback).y < actionBottom - 1) measured.issues.push('feedback interrupts actions');
          });
          if (phase === 'checking' && !(buttons()[0] as HTMLButtonElement).disabled) measured.issues.push('busy action enabled');
          issues.push(...measured.issues.map(issue => `${lang}/${size}/${phase}: ${issue}`));
          results.push({ page: 'about', size, lang, fontScale, phase, ...measured });
        }
      }
      for (const next of ['appearance', 'plugins', 'general'] as const) {
        configure(next, 380, 'en-US'); await frame();
        if (next === 'appearance') {
          document.querySelectorAll<HTMLDetailsElement>('.settings-page details').forEach(detail => { detail.open = true; });
          await frame();
          const input = document.querySelector<HTMLInputElement>('.settings-palette__color-control input[type="text"]')!;
          Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, '#123456');
          input.dispatchEvent(new Event('input', { bubbles: true })); await frame();
        }
        if (next === 'plugins') {
          document.querySelector<HTMLButtonElement>('.plugin-manager__summary')!.click(); await frame();
        }
        const measured = geometry();
        if (next === 'appearance' && !document.querySelector('.settings-palette__actions')) measured.issues.push('palette draft actions missing');
        if (next === 'general' && !document.querySelector('input[type="file"][accept*="wav"]')) measured.issues.push('completion sound controls missing');
        issues.push(...measured.issues.map(issue => `${next}/380: ${issue}`));
        results.push({ page: next, ...measured });
      }
      setResult(JSON.stringify({ status: issues.length ? 'FAIL' : 'PASS', issues, results }, null, 2));
    } catch (error) { setResult(`ERROR: ${String(error)}`); }
    finally { setRunning(false); }
  };
  return <>
    <style>{`*{box-sizing:border-box}body{margin:0;font:14px/1.5 var(--ac-font-ui);background:var(--ac-background);color:var(--ac-foreground)}.fixture-toolbar{display:flex;gap:12px;flex-wrap:wrap;padding:12px}.fixture-toolbar label{display:flex;gap:6px;align-items:center}.fixture-panel{max-width:100%;height:680px;margin:12px auto}.fixture-result{white-space:pre-wrap;overflow-wrap:anywhere;padding:16px;max-height:360px;overflow:auto}.fixture-panel .settings-center{--ac-ui-font-scale:${scale}}`}</style>
    <nav className="fixture-toolbar">
      <label>Page<select aria-label="Page" value={page} onChange={event => setPage(event.target.value as Page)}>{['about', 'appearance', 'general', 'plugins'].map(value => <option key={value}>{value}</option>)}</select></label>
      <label>Panel width<select aria-label="Panel width" value={width} onChange={event => setWidth(Number(event.target.value))}>{[900, 620, 380].map(value => <option key={value}>{value}</option>)}</select></label>
      <label>Language<select aria-label="Language" value={language} onChange={event => configure(page, width, event.target.value as UiLanguage, scale)}><option>zh-CN</option><option>en-US</option></select></label>
      <label>Font<select aria-label="Font" value={scale} onChange={event => setScale(Number(event.target.value))}><option>1</option><option>1.5</option></select></label>
      <label>Update<select aria-label="Update" onChange={event => publish(event.target.value)}>{['idle', 'current', 'error', 'checking', 'waiting', 'disabled'].map(value => <option key={value}>{value}</option>)}</select></label>
      <button id="check-layout" disabled={running} onClick={() => void check()}>Check dynamic layout</button>
      <button onClick={() => setResult(JSON.stringify(geometry(), null, 2))}>Measure current page</button>
    </nav>
    <div className="fixture-panel" style={{ width }}><div className="settings-center"><section className="settings-body"><div className="settings-page">
      {page === 'plugins' ? <PluginsSection view={pluginsView} setView={setPluginsView} /> : <GuiSettingsSection category={page} apiStatus="connected" serverVersion="preview" />}
    </div></section></div></div>
    <pre id="layout-result" className="fixture-result">{result}</pre>
  </>;
}
const root = createRoot(document.getElementById('root')!);
if (fullSettings) {
  // Load the same chrome aliases/focus policy used around the production SettingsCenter.
  void Promise.all([import('../../src/achbit-gui/achbitGui.css'), import('../../src/achbit-gui/styles/achbitShell.css'), import('../../src/components/shared/focus.css')]).then(() => {
    document.documentElement.dataset.theme = query.get('theme') === 'dark' ? 'dark' : 'light';
    document.documentElement.style.setProperty('--ac-ui-font-scale', query.get('font') === 'large' ? String(18 / 14) : '1');
    root.render(<SettingsCenter apiStatus="connected" serverVersion="preview" />);
  });
} else root.render(<Fixture />);
window.addEventListener('achbit:request-interface-reload', () => { calls.push('interface-reload'); });
window.addEventListener('pagehide', () => { root.unmount(); stopMonitor(); window.__TAURI__ = originalTauri; window.fetch = originalFetch; window.__ACHBIT_BROWSER_PREVIEW__ = originalPreview; }, { once: true });
