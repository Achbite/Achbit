import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
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

test('code breakout uses intrinsic content width and retains the centered reading-column minimum', async () => {
  const css = await readFile(new URL('../src/components/local-agent/richContent.css', import.meta.url), 'utf8');
  const block = css.match(/\.local-agent__message--assistant \.conversation-markdown > \.conversation-code\s*\{([^}]+)\}/)?.[1];
  assert.ok(block, 'assistant code has its own content-sized breakout rule');
  assert.match(block, /width:\s*max-content;/);
  assert.match(block, /min-width:\s*100%;/);
  assert.match(block, /max-width:\s*min\(1080px, calc\(100cqi - 48px\)\);/);
  assert.match(block, /left:\s*50%;/);
  assert.match(block, /transform:\s*translateX\(-50%\);/);
  assert.doesNotMatch(css, /\.local-agent__message--assistant \.conversation-markdown > :is\([^)]*conversation-code/);
  assert.match(css, /\.conversation-code pre\s*\{[^}]*overflow:\s*auto;[^}]*white-space:\s*pre;/);
});
