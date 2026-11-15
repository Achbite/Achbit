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
