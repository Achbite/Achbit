import test from 'node:test';
import assert from 'node:assert/strict';
import { loadGuiModule } from './gui-projection-contract.mjs';

function documentFixture(t) {
  const saved = Object.fromEntries(['document', 'Element', 'HTMLElement'].map(key => [key, globalThis[key]]));
  const listeners = new Map();
  const frames = new Map();
  let nextFrame = 0;
  const document = {
    activeElement: null, body: null,
    defaultView: {
      requestAnimationFrame(callback) { const id = ++nextFrame; frames.set(id, callback); return id; },
      cancelAnimationFrame(id) { frames.delete(id); },
    },
    addEventListener(type, listener, capture) { listeners.set(type, { listener, capture }); },
    removeEventListener(type, listener, capture) {
      if (listeners.get(type)?.listener === listener && listeners.get(type)?.capture === capture) listeners.delete(type);
    },
  };
  class Element {
    isConnected = true;
    disabled = false;
    attributes = new Map();
    children = [];
    constructor(tagName = 'div') { this.ownerDocument = document; this.tagName = tagName; }
    focus() { document.activeElement = this; }
    blur() { document.activeElement = document.body; }
    closest() { return this; }
    contains(other) { return other === this || this.children.includes(other); }
    matches(selector) { return selector === ':disabled' ? this.disabled : selector.split(',').some(part => part.trim() === this.tagName); }
    querySelector() { return null; }
    setAttribute(key, value) { this.attributes.set(key, value); }
    removeAttribute(key) { this.attributes.delete(key); }
    scrollIntoView() { this.revealed = true; }
  }
  document.body = new Element(); document.activeElement = document.body;
  Object.assign(globalThis, { document, Element, HTMLElement: Element });
  t.after(() => Object.assign(globalThis, saved));
  return { document, listeners, frames, element: tag => new Element(tag), flushFrames() {
    const pending = [...frames.values()]; frames.clear(); pending.forEach(callback => callback());
  } };
}

test('settings share pointer/keyboard return rules and do not steal another control focus', async t => {
  const { createInteractionFocus } = await loadGuiModule(t, '/src/components/shared/interactionFocus.ts');
  const { document, element } = documentFixture(t);
  const row = element(), trigger = element(), other = element();
  const interaction = createInteractionFocus();
  row.focus(); // Safari may leave the row focused when a mouse activates its button.
  interaction.pointerDown(trigger);
  const origin = interaction.capture();
  interaction.restore(origin);
  assert.equal(document.activeElement, document.body);
  trigger.focus(); // Native dialog.close() may restore its opener before our cleanup.
  interaction.keyDown('Escape');
  assert.equal(interaction.keyboard, false, 'Escape alone must not turn a pointer interaction into keyboard navigation');
  interaction.restore(origin);
  assert.equal(document.activeElement, document.body);
  interaction.keyDown('Tab');
  interaction.restore(origin);
  assert.equal(document.activeElement, trigger);
  other.focus();
  interaction.restore(origin);
  assert.equal(document.activeElement, other);
});

test('keyboard navigation retains return focus, while a subsequent pointer interaction ends it', async t => {
  const { createInteractionFocus } = await loadGuiModule(t, '/src/components/shared/interactionFocus.ts');
  const { document, element } = documentFixture(t);
  for (const key of ['Tab', 'Enter', ' ', 'ArrowDown', 'ArrowRight']) {
    const interaction = createInteractionFocus();
    const trigger = element();
    interaction.pointerDown(trigger);
    trigger.focus();
    const origin = interaction.capture();
    interaction.keyDown(key);
    document.body.focus();
    interaction.keyDown('Escape');
    interaction.restore(origin);
    assert.equal(document.activeElement, trigger, key);
    interaction.pointerDown(trigger);
    interaction.keyDown('Escape');
    interaction.restore(origin);
    assert.equal(document.activeElement, document.body, key);
  }
});

test('return focus ignores removed or disabled openers and does not steal a newer focus', async t => {
  const { createInteractionFocus } = await loadGuiModule(t, '/src/components/shared/interactionFocus.ts');
  const { document, element } = documentFixture(t);
  const interaction = createInteractionFocus();
  const trigger = element(), other = element();
  trigger.focus();
  const origin = interaction.capture();
  document.body.focus();
  trigger.disabled = true;
  interaction.restore(origin);
  assert.equal(document.activeElement, document.body);
  trigger.disabled = false;
  trigger.isConnected = false;
  interaction.restore(origin);
  assert.equal(document.activeElement, document.body);
  trigger.isConnected = true;
  other.focus();
  interaction.restore(origin);
  assert.equal(document.activeElement, other);
});

test('document capture shares the modality with body and portal controls and removes its listeners', async t => {
  const { createInteractionFocus, installInteractionFocus } = await loadGuiModule(t, '/src/components/shared/interactionFocus.ts');
  const { document, element, listeners } = documentFixture(t);
  const interaction = createInteractionFocus();
  const stop = installInteractionFocus(document, interaction);
  t.after(stop);
  const trigger = element(), portalButton = element();
  assert.equal(listeners.get('pointerdown').capture, true);
  assert.equal(listeners.get('keydown').capture, true);
  listeners.get('pointerdown').listener({ target: trigger });
  const origin = interaction.capture();
  trigger.focus();
  listeners.get('keydown').listener({ key: 'Escape', target: document.body });
  interaction.restore(origin);
  assert.equal(document.activeElement, document.body);
  listeners.get('keydown').listener({ key: 'Tab', target: portalButton });
  interaction.restore(origin);
  assert.equal(document.activeElement, trigger);
  listeners.get('pointerdown').listener({ target: portalButton });
  listeners.get('keydown').listener({ key: 'Escape', target: portalButton });
  assert.equal(interaction.keyboard, false);
  stop();
  assert.equal(listeners.size, 0);
});

