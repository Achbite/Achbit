import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const script = await readFile(new URL('../../../shells/shared/native_browser/debug_dom.js', import.meta.url), 'utf8');
function bridge({ text = '', list = () => [], call = async () => ({ dispatched: true }) } = {}) {
  const document = { body: { innerText: text }, readyState: 'complete', title: 'Debug fixture',
    querySelector: () => null, querySelectorAll: () => [] };
  const window = { addEventListener() {}, __DEEPCODE_DEBUG_UI__: { list, call } };
  const context = vm.createContext({ document, window, location: { href: 'fixture:' },
    innerWidth: 800, innerHeight: 600, scrollX: 0, scrollY: 0, performance,
    setTimeout, clearTimeout, requestAnimationFrame: callback => setTimeout(callback, 1), cancelAnimationFrame: clearTimeout });
  vm.runInContext(script, context);
  return window.__DEEPCODE_DEBUG_DOM__;
}

test('a timed-out observation preserves the executed action and original condition error', async () => {
  let calls = 0;
  const dom = bridge({ call: async () => { calls++; return { completion: 'handler-resolved', businessCompletion: 'not-asserted', result: 'executed' }; } });
  const result = await dom.dispatch({ name: 'plugin.action', args: { componentId: 'editor', action: 'submitDraft',
    waitFor: { componentId: 'missing', timeoutMs: 5 } } });
  assert.equal(calls, 1);
  assert.equal(result.result.result, 'executed');
  assert.equal(result.condition.matched, false);
  assert.match(result.condition.error, /debug_wait_condition_timeout/);
  assert.equal(result.completion, 'observation-incomplete');
  assert.equal(result.businessCompletion, 'not-asserted');
  assert.equal(result.timing.rendered, true);
  assert.equal(result.after.title, 'Debug fixture');
});

test('component waits observe owner state updates without a DOM mutation', async () => {
  let active = null;
  const dom = bridge({ list: () => [{ id: 'navigation', input: { data: { active } } }],
    call: async () => { setTimeout(() => { active = 'selected'; }, 5); return { businessCompletion: 'not-asserted' }; } });
  const result = await dom.dispatch({ name: 'plugin.action', args: { componentId: 'navigation', action: 'activateSession',
    waitFor: { componentId: 'navigation', path: ['data', 'active'], equals: 'selected', timeoutMs: 100 } } });
  assert.equal(result.condition.matched, true);
  assert.equal(result.after.components[0].input.data.active, 'selected');
  assert.equal(result.completion, 'ui-observed');
  assert.equal(result.businessCompletion, 'not-asserted', 'an explicit state condition does not invent a Session terminal fact');
});

test('bounded text inspection declares truncation and makes the action observation partial', async () => {
  const dom = bridge({ text: 'x'.repeat(64001) });
  const result = await dom.dispatch({ name: 'wait' });
  assert.equal(result.after.text.length, 64000);
  assert.equal(result.after.coverage.text, 'truncated');
  assert.equal(result.after.coverage.elements, 'complete');
  assert.equal(result.completion, 'observation-incomplete');
});
