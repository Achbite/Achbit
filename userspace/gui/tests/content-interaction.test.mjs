import test from 'node:test';
import assert from 'node:assert/strict';
import { loadGuiModule } from './gui-projection-contract.mjs';

test('reply Enter submits through its form; newline, composition and repeated keys do not submit', async t => {
  const { submitReplyOnEnter } = await loadGuiModule(t, '/src/components/local-agent/replyKeyboard.ts');
  const event = (overrides = {}) => {
    const calls = { prevented: 0, submitted: 0 };
    return { calls, value: { key: 'Enter', shiftKey: false, altKey: false, ctrlKey: false, metaKey: false,
      repeat: false, nativeEvent: { isComposing: false, keyCode: 13 },
      currentTarget: { disabled: false, form: { requestSubmit() { calls.submitted++; } } },
      preventDefault() { calls.prevented++; }, ...overrides } };
  };
  const enter = event(); submitReplyOnEnter(enter.value);
  assert.deepEqual(enter.calls, { prevented: 1, submitted: 1 });
  for (const overrides of [
    { key: 'a' }, { shiftKey: true }, { altKey: true }, { ctrlKey: true }, { metaKey: true },
    { nativeEvent: { isComposing: true, keyCode: 13 } }, { nativeEvent: { isComposing: false, keyCode: 229 } },
  ]) {
    const sample = event(overrides); submitReplyOnEnter(sample.value);
    assert.deepEqual(sample.calls, { prevented: 0, submitted: 0 });
  }
  const repeated = event({ repeat: true }); submitReplyOnEnter(repeated.value);
  assert.deepEqual(repeated.calls, { prevented: 1, submitted: 0 });
  const disabled = event({ currentTarget: { disabled: true, form: { requestSubmit() { assert.fail('disabled answer submitted'); } } } });
  submitReplyOnEnter(disabled.value);
  assert.equal(disabled.calls.prevented, 1);
});
