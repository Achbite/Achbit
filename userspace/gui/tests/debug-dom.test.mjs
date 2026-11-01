import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';

const script = await readFile(new URL('../../../shells/shared/native_browser/debug_dom.js', import.meta.url), 'utf8');
function bridge({ text = '', list = () => [], call = async () => ({ dispatched: true }), callAction, querySelectorAll = () => [], readText = () => text, documentProps = {}, globals = {} } = {}) {
  const document = { body: { get innerText() { return readText(); } }, readyState: 'complete', title: 'Debug fixture',
    querySelector: () => null, querySelectorAll, ...documentProps };
  const window = { addEventListener() {}, __ACHBIT_DEBUG_UI__: { list, call, callAction } };
  const context = vm.createContext({ document, window, location: { href: 'fixture:' },
    innerWidth: 800, innerHeight: 600, scrollX: 0, scrollY: 0, performance,
    setTimeout, clearTimeout, requestAnimationFrame: callback => setTimeout(callback, 1), cancelAnimationFrame: clearTimeout, ...globals });
  vm.runInContext(script, context);
  return window.__ACHBIT_DEBUG_DOM__;
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

test('ambiguous selectors fail before dispatch instead of choosing the first matching element', async () => {
  const dom = bridge({ querySelectorAll: selector => selector === '.duplicate' ? [{}, {}] : [] });
  await assert.rejects(dom.dispatch({ name: 'click', args: { selector: '.duplicate' } }), /debug_element_ambiguous/);
});


test('component waits report ambiguity without discarding an already executed action', async () => {
  const dom = bridge({ list: () => [{ id: 'duplicate' }, { id: 'duplicate' }],
    call: async () => ({ result: 'owner-result', businessCompletion: 'not-asserted' }) });
  const result = await dom.dispatch({ name: 'plugin.action', args: { componentId: 'unique', action: 'updateDraft',
    waitFor: { componentId: 'duplicate', timeoutMs: 20 } } });
  assert.equal(result.result.result, 'owner-result');
  assert.equal(result.condition.matched, false);
  assert.match(result.condition.error, /debug_component_ambiguous/);
  assert.equal(result.completion, 'observation-incomplete');
});

test('diagnostic overlay is excluded from product text and its visibility is restored', async () => {
  const overlay = { hidden: false };
  const dom = bridge({ readText: () => overlay.hidden ? 'Product text' : 'Product text\nDiagnostic owner label',
    querySelectorAll: selector => selector === '[data-achbit-diagnostic]' ? [overlay] : [] });
  const result = await dom.dispatch({ name: 'inspect' });
  assert.equal(result.text, 'Product text');
  assert.equal(overlay.hidden, false);
  overlay.hidden = true;
  assert.equal((await dom.dispatch({ name: 'inspect' })).text, 'Product text');
  assert.equal(overlay.hidden, true);
});

test('semantic DOM actions click the real target and observe its state without claiming trusted input', async () => {
  let clicks = 0, hit, mounted = [], expanded = false, disabled = false;
  const control = (id, activityId) => ({ id, nodeType: 1, localName: 'button',
    dataset: { uiAction: 'conversation.tool.toggle', uiActionKind: 'click', uiTarget: JSON.stringify({ sessionId: 'session:a', activityId }) },
    getAttribute: name => name === 'aria-expanded' ? String(expanded) : null,
    closest: selector => selector.startsWith(':disabled') && disabled ? {} : null,
    getBoundingClientRect: () => ({ x: 1, y: 2, width: 30, height: 20 }),
    scrollIntoView() { hit = this; }, dispatchEvent: () => true, focus() {}, contains: () => false,
    click() { clicks++; expanded = !expanded; } });
  const a = control('a', 'activity:a'), b = control('b', 'activity:b');
  mounted = [a, b];
  const dom = bridge({ querySelectorAll: selector => selector === '[data-ui-action]' ? mounted : mounted.filter(item => `#${item.id}` === selector),
    documentProps: { elementFromPoint: () => hit }, globals: {
      CSS: { escape: value => value }, getComputedStyle: () => ({ display: 'block', visibility: 'visible' }),
      PointerEvent: class {}, MouseEvent: class {},
    } });
  const catalog = await dom.dispatch({ name: 'actions' });
  assert.equal(catalog.coverage, 'declared-interactions-only');
  assert.equal(catalog.actions.length, 2);
  await assert.rejects(dom.dispatch({ name: 'ui.action', args: { actionId: 'conversation.tool.toggle' } }), /target_ambiguous/);
  const target = { sessionId: 'session:a', activityId: 'activity:b' };
  const result = await dom.dispatch({ name: 'ui.action', args: { actionId: 'conversation.tool.toggle', target,
    waitFor: { actionId: 'conversation.tool.toggle', target, attribute: 'aria-expanded', equals: 'true' } } });
  assert.equal(hit, b);
  assert.equal(clicks, 1);
  assert.equal(result.condition.matched, true);
  assert.equal(result.action.execution, 'dom.click');
  assert.equal(result.action.trustedNativeInput, false);
  assert.equal(result.businessCompletion, 'not-asserted');
  disabled = true;
  await assert.rejects(dom.dispatch({ name: 'ui.action', args: { actionId: 'conversation.tool.toggle', target } }), /element_disabled/);
  mounted = [a];
  await assert.rejects(dom.dispatch({ name: 'ui.action', args: { actionId: 'conversation.tool.toggle', target } }), /not_mounted/);
  assert.equal(clicks, 1);
});

test('semantic callback actions use declared availability and keep callback execution explicit', async () => {
  let available = false, calls = 0;
  const dom = bridge({ list: () => [{ id: 'mounted-navigation', ownerId: 'region.navigation', target: {}, actions: [{
    name: 'activateSession', actionId: 'region.navigation.activateSession', execution: 'component.callback',
    availability: available ? 'available' : 'not-declared',
  }] }], callAction: async (actionId, target, args) => {
    calls++; assert.equal(actionId, 'region.navigation.activateSession'); assert.equal(Object.keys(target).length, 0); assert.equal(args[0], 'session:a');
    return { completion: 'handler-resolved', businessCompletion: 'session-loaded' };
  } });
  const request = { name: 'ui.action', args: { actionId: 'region.navigation.activateSession', arguments: ['session:a'] } };
  await assert.rejects(dom.dispatch(request), /availability_not_declared/);
  assert.equal(calls, 0);
  available = true;
  const result = await dom.dispatch(request);
  assert.equal(result.action.execution, 'component.callback');
  assert.equal(result.businessCompletion, 'session-loaded');
  assert.equal(calls, 1);
});