test('closing a menu returns only its own focus and respects pointer versus keyboard dismissal', async t => {
  const { createInteractionFocus, returnFocusTo } = await loadGuiModule(t, '/src/components/shared/interactionFocus.ts');
  const { document, element } = documentFixture(t);
  const interaction = createInteractionFocus();
  const trigger = element(), menu = element(), option = element(), other = element();
  menu.children.push(option);
  interaction.pointerDown(trigger);
  option.focus();
  interaction.keyDown('Escape');
  returnFocusTo(trigger, interaction, menu);
  assert.equal(document.activeElement, document.body);
  interaction.keyDown('ArrowDown');
  option.focus();
  interaction.keyDown('Escape');
  returnFocusTo(trigger, interaction, menu);
  assert.equal(document.activeElement, trigger);
  other.focus();
  returnFocusTo(trigger, interaction, menu);
  assert.equal(document.activeElement, other);
  interaction.pointerDown(other);
  returnFocusTo(trigger, interaction, menu);
  assert.equal(document.activeElement, other);
});

test('Escape releases a pointer-focused action after dismissal without disturbing editing or keyboard focus', async t => {
  const { createInteractionFocus, installInteractionFocus } = await loadGuiModule(t, '/src/components/shared/interactionFocus.ts');
  const { document, element, listeners, frames, flushFrames } = documentFixture(t);
  const interaction = createInteractionFocus();
  const stop = installInteractionFocus(document, interaction);
  t.after(stop);
  const pointer = target => { listeners.get('pointerdown').listener({ target }); target.focus(); };
  const key = key => listeners.get('keydown').listener({ key, target: document.activeElement });
  const trigger = element('button'), other = element('button');
  pointer(trigger);
  key('Escape');
  assert.equal(document.activeElement, trigger, 'let the focused control handle dismissal first');
  flushFrames();
  assert.equal(document.activeElement, document.body, 'a surviving pointer trigger must not stay highlighted');

  for (const tag of ['input', 'textarea', 'select']) {
    const editor = element(tag);
    pointer(editor); key('Escape'); flushFrames();
    assert.equal(document.activeElement, editor, tag);
  }
  pointer(trigger); key('Tab'); key('Escape'); flushFrames();
  assert.equal(document.activeElement, trigger, 'keyboard focus remains available');
  pointer(trigger); key('Escape'); key('ArrowDown'); flushFrames();
  assert.equal(document.activeElement, trigger, 'new keyboard navigation cancels pointer cleanup');
  pointer(trigger); key('Escape'); other.focus(); flushFrames();
  assert.equal(document.activeElement, other, 'do not blur a newer focus');
  pointer(trigger); key('Escape'); pointer(trigger); flushFrames();
  assert.equal(document.activeElement, trigger, 'do not blur a new pointer interaction');
  pointer(trigger); key('Escape');
  assert.equal(frames.size, 1);
  stop();
  assert.equal(frames.size, 0, 'dispose cancels pending cleanup');
});

test('search reveal is cleared on the next interaction and moves focus only for keyboard navigation', async t => {
  const { createInteractionFocus } = await loadGuiModule(t, '/src/components/shared/interactionFocus.ts');
  const { document, element } = documentFixture(t);
  const search = element(), row = element();
  search.focus();
  const interaction = createInteractionFocus();
  interaction.pointerDown(search); interaction.reveal(row);
  assert.equal(document.activeElement, search);
  assert.equal(row.revealed, true);
  assert.equal(row.attributes.has('data-settings-revealed'), true);
  interaction.keyDown('Escape');
  assert.equal(row.attributes.has('data-settings-revealed'), false);
  assert.equal(document.activeElement, search);
  assert.equal(interaction.keyboard, false);
  interaction.reveal(row);
  interaction.keyDown('Enter');
  assert.equal(row.attributes.has('data-settings-revealed'), false);
  interaction.reveal(row);
  assert.equal(document.activeElement, row);
  interaction.pointerDown(search);
  assert.equal(row.attributes.has('data-settings-revealed'), false);
});

test('conversation marker follows the newest message at the reading line after layout changes', async t => {
  const { activeConversationAnchor } = await loadGuiModule(t, '/src/components/local-agent/conversationNavigationPosition.ts');
  assert.equal(activeConversationAnchor([], 40), undefined);
  assert.equal(activeConversationAnchor([{ key: 'first', top: 70 }, { key: 'latest', top: 300 }], 40), 'first');
  assert.equal(activeConversationAnchor([{ key: 'first', top: -300 }, { key: 'latest', top: 41 }], 40), 'first');
  assert.equal(activeConversationAnchor([{ key: 'first', top: -301 }, { key: 'latest', top: 40 }], 40), 'latest');
});
