import test from 'node:test';
import assert from 'node:assert/strict';
import { loadGuiModule } from './gui-projection-contract.mjs';

function documentFixture(t) {
  const saved = Object.fromEntries(['document', 'Element', 'HTMLElement'].map(key => [key, globalThis[key]]));
  const document = { activeElement: null, body: null };
  class Element {
    isConnected = true;
    disabled = false;
    attributes = new Map();
    constructor() { this.ownerDocument = document; }
    focus() { document.activeElement = this; }
    blur() { document.activeElement = document.body; }
    closest() { return this; }
    matches(selector) { return selector === ':disabled' ? this.disabled : false; }
    querySelector() { return null; }
    setAttribute(key, value) { this.attributes.set(key, value); }
    removeAttribute(key) { this.attributes.delete(key); }
    scrollIntoView() { this.revealed = true; }
  }
  document.body = new Element(); document.activeElement = document.body;
  Object.assign(globalThis, { document, Element, HTMLElement: Element });
  t.after(() => Object.assign(globalThis, saved));
  return { document, element: () => new Element() };
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
  interaction.keyDown('Escape');
  interaction.restore(origin);
  assert.equal(document.activeElement, trigger);
  other.focus();
  interaction.restore(origin);
  assert.equal(document.activeElement, other);
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
