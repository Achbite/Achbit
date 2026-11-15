// TCR: .task-artifacts/model-panel-preview/TCR.md — shared non-modal dismissal.
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadGuiModule } from './gui-projection-contract.mjs';

function fixture(t) {
  const saved = Object.fromEntries(['Node', 'HTMLElement'].map(key => [key, globalThis[key]]));
  const listeners = new Map(), dialogs = [];
  const owner = { activeElement: null, querySelectorAll: () => dialogs,
    addEventListener(type, listener, capture) { listeners.set(type, { listener, capture }); },
    removeEventListener(type, listener, capture) {
      const registered = listeners.get(type);
      if (registered?.listener === listener && registered.capture === capture) listeners.delete(type);
    } };
  class Element {
    children = []; ownerDocument = owner;
    contains(target) { return target === this || this.children.some(child => child.contains(target)); }
    focus() { owner.activeElement = this; }
    blur() { owner.activeElement = owner.body; }
  }
  owner.body = new Element(); owner.activeElement = owner.body;
  Object.assign(globalThis, { Node: Element, HTMLElement: Element });
  t.after(() => Object.assign(globalThis, saved));
  return { owner, listeners, dialogs, element: () => new Element(),
    dispatch(type, target, details = {}) {
      const event = { target, defaultPrevented: false, stopped: false, composedPath: () => [target],
        preventDefault() { this.defaultPrevented = true; }, stopPropagation() { this.stopped = true; }, ...details };
      listeners.get(type)?.listener(event); return event;
    } };
}

test('layer keeps anchor and portal interactions, captures outside presses and uses current callbacks', async t => {
  const { installDismissibleLayer } = await loadGuiModule(t, '/src/components/shared/useDismissibleLayer.ts');
  const { owner, listeners, element, dispatch } = fixture(t);
  const anchor = element(), portal = element(), option = element(), outside = element(); portal.children.push(option);
  const calls = [];
  let current = { regions: [anchor, portal], dismiss: reason => calls.push(reason) };
  const stop = installDismissibleLayer(owner, () => current); t.after(stop);
  assert.equal(listeners.get('pointerdown').capture, true, 'outside stopPropagation must not prevent dismissal');
  for (const target of [anchor, portal, option]) { dispatch('pointerdown', target); dispatch('focusin', target); }
  dispatch('pointerdown', outside, { composedPath: () => [option, portal, outside] });
  assert.deepEqual(calls, [], 'composed portal path is inside');
  option.focus(); dispatch('pointerdown', outside);
  assert.deepEqual(calls, ['pointer-outside']); assert.equal(owner.activeElement, owner.body);
  current = { regions: [anchor, portal], dismiss: reason => { calls.push('new:' + reason); outside.focus(); } };
  option.focus(); dispatch('pointerdown', outside);
  assert.equal(owner.activeElement, outside, 'cleanup cannot blur a newer focus');
  dispatch('focusin', outside);
  assert.deepEqual(calls, ['pointer-outside', 'new:pointer-outside', 'new:focus-outside']);
  stop(); assert.equal(listeners.size, 0, 'unmount removes every listener');
});

test('Tab leaving the final portal item closes without a focusin, but a render blur does not', async t => {
  const { installDismissibleLayer } = await loadGuiModule(t, '/src/components/shared/useDismissibleLayer.ts');
  const { owner, element, dispatch } = fixture(t);
  const panel = element(), option = element(), calls = []; panel.children.push(option);
  const stop = installDismissibleLayer(owner, () => ({ regions: [panel], dismiss: reason => calls.push(reason) })); t.after(stop);
  dispatch('focusout', option, { relatedTarget: null }); assert.deepEqual(calls, [], 'render or disabled blur is not navigation');
  dispatch('keydown', option, { key: 'Tab' }); dispatch('focusout', option, { relatedTarget: panel }); dispatch('focusin', panel);
  assert.deepEqual(calls, [], 'internal navigation stays open');
  dispatch('keydown', option, { key: 'Tab' }); dispatch('focusout', option, { relatedTarget: null });
  assert.deepEqual(calls, ['focus-outside']);
  dispatch('keydown', option, { key: 'Tab', defaultPrevented: true }); dispatch('focusout', option, { relatedTarget: null });
  assert.deepEqual(calls, ['focus-outside'], 'locally handled Tab keeps its own semantics');
});

test('hover help can dismiss before a parent even when its anchor is not focused', async t => {
  const { installDismissibleLayer } = await loadGuiModule(t, '/src/components/shared/useDismissibleLayer.ts');
  const { owner, listeners, element, dispatch } = fixture(t);
  const trigger = element(), tooltip = element(), calls = [];
  const stop = installDismissibleLayer(owner, () => ({ regions: [trigger, tooltip], escapeCapture: true, dismiss: reason => calls.push(reason) })); t.after(stop);
  assert.equal(listeners.get('keydown').capture, true);
  assert.equal(owner.activeElement, owner.body);
  const event = dispatch('keydown', owner.body, { key: 'Escape' });
  assert.deepEqual(calls, ['escape']); assert.equal(event.stopped, true); assert.equal(owner.activeElement, owner.body);
  stop(); assert.equal(listeners.size, 0);
});

test('Escape respects inner handlers, IME and repeats; background layers do not dismiss native dialogs', async t => {
  const { installDismissibleLayer } = await loadGuiModule(t, '/src/components/shared/useDismissibleLayer.ts');
  const { owner, dialogs, element, dispatch } = fixture(t);
  const root = element(), outside = element(), modal = element(), calls = [];
  const stop = installDismissibleLayer(owner, () => ({ regions: [root], dismiss: reason => calls.push(reason) })); t.after(stop);
  for (const details of [{ key: 'Enter' }, { key: 'Escape', defaultPrevented: true }, { key: 'Escape', repeat: true }, { key: 'Escape', isComposing: true }]) dispatch('keydown', root, details);
  assert.deepEqual(calls, []);
  const escape = dispatch('keydown', root, { key: 'Escape' });
  assert.deepEqual(calls, ['escape']); assert.equal(escape.defaultPrevented, true); assert.equal(escape.stopped, true);
  dialogs.push(modal);
  dispatch('pointerdown', outside); dispatch('focusin', outside); dispatch('keydown', outside, { key: 'Escape' });
  assert.deepEqual(calls, ['escape'], 'background popovers leave the native modal alone');
  modal.children.push(root);
  dispatch('keydown', root, { key: 'Escape' }); assert.deepEqual(calls, ['escape', 'escape'], 'a popover inside a dialog retains its own Escape');
});
