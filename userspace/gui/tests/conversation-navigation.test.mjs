import test from 'node:test';
import assert from 'node:assert/strict';
import React, { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { findReactElement, loadGuiModule } from './gui-projection-contract.mjs';

test('long conversation reading and navigation measure logarithmically and share the anchor catalogue', async t => {
  const { ConversationAnchors, firstReadingAnchor } = await loadGuiModule(t, '/src/components/local-agent/conversationAnchors.ts');
  const { activeConversationAnchor } = await loadGuiModule(t, '/src/components/local-agent/conversationNavigationPosition.ts');
  let queries = 0, measurements = 0;
  const nodes = Array.from({ length: 4096 }, (_, i) => ({
    dataset: { conversationAnchor: `row:${i}` }, hidden: false,
    getBoundingClientRect() { measurements++; return { top: i * 100, bottom: (i + 1) * 100 }; },
  }));
  const body = { querySelectorAll() { queries++; return nodes; } };
  const index = new ConversationAnchors();
  const catalogue = index.read(body);
  assert.equal(firstReadingAnchor(catalogue.nodes, 300_010), nodes[3000]);
  const navigation = index.read(body).nodes.map(node => ({
    key: node.dataset.conversationAnchor, get top() { return node.getBoundingClientRect().top; },
  }));
  assert.equal(activeConversationAnchor(navigation, 300_040), 'row:3000');
  assert.equal(queries, 1, 'both consumers use the same catalogue without a second DOM scan');
  assert.ok(measurements <= 26, `4096 anchors took ${measurements} geometry reads`);
  assert.equal(firstReadingAnchor(catalogue.nodes, 409_600), undefined);
});

test('anchor catalogue refreshes after transcript commits and when the scroll body changes', async t => {
  const { ConversationAnchors } = await loadGuiModule(t, '/src/components/local-agent/conversationAnchors.ts');
  const first = { dataset: { conversationAnchor: 'old' }, hidden: false };
  const second = { dataset: { conversationAnchor: 'new' }, hidden: false };
  let rows = [first];
  const body = { querySelectorAll: () => rows };
  const index = new ConversationAnchors();
  assert.deepEqual(index.read(body).nodes, [first]);
  rows = [second, first]; first.hidden = true;
  index.invalidate();
  assert.deepEqual(index.read(body).nodes, [second]);
  assert.equal(index.read(body).byKey.get('old'), first, 'hidden anchors remain addressable for round navigation');
  assert.equal(index.read({ querySelectorAll: () => [] }).byKey.size, 0);
});

test('bottom selects the latest message without forcing its title to the top', async t => {
  const { activeConversationAnchor: active } = await loadGuiModule(t, '/src/components/local-agent/conversationNavigationPosition.ts');
  const anchors = [{ key: 'old', top: -200 }, { key: 'latest', top: 350 }];
  const view = { scrollTop: 400, scrollHeight: 1000, clientHeight: 600, latestKey: 'latest' };
  assert.equal(active(anchors, 40, view), 'latest');
  assert.equal(active(anchors, 40, { ...view, scrollTop: 399 }), 'latest', 'fractional end positions count');
  assert.equal(active(anchors, 40, { ...view, scrollTop: 380 }), 'old', 'reading history still uses the reading line');
  assert.equal(active(anchors, 40, { ...view, scrollHeight: 1100 }), 'old', 'new content below is not treated as already read');
  assert.equal(active(anchors, 40, { ...view, scrollTop: 500, scrollHeight: 1100 }), 'latest');
});

test('zero or one message hides navigation while both ends of a short conversation remain actionable', async t => {
  const { ConversationNavigation } = await loadGuiModule(t, '/src/components/local-agent/ConversationNavigation.tsx');
  const entries = Array.from({ length: 3 }, (_, i) => ({ key: `row:${i}`, rowIndex: i, label: `Message ${i + 1}` }));
  const navigated = [];
  const props = { sessionId: 'session:short-navigation', viewport: { bodyRef: { current: null } },
    language: 'zh-CN', onNavigate: entry => navigated.push(entry.key) };
  for (const count of [0, 1]) {
    assert.equal(renderToStaticMarkup(createElement(ConversationNavigation, { ...props, entries: entries.slice(0, count) })), '');
  }
  for (const count of [2, 3]) {
    let tree;
    function Probe() { tree = ConversationNavigation({ ...props, entries: entries.slice(0, count) }); return tree; }
    const html = renderToStaticMarkup(createElement(Probe));
    assert.equal((html.match(/<button\b/g) ?? []).length, count, 'no synthetic neighbors are added at either edge');
    for (const index of [0, count - 1]) {
      const button = findReactElement(tree, node => node.type === 'button'
        && node.props['aria-label'] === `跳至消息 ${index + 1}: Message ${index + 1}`);
      button.props.onClick();
      assert.equal(navigated.at(-1), entries[index].key);
    }
  }
});

test('the navigation reveals its current tick without moving the transcript or keyboard focus', async t => {
  const { ConversationNavigation } = await loadGuiModule(t, '/src/components/local-agent/ConversationNavigation.tsx');
  const saved = { window: globalThis.window, ResizeObserver: globalThis.ResizeObserver };
  const observers = [];
  globalThis.window = {};
  globalThis.ResizeObserver = class {
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe(node) { this.node = node; }
    disconnect() { this.disconnected = true; }
  };
  t.after(() => Object.assign(globalThis, saved));
  const entries = Array.from({ length: 40 }, (_, i) => ({ key: `row:${i}`, rowIndex: i, label: `Message ${i}` }));
  const body = { scrollTop: 777 };
  const effects = [];
  let tree, selectedIndex = 39;
  function Probe() {
    const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
    const original = internals.H;
    let state = 0;
    internals.H = { ...original, useState: value => original.useState(state++ === 0 ? entries[selectedIndex]?.key : value),
      useLayoutEffect: effect => { effects.push(effect); } };
    try {
      tree = ConversationNavigation({ sessionId: 'session:navigation', entries,
        viewport: { bodyRef: { current: body } }, onNavigate() {}, language: 'zh-CN' });
      return tree;
    } finally { internals.H = original; }
  }
  let writes = 0, scrollTop = 0;
  const rail = {
    clientHeight: 280,
    get scrollTop() { return scrollTop; },
    set scrollTop(value) { scrollTop = value; writes++; },
    focus() { assert.fail('revealing a position must not move keyboard focus'); },
    scrollIntoView() { assert.fail('do not scroll ancestor containers'); },
  };
  const cleanups = [];
  function commit(index) {
    cleanups.splice(0).forEach(cleanup => cleanup?.());
    assert.ok(observers.every(observer => observer.disconnected), 'old subscriptions are released');
    selectedIndex = index;
    renderToStaticMarkup(createElement(Probe));
    const ticks = findReactElement(tree, node => node.props.className === 'conversation-navigation__ticks');
    ticks.props.ref.current = rail;
    cleanups.push(...effects.splice(0).map(effect => effect()));
  }
  commit(39);
  t.after(() => cleanups.forEach(cleanup => cleanup?.()));
  assert.equal(scrollTop, 280, 'the last of 40 ticks is revealed at the lower edge');
  assert.equal(observers.length, 1);
  assert.equal(observers[0].node, rail);
  const resize = () => observers[0].callback();
  resize();
  assert.equal(writes, 1, 'an already visible tick does not cause another scroll');
  rail.clientHeight = 140;
  resize();
  assert.equal(scrollTop, 420, 'a shorter viewport still shows the current tick');
  commit(2);
  assert.equal(scrollTop, 0, 'the first two messages stay visible above the third');
  commit(9);
  assert.equal(scrollTop, 63, 'a historical tick already at the lower edge reveals its later neighbors');
  commit(5);
  assert.equal(scrollTop, 7, 'a historical tick at the upper edge reveals its earlier neighbors');
  commit(33);
  assert.equal(scrollTop, 399, 'a distant historical tick shows context on both sides');
  const before = writes;
  commit(31);
  observers.at(-1).callback();
  assert.equal(writes, before, 'a visible middle tick keeps the rail position');
  commit(undefined);
  rail.clientHeight = 0;
  commit(39);
  assert.equal(writes, before, 'missing ticks and hidden rails do not scroll');
  assert.equal(body.scrollTop, 777, 'only the navigation rail owns this scroll');
});

test('a sparse rail preserves manual scrolling when the same tail is measured or its full index arrives', async t => {
  const { ConversationNavigation } = await loadGuiModule(t, '/src/components/local-agent/ConversationNavigation.tsx');
  const originalResize = globalThis.ResizeObserver;
  globalThis.ResizeObserver = class { observe() {} disconnect() {} };
  t.after(() => { globalThis.ResizeObserver = originalResize; });
  const entries = Array.from({ length: 512 }, (_, i) => ({ key: `message:${i}`, rowIndex: i, label: `Question ${i}` }));
  const rail = { scrollTop: 0, clientHeight: 360 };
  const refs = [];
  let previous, dispose;
  t.after(() => dispose?.());
  // Exercise the real layout callback with React's dependency-change semantics. The
  // integration receipt additionally uses actual wheel geometry and DOM hit testing.
  function commit(active, input) {
    let effect, dependencies, tree;
    function Probe() {
      const internals = React.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE;
      const original = internals.H;
      let state = 0, ref = 0;
      internals.H = { ...original, useRef: value => {
        const fresh = original.useRef(value); return refs[ref++] ??= fresh;
      }, useState: value => original.useState(state++ === 0 ? active : value),
        useLayoutEffect: (next, deps) => { effect = next; dependencies = deps; } };
      try {
        tree = ConversationNavigation({ sessionId: 'session:rail', entries: input,
          viewport: { bodyRef: { current: null }, followingLatest: true }, onNavigate() {}, language: 'en-US' });
        return tree;
      } finally { internals.H = original; }
    }
    renderToStaticMarkup(createElement(Probe));
    findReactElement(tree, e => e.props.className === 'conversation-navigation__ticks').props.ref.current = rail;
    if (!previous || dependencies.some((v, i) => !Object.is(v, previous[i]))) {
      dispose?.(); dispose = effect(); previous = dependencies;
    }
    return tree;
  }
  commit(undefined, entries);
  assert.equal(rail.scrollTop, 512 * 14 - 360, 'following latest initially reveals the tail');
  rail.scrollTop = 3411;
  commit(entries.at(-1).key, entries);
  assert.equal(rail.scrollTop, 3411, 'confirming the same location does not undo a manual scroll');
  commit(entries.at(-1).key, entries.map(e => ({ ...e })));
  assert.equal(rail.scrollTop, 3411, 'canonical entry objects do not reset the rail either');
  commit(entries[30].key, entries);
  assert.equal(rail.scrollTop, 247, 'a new transcript location shows the current tick and its neighbors');

  const tree = commit(entries[30].key, entries);
  const visible = findReactElement(tree, e => e.type === 'button' && e.props['data-navigation-index'] === 500);
  rail.scrollTop = 6810; // The reader is browsing the end and can actually select this tick.
  visible.props.onClick();
  rail.scrollTop = 681; // The next wheel precedes the transcript's asynchronous location update.
  commit(entries[500].key, entries);
  assert.equal(rail.scrollTop, 681, 'confirming a rail click must not undo browsing for the next click');
  commit(entries[30].key, entries);
  assert.equal(rail.scrollTop, 247, 'a later independent location change still follows the transcript');
});

test('short layouts and virtualized latest rows use the catalog end; hidden viewports do not', async t => {
  const { activeConversationAnchor: active } = await loadGuiModule(t, '/src/components/local-agent/conversationNavigationPosition.ts');
  const anchors = [{ key: 'old', top: 80 }];
  assert.equal(active(anchors, 40, { scrollTop: 0, scrollHeight: 500, clientHeight: 500, latestKey: 'latest' }), 'latest');
  assert.equal(active([], 40, { scrollTop: 400, scrollHeight: 1000, clientHeight: 600, latestKey: 'latest' }), 'latest');
  assert.equal(active(anchors, 40, { scrollTop: 0, scrollHeight: 0, clientHeight: 0, latestKey: 'latest' }), 'old');
  assert.equal(active([], 40), undefined);
});
