import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadGuiModule } from './gui-projection-contract.mjs';
import { collectUiSources } from '../ui-ownership-sources.mjs';

const component = ownerId => ({ ownerId, slot: null, pluginId: null, read: () => null,
  actions: () => ({ updateDraft: value => value }) });

test('semantic owner may have several independent instances; ambiguous instance IDs cannot invoke an owner', async t => {
  const { createDebugUiRegistry } = await loadGuiModule(t, '/src/debug/registry.ts');
  const registry = createDebugUiRegistry();
  const removeA = registry.register('a', component('composer.context'));
  const removeB = registry.register('b', component('composer.context'));
  assert.equal(registry.list().length, 2);
  assert.deepEqual(registry.list().map(row => row.identityStatus), ['unique', 'unique']);
  const removeDuplicate = registry.register('a', component('other'));
  assert.equal(registry.list().filter(row => row.id === 'a').length, 2);
  await assert.rejects(registry.call('a', 'updateDraft', ['x']), /debug_component_ambiguous/);
  assert.equal((await registry.call('b', 'updateDraft', ['kept'])).result, 'kept');
  removeDuplicate();
  assert.equal((await registry.call('a', 'updateDraft', ['original'])).result, 'original');
  removeA(); removeB();
  assert.deepEqual(registry.list(), []);
  await assert.rejects(registry.call('a', 'updateDraft', ['x']), /not_mounted/);
});

test('production context controls bind separate instances and parts without adding a wrapper', async t => {
  const { ContextUsageControl } = await loadGuiModule(t, '/src/components/local-agent/ContextUsageControl.tsx');
  const props = { language: 'en-US', contextUsage: null, contextCompositions: [], contextOpen: false,
    setContextOpen() {}, onToggle() {}, rootRef: { current: null } };
  const html = renderToStaticMarkup(createElement('main', null,
    createElement(ContextUsageControl, props), createElement(ContextUsageControl, props)));
  assert.match(html, /^<main><button/);
  assert.match(html, /<\/button><button/);
  assert.equal((html.match(/data-ui-owner="composer.context"/g) ?? []).length, 2);
  assert.equal((html.match(/data-ui-part="trigger"/g) ?? []).length, 2);
  assert.equal((html.match(/data-ui-action="composer.context.trigger"/g) ?? []).length, 2);
  assert.equal((html.match(/data-ui-action-kind="click"/g) ?? []).length, 2);
  const instances = [...html.matchAll(/data-ui-instance="([^"]+)"/g)].map(match => match[1]);
  assert.equal(new Set(instances).size, 2);
  assert.equal((html.match(/disabled=""/g) ?? []).length, 2, 'identity does not change the existing empty-state availability');
});

test('stable actions resolve canonical targets and preserve availability, ambiguity and unmount failures', async t => {
  const { createDebugUiRegistry } = await loadGuiModule(t, '/src/debug/registry.ts');
  const registry = createDebugUiRegistry();
  const calls = [];
  let unavailableReason = null;
  const source = sessionId => ({ ...component('composer.controls'), target: () => ({ sessionId }),
    read: () => ({ sessionId }), actions: () => ({ updateDraft: text => calls.push([sessionId, text]) }),
    actionStates: () => ({ updateDraft: { unavailableReason } }) });
  const removeA = registry.register('transient-a', source('session:a'));
  const removeB = registry.register('transient-b', source('session:b'));
  assert.equal(registry.list()[0].actions[0].actionId, 'composer.controls.updateDraft');
  await assert.rejects(registry.callAction('composer.controls.updateDraft', {}, ['x']), /target_ambiguous/);
  const result = await registry.callAction('composer.controls.updateDraft', { sessionId: 'session:b' }, ['b']);
  assert.equal(result.execution, 'component.callback');
  assert.deepEqual(calls, [['session:b', 'b']]);
  assert.equal(registry.owner('composer.controls', { sessionId: 'session:b' }).input.sessionId, 'session:b');
  unavailableReason = 'composer_busy';
  await assert.rejects(registry.callAction('composer.controls.updateDraft', { sessionId: 'session:a' }, ['a']), /composer_busy/);
  removeA();
  await assert.rejects(registry.callAction('composer.controls.updateDraft', { sessionId: 'session:a' }, ['a']), /not_mounted/);
  removeB();
  registry.register('undeclared', component('composer.controls'));
  await assert.rejects(registry.callAction('composer.controls.updateDraft', {}, ['a']), /availability_not_declared/);
  assert.deepEqual(calls, [['session:b', 'b']], 'rejected dispatches never invoke a business handler');
});

