// Real builtin renderer with fixture quota; no Host settings or Provider requests.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { UsageWidgetSettings } from '../../src/ui-plugins/UsageWidgetSettings';
import { normalizeUiLanguage } from '../../src/i18n';
import { usageWidgetLabels } from '../../src/ui-plugins/usageWidgetLabels';
import { usageCostDisplay } from '../../src/ui-plugins/usageCost';
import { Cost } from '../../src/components/settings-center/model-services/shared';
import { useSettingsStore } from '../../src/state/settingsStore';
import plugin from '../../src/ui-plugins/builtinUsage.mjs';
import { installPaletteDefaults } from '../../src/theme/palette';
import '../../src/achbit-gui/styles/achbitDesignTokens.css';
import '../../src/theme/paletteBase.css';

installPaletteDefaults();
const style = document.createElement('style');
style.textContent = `*{box-sizing:border-box}html,body{height:100%;margin:0;font-family:var(--ac-font-ui);color:var(--ac-foreground);background:var(--ac-surface)}body{display:grid;grid-template-rows:60px minmax(0,1fr)}body>header{display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between;padding:8px 24px;border-bottom:1px solid var(--ac-border);font-size:13px}main{position:relative;min-height:0}#usage{position:absolute;inset:0;pointer-events:none}#reader{position:absolute;inset:0 0 0 45%;padding:24px;background:var(--ac-surface-subtle);border-left:1px solid var(--ac-border)}main[data-reading] #usage{right:55%}`;
document.head.append(style);
// The browser driver uses HTMLElement.click(), which emits no pointer events.
// Explicitly exercise the real outside pointerdown path on the blank DOM node.
// This belongs to the isolated fixture, not the production renderer.
document.getElementById('outside-check')!.onclick = () => {
  document.getElementById('blank')!.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0, isPrimary: true }));
};
const status = document.getElementById('status')!;
const abort = new AbortController();
let reads = 0;
const dialogRoot = createRoot(document.getElementById('widget-dialog')!);
const costRoot = createRoot(document.getElementById('detail-cost')!);
const totals = { calls: 1, pricedCalls: 1, estimatedCost: 2, inputTokens: 2500, outputTokens: 300, cacheReadTokens: 0 };
useSettingsStore.setState({ patchUserSettingsBatch: async patches => {
  useSettingsStore.setState({ effectiveSettings: { ...useSettingsStore.getState().effectiveSettings, ...patches } });
  return 'immediate';
} });
const openSettings = () => dialogRoot.render(React.createElement(UsageWidgetSettings, { onClose: () => dialogRoot.render(null) }));
(document.getElementById('billing-mode') as HTMLSelectElement).onchange = event => {
  input = { ...input, connection: { ...input.connection, billingMode: (event.target as HTMLSelectElement).value }, expanded: false };
  view.update(input); describe();
};
(document.getElementById('ui-language') as HTMLSelectElement).onchange = event => {
  useSettingsStore.setState({ effectiveSettings: { ...useSettingsStore.getState().effectiveSettings, 'workbench.language': (event.target as HTMLSelectElement).value } });
};
const unsubscribe = useSettingsStore.subscribe(state => {
  input = { ...input, locale: normalizeUiLanguage(state.effectiveSettings['workbench.language']), labels: usageWidgetLabels(normalizeUiLanguage(state.effectiveSettings['workbench.language'])), costDisplay: usageCostDisplay(state.effectiveSettings['gui.usageWidget.currency']),
    visibility: state.effectiveSettings['gui.usageWidget.enabled'] === false ? 'hidden' : 'summary' };
  view.update(input);
});
costRoot.render(React.createElement(Cost, { totals: totals as never }));
let input = { kind: 'usage.widget', connection: { id: 'connection:preview', name: 'OpenAI · Codex', billingMode: 'subscription', adapterId: 'openai-codex' },
  modelId: 'codex', visibility: 'summary', expanded: false, revision: 0, locale: 'zh-CN', theme: 'light', costDisplay: usageCostDisplay('USD'), labels: usageWidgetLabels('zh-CN') };
let view: { update(next: typeof input): void; dispose(): void };
let readerOpen = false, savedVisibility = 'summary';
document.getElementById('reader-toggle')!.onclick = event => {
  readerOpen = !readerOpen;
  if (readerOpen) savedVisibility = input.visibility;
  document.getElementById('blank')!.toggleAttribute('data-reading', readerOpen);
  document.getElementById('reader')!.hidden = !readerOpen;
  const button = event.currentTarget as HTMLButtonElement;
  button.textContent = readerOpen ? '收起侧栏' : '打开侧栏';
  button.setAttribute('aria-expanded', String(readerOpen));
  input = { ...input, visibility: readerOpen ? 'collapsed' : savedVisibility, expanded: false };
  view.update(input); describe();
};
const describe = () => { status.textContent = `${input.expanded ? '详情展开' : '摘要卡片'} · 刷新次数 ${reads}`; };
plugin.apply({
  addStyle(css: string) { const element = document.createElement('style'); element.textContent = css; document.head.append(element); },
  register(_slot: string, mount: (container: HTMLElement, input: unknown, scope: unknown) => typeof view) {
    view = mount(document.getElementById('usage')!, input, { signal: abort.signal,
      actions: {
        setExpanded(expanded: boolean) { input = { ...input, expanded }; view.update(input); describe(); },
        setUsageVisibility(visibility: string) { input = { ...input, visibility, expanded: false }; view.update(input); describe(); },
        openUsageSettings: openSettings,
      },
      usage: { async query() { reads++; describe(); return { totals, buckets: [], coverageFrom: 0, query: { from: 0 } }; } },
      quota: { async read() { reads++; describe(); return { windows: [{ label: 'Codex', usedPercent: 21,
        windowDurationSeconds: 604800, resetsAt: '2026-09-27T08:10:44Z' }] }; } },
    });
  },
});
describe();
window.addEventListener('pagehide', () => { unsubscribe(); abort.abort(); view.dispose(); dialogRoot.unmount(); costRoot.unmount(); }, { once: true });
