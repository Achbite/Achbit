// Production settings with isolated desktop/HTTP fixtures; never updates a real installation.
import React, { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { DEFAULT_USER_SETTINGS } from '@achbit/protocol';
import { GuiSettingsSection } from '../../src/components/settings-center/sections/CategorizedSettingsSections';
import PluginsSection from '../../src/components/settings-center/sections/PluginsSection';
import { useSettingsStore } from '../../src/state/settingsStore';
import { installProductUpdateMonitor, type ProductUpdateStatus } from '../../src/services/productUpdates';
import { installPaletteDefaults } from '../../src/theme/palette';
import type { UiLanguage } from '../../src/i18n';
import '../../src/achbit-gui/styles/achbitDesignTokens.css';
import '../../src/theme/paletteBase.css';
import '../../src/components/settings-center/settingsCenter.css';

installPaletteDefaults();
const handlers = new Map<string, (event: { payload: unknown }) => void>();
const calls: string[] = [];
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
  core: { async invoke<T>(command: string): Promise<T> {
    calls.push(command);
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
  const path = new URL(String(input), location.href).pathname;
  if (path.endsWith('/conversation/plugins')) return Response.json({ ok: true, data: { revision: 'fixture', plugins: [] } });
  if (path.endsWith('/host/plugins/inspect')) return Response.json({ ok: true, data: {
    kind: 'ui', path: '/fixture/plugin', id: 'layout', name: 'Layout preview plugin', description: 'An isolated display plugin.', manifestPath: '/fixture/plugin/achbit-ui.json',
  } });
  if (path.endsWith('/plugin-services')) return Response.json({ ok: true, data: { services: [] } });
  if (path.endsWith('/plugin-services/events')) return new Response(new ReadableStream({ start(controller) {
    controller.enqueue(new TextEncoder().encode('event: ready\ndata: {}\n\n'));
    init?.signal?.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')), { once: true });
  } }), { headers: { 'Content-Type': 'text/event-stream' } });
  throw new Error(`Unexpected fixture request: ${path}`);
};
useSettingsStore.setState({ loading: false, storePath: '/fixture/settings.json',
  effectiveSettings: { ...DEFAULT_USER_SETTINGS, 'workbench.language': 'zh-CN',
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
      {page === 'plugins' ? <PluginsSection /> : <GuiSettingsSection category={page} apiStatus="connected" serverVersion="preview" />}
    </div></section></div></div>
    <pre id="layout-result" className="fixture-result">{result}</pre>
  </>;
}
const root = createRoot(document.getElementById('root')!);
root.render(<Fixture />);
window.addEventListener('achbit:request-interface-reload', () => { calls.push('interface-reload'); });
window.addEventListener('pagehide', () => { root.unmount(); void stopMonitor.then(stop => stop()); window.__TAURI__ = originalTauri; window.fetch = originalFetch; window.__ACHBIT_BROWSER_PREVIEW__ = originalPreview; }, { once: true });