test('source map is derived from declarations and existing regions, not a second source table', async () => {
  const root = fileURLToPath(new URL('../../../', import.meta.url));
  const sources = await collectUiSources(fileURLToPath(new URL('../src', import.meta.url)), root);
  assert.equal(sources['composer.context'][0].symbol, 'ContextUsageControl');
  assert.equal(sources['composer.context'][0].file, 'userspace/gui/src/components/local-agent/ContextUsageControl.tsx');
  assert.ok(sources['region.composer.model'].some(row => row.symbol === 'SessionModelSelector'));
  assert.equal(sources['region.*'][0].symbol, 'UiPluginSlotView');
});

test('duplicate declarations and invalid semantic IDs fail source extraction, but repeated region use is allowed', async t => {
  const root = await mkdtemp(join(tmpdir(), 'achbit-ui-owner-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'sample.tsx');
  await writeFile(file, "function A(){useUiOwner('valid.one');} function B(){useUiOwner('valid.one');}");
  await assert.rejects(collectUiSources(root, root), /Duplicate UI owner/);
  await writeFile(file, "function A(){useUiOwner('invalid id');}");
  await assert.rejects(collectUiSources(root, root), /Invalid UI owner/);
  await writeFile(file, 'function A(){return <><UiRegion slot="navigation"/><UiRegion slot="navigation"/></>;}');
  assert.equal((await collectUiSources(root, root))['region.navigation'].length, 2);
});


test('source extraction names arrow components and rejects unmapped dynamic declarations', async t => {
  const root = await mkdtemp(join(tmpdir(), 'achbit-ui-owner-symbol-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const file = join(root, 'sample.tsx');
  await writeFile(file, "const Composer = () => { const identity = useUiOwner('composer.example'); return null; };");
  assert.equal((await collectUiSources(root, root))['composer.example'][0].symbol, 'Composer');
  await writeFile(file, 'const Composer = () => useUiOwner(dynamicId);');
  await assert.rejects(collectUiSources(root, root), /explicit semantic declaration/);
});

test('ownership reports separate Portal boundaries, contents boxes, plugin coverage and removed roots', async t => {
  const names = ['document', 'window', 'getComputedStyle', 'MutationObserver', 'CSS'];
  const previous = Object.fromEntries(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  t.after(() => { for (const name of names) {
    if (previous[name]) Object.defineProperty(globalThis, name, previous[name]); else delete globalThis[name];
  } });
  const roots = [];
  const rect = { x: 10, y: 20, width: 120, height: 30 };
  const node = (dataset = {}, parentElement = null, display = 'block') => ({
    dataset, parentElement, display, children: [], isConnected: true,
    getBoundingClientRect: () => rect,
    closest(selector) {
      for (let current = this; current; current = current.parentElement) {
        if (selector === '[data-ui-owner][data-ui-instance]' && current.dataset.uiOwner && current.dataset.uiInstance) return current;
        if (selector === '[data-ui-plugin]' && current.dataset.uiPlugin) return current;
      }
      return null;
    },
  });
  globalThis.document = { querySelectorAll: selector => roots.filter(root => root.isConnected && selector === `[data-ui-instance="${root.dataset.uiInstance}"]`) };
  globalThis.window = {};
  globalThis.CSS = { escape: value => value };
  globalThis.getComputedStyle = element => ({ display: element.display });
  globalThis.MutationObserver = class { observe() {} disconnect() {} };
  const { createOwnershipInspector } = await loadGuiModule(t, '/src/debug/ownership.ts');
  const source = [{ file: 'context.tsx', symbol: 'Context', line: 1 }];
  const inspector = createOwnershipInspector({ 'composer.context': source, 'region.*': [{ file: 'plugins.tsx', symbol: 'UiPluginSlotView', line: 2 }] });
  const attributes = (part, id = 'a') => ({ uiOwner: 'composer.context', uiInstance: id, uiPart: part });
  const trigger = node(attributes('trigger'));
  const unrelatedPortalParent = node({ uiOwner: 'workbench', uiInstance: 'parent', uiPart: 'root' });
  const portal = node(attributes('panel'), unrelatedPortalParent, 'contents');
  const portalChild = node({}, portal); portal.children.push(portalChild);
  const second = node(attributes('trigger', 'b'));
  roots.push(trigger, portal, second);
  assert.equal(inspector.identity(portalChild).ownerId, 'composer.context');
  assert.equal(inspector.identity(portalChild).partId, 'panel');
  assert.deepEqual(inspector.identity(portalChild).source, source);
  const component = inspector.component('a', { ownerId: 'composer.context' });
  assert.equal(component.boundaries.length, 2);
  assert.deepEqual(component.boundaries[1].bounds, [rect]);
  assert.equal(component.boundaries[1].parent.ownerId, 'workbench');
  assert.equal(inspector.component('b', { ownerId: 'composer.context' }).boundaries.length, 1);
  const plugin = node({ uiOwner: 'region.navigation', uiInstance: 'plugin', uiPart: 'renderer', uiPlugin: 'external-example', uiGeneration: '3' });
  const pluginChild = node({}, plugin);
  const internal = inspector.identity(pluginChild);
  assert.equal(internal.ownerId, 'region.navigation');
  assert.equal(internal.implementationCoverage, 'plugin-internal-unmapped');
  assert.deepEqual(internal.renderer, { pluginId: 'external-example', generation: '3' });
  assert.equal(inspector.identity(node()).coverage, 'uncovered');
  trigger.isConnected = false; portal.isConnected = false;
  assert.equal(inspector.component('a', { ownerId: 'composer.context' }).coverage, 'no-dom-boundary');
  assert.equal(inspector.component('b', { ownerId: 'composer.context' }).boundaries.length, 1);
});


test('diagnostic overlay follows modal/popover layers without taking business input and releases its resources', async t => {
  const names = ['document', 'window', 'Element', 'getComputedStyle', 'MutationObserver'];
  const previous = Object.fromEntries(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
  t.after(() => { for (const name of names) {
    if (previous[name]) Object.defineProperty(globalThis, name, previous[name]); else delete globalThis[name];
  } });
  const listeners = new Map();
  const windowListeners = new Map();
  const listen = (map, name, handler) => { if (!map.has(name)) map.set(name, new Set()); map.get(name).add(handler); };
  const unlisten = (map, name, handler) => map.get(name)?.delete(handler);
  const dispatch = (name, target, extra = {}) => {
    for (const handler of listeners.get(name) ?? []) handler({ target, ...extra });
  };
  const topLayer = [];
  const removeLayer = element => { const index = topLayer.indexOf(element); if (index >= 0) topLayer.splice(index, 1); };
  let body;
  class Element {
    constructor(tagName = 'div') {
      this.tagName = tagName; this.dataset = {}; this.attributes = {}; this.style = {};
      this.children = []; this.parentElement = null; this.hidden = false; this.openPopover = false;
      this.rect = { x: 10, y: 20, width: 120, height: 30 };
    }
    get isConnected() { return this === body || Boolean(this.parentElement?.isConnected); }
    get firstElementChild() { return this.children[0]; }
    setAttribute(name, value) { this.attributes[name] = value; }
    append(...children) { for (const child of children) { this.children.push(child); child.parentElement = this; } }
    remove() {
      this.parentElement?.children.splice(this.parentElement.children.indexOf(this), 1);
      this.parentElement = null; removeLayer(this); this.openPopover = false;
    }
    getBoundingClientRect() { return this.rect; }
    closest(selector) {
      for (let current = this; current; current = current.parentElement) {
        if (selector === '[data-ui-owner][data-ui-instance]' && current.dataset.uiOwner && current.dataset.uiInstance) return current;
        if (selector === '[data-ui-plugin]' && current.dataset.uiPlugin) return current;
      }
      return null;
    }
    matches(selector) {
      if (selector === ':popover-open') return this.openPopover;
      if (selector === 'dialog, [popover]') return this.tagName === 'dialog' || 'popover' in this.attributes;
      throw new Error(`Unexpected selector: ${selector}`);
    }
    showPopover() {
      assert.equal(this.attributes.popover, 'manual', 'diagnostics must not dismiss existing auto popovers');
      assert.ok(this.isConnected);
      this.openPopover = true; topLayer.push(this); dispatch('toggle', this);
    }
    hidePopover() { this.openPopover = false; removeLayer(this); dispatch('toggle', this); }
    focus() { assert.fail('diagnostics must not move business focus'); }
  }
  body = new Element('body');
  let hit = null;
  const observedPoints = [];
  globalThis.Element = Element;
  globalThis.document = { body, activeElement: null, createElement: tag => new Element(tag),
    addEventListener: (name, handler) => listen(listeners, name, handler),
    removeEventListener: (name, handler) => unlisten(listeners, name, handler),
    elementFromPoint: (x, y) => { observedPoints.push([x, y]); return hit; } };
  globalThis.window = { innerWidth: 1000, innerHeight: 800,
    addEventListener: (name, handler) => listen(windowListeners, name, handler),
    removeEventListener: (name, handler) => unlisten(windowListeners, name, handler) };
  globalThis.getComputedStyle = () => ({ display: 'block' });
  let observer;
  globalThis.MutationObserver = class {
    constructor(callback) { this.callback = callback; observer = this; }
    observe(root) { assert.equal(root, body); this.active = true; }
    disconnect() { this.active = false; }
  };
  const owner = (tag, name, parent = body) => {
    const element = new Element(tag);
    element.dataset = { uiOwner: name, uiInstance: `${name}-instance`, uiPart: 'root' };
    parent.append(element); return element;
  };
  const page = owner('main', 'page');
  page.dataset.uiAction = 'page.open';
  const input = new Element('input'); page.append(input); document.activeElement = input;
  const { createOwnershipInspector } = await loadGuiModule(t, '/src/debug/ownership.ts');
  const inspector = createOwnershipInspector({ page: [{ file: 'page.tsx', symbol: 'Page', line: 3 }] });
  inspector.setOverlay(true);
  const overlay = body.children.find(element => element.dataset.achbitDiagnostic === 'ownership');
  assert.ok(overlay.hidden);
  assert.equal(overlay.attributes['aria-hidden'], 'true');
  assert.match(overlay.style.cssText, /pointer-events:\s*none/);
  assert.ok(overlay.children.some(child => child.tagName === 'style'
    && /::backdrop\s*\{[^}]*pointer-events:\s*none/.test(child.textContent)));
  assert.ok([overlay, ...overlay.children].every(element => !('tabindex' in element.attributes) && !('autofocus' in element.attributes)));
  dispatch('pointermove', input, { clientX: 24, clientY: 36 });
  assert.equal(topLayer.at(-1), overlay);
  assert.equal(overlay.hidden, false);
  assert.match(overlay.firstElementChild.textContent, /page.tsx:3/);
  assert.ok(overlay.firstElementChild.textContent.includes('actionId page.open'));

  page.rect = { x: 995, y: 795, left: 995, top: 795, right: 996, bottom: 796, width: 1, height: 1 };
  dispatch('focusin', input);
  assert.equal(overlay.firstElementChild.style.width, '420px', 'label width is independent of a one-pixel target');
  assert.equal(overlay.firstElementChild.style.left, '572px', 'label remains inside the right viewport edge');
  assert.equal(overlay.firstElementChild.style.top, '759px', 'bottom-edge labels move above the target');
  assert.equal(overlay.children[1].style.width, '1px', 'highlight still identifies the actual narrow target');
  assert.equal(document.activeElement, input, 'inspection follows keyboard focus without taking it');
  dispatch('pointermove', input, { clientX: 24, clientY: 36 });

  const modal = owner('dialog', 'image-review'); modal.open = true; topLayer.push(modal); hit = modal;
  dispatch('toggle', modal);
  assert.deepEqual(topLayer, [modal, overlay], 'diagnostics move above a newly opened modal');
  assert.match(overlay.firstElementChild.textContent, /image-review/);
  assert.equal(modal.open, true);
  assert.equal(document.activeElement, input);
  assert.deepEqual(observedPoints.at(-1), [24, 36]);

  const popover = owner('div', 'review-menu', modal);
  popover.setAttribute('popover', 'auto'); popover.openPopover = true; topLayer.push(popover); hit = popover;
  dispatch('toggle', popover);
  assert.deepEqual(topLayer, [modal, popover, overlay], 'existing business popovers remain open below diagnostics');
  assert.match(overlay.firstElementChild.textContent, /review-menu/);
  popover.openPopover = false; removeLayer(popover); hit = modal;
  dispatch('toggle', popover);
  assert.deepEqual(topLayer, [modal, overlay]);
  assert.match(overlay.firstElementChild.textContent, /image-review/);
  assert.deepEqual([...listeners.keys()].sort(), ['focusin', 'pointermove', 'pointerout', 'scroll', 'toggle'], 'diagnostics observe focus but do not handle click, cancel or keyboard input');

  modal.remove(); observer.callback();
  assert.equal(overlay.hidden, true);
  assert.equal(overlay.openPopover, false);
  assert.equal(topLayer.length, 0);
  dispatch('pointermove', input, { clientX: 24, clientY: 36 });
  assert.equal(topLayer.at(-1), overlay);
  inspector.setOverlay(false);
  assert.equal(overlay.isConnected, false);
  assert.equal(topLayer.length, 0);
  assert.equal(observer.active, false);
  assert.ok([...listeners.values(), ...windowListeners.values()].every(handlers => handlers.size === 0));
  inspector.setOverlay(true);
  assert.equal(listeners.get('toggle').size, 1);
  assert.equal(body.children.filter(element => element.dataset.achbitDiagnostic === 'ownership').length, 1);
  assert.equal(topLayer.length, 0, 'reenabling does not resurrect the old target');
  inspector.setOverlay(false);

  // Exercise the same Debug-only entry script that packaging inserts in <head>.
  const bundle = await mkdtemp(join(tmpdir(), 'achbit-default-overlay-'));
  t.after(() => rm(bundle, { recursive: true, force: true }));
  const vite = fileURLToPath(new URL('bin/vite.js', import.meta.resolve('vite/package.json')));
  execFileSync(process.execPath, [vite, 'build', '--config', 'vite.debug-ui.config.ts', '--outDir', bundle, '--logLevel', 'silent'],
    { cwd: fileURLToPath(new URL('../', import.meta.url)) });
  document.body = null;
  document.readyState = 'loading';
  runInNewContext(await readFile(join(bundle, 'ui.js'), 'utf8'), { window, document, Element, MutationObserver, getComputedStyle, crypto });
  document.body = body;
  document.readyState = 'interactive';
  dispatch('readystatechange', document);
  assert.equal(window.__ACHBIT_DEBUG_UI__.overlayStatus().enabled, true);
  const attachment = owner('button', 'composer.controls');
  attachment.dataset.uiPart = 'attachments';
  attachment.dataset.uiAction = 'composer.controls.attachments';
  dispatch('pointermove', attachment, { clientX: 24, clientY: 36 });
  const label = topLayer.at(-1).firstElementChild.textContent;
  assert.match(label, /actionId composer\.controls\.attachments/);
  assert.match(label, /ConversationComposer\.tsx:\d+/);
  window.__ACHBIT_DEBUG_UI__.setOverlay(false);
});
