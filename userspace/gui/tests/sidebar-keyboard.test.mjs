import test from 'node:test';
import assert from 'node:assert/strict';
import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { findReactElement, loadGuiModule } from './gui-projection-contract.mjs';

test('Command digits no longer switch sessions or advertise shortcuts; click and drag cancellation remain', async t => {
  const { default: Sidebar } = await loadGuiModule(t, '/src/achbit-gui/layout/AchbitSidebar.tsx');
  const previous = { window: globalThis.window, document: globalThis.document };
  const listeners = new Map(), effects = [], cleanup = [], activated = [];
  globalThis.window = {
    addEventListener(name, listener) { if (!listeners.has(name)) listeners.set(name, new Set()); listeners.get(name).add(listener); },
    removeEventListener(name, listener) { listeners.get(name)?.delete(listener); },
  };
  globalThis.document = { querySelector: () => null };
  t.after(() => { cleanup.forEach(stop => stop?.()); Object.assign(globalThis, previous); });
  const sessions = Array.from({ length: 9 }, (_, i) => ({ id: `session:${i}`, title: `Conversation ${i}`, projectId: null }));
  let tree;
  function Probe() {
    const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
    const original = internals.H;
    internals.H = { ...original, useEffect: effect => { effects.push(effect); } };
    try {
      tree = Sidebar({ language: 'en-US', catalogStatus: 'ready', projects: [], sessions,
        sessionStatuses: {}, readRunMarkers: {}, collapsedProjectIds: new Set(), activeSessionId: sessions[0].id,
        busy: false, activationBusy: false, reorderDisabled: false, onActivateSession: session => activated.push(session.id) });
      return tree;
    } finally { internals.H = original; }
  }
  const html = renderToStaticMarkup(createElement(Probe));
  cleanup.push(...effects.map(effect => effect()));
  for (const digit of [1, 9]) {
    const event = { key: String(digit), code: `Digit${digit}`, metaKey: true, defaultPrevented: false,
      preventDefault() { this.defaultPrevented = true; } };
    for (const listener of listeners.get('keydown') ?? []) listener(event);
    assert.equal(event.defaultPrevented, false);
  }
  assert.deepEqual(activated, []);
  assert.doesNotMatch(html, /aria-keyshortcuts|<kbd|⌘/);
  assert.equal(listeners.get('keyup')?.size ?? 0, 0);
  for (const listener of listeners.get('keydown') ?? []) listener({ key: 'Escape' });
  findReactElement(tree, node => node.props['data-ui-action'] === 'navigation.sidebar.open-session'
    && JSON.parse(node.props['data-ui-target']).sessionId === sessions[1].id).props.onClick();
  assert.deepEqual(activated, [sessions[1].id]);
});

test('empty sidebar preserves loading and errors; project disclosure and show-more retain their actions', async t => {
  const { default: Sidebar } = await loadGuiModule(t, '/src/achbit-gui/layout/AchbitSidebar.tsx');
  const props = { language: 'zh-CN', catalogStatus: 'ready', projects: [], sessions: [],
    sessionStatuses: {}, readRunMarkers: {}, collapsedProjectIds: new Set(), activeSessionId: null,
    busy: false, activationBusy: false, reorderDisabled: false };
  const render = overrides => renderToStaticMarkup(createElement(Sidebar, { ...props, ...overrides }));
  const empty = render({});
  assert.doesNotMatch(empty, /暂无项目|暂无对话|正在加载对话/);
  assert.equal((empty.match(/class="achbit-gui-sidebar-empty"/g) ?? []).length, 2);
  const loading = render({ catalogStatus: 'pending', busy: true });
  assert.match(loading, /正在加载对话/);
  assert.match(loading, /data-ui-action="navigation.sidebar.project-create-menu"[^>]*disabled=""/);
  assert.match(render({ catalogStatus: 'error' }), /无法加载对话/);
  const project = { id: 'project:empty', title: '空项目' };
  assert.match(render({ projects: [project] }), /achbit-gui-sidebar-empty--nested/);
  assert.doesNotMatch(render({ projects: [project], collapsedProjectIds: new Set([project.id]) }), /achbit-gui-sidebar-empty--nested/);
  const sessions = Array.from({ length: 12 }, (_, i) => ({ id: `session:${i}`, title: `对话 ${i}`, projectId: project.id }));
  assert.match(render({ projects: [project], sessions }), />展开更多<\/button>/);
  assert.doesNotMatch(render({ projects: [project], sessions }), /展开更多（/);
});
