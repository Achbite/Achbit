import assert from 'node:assert/strict';

export async function checkComposerPluginMentions({ navigate, evaluate, cmd, frame, click, key, type, record }) {
  await navigate('composer', { pluginMentions: '1' });
  const input = '[data-ui-action="composer.controls.input"]';
  const list = '.local-agent__plugin-picker [role="listbox"]';
  const read = () => evaluate(`(() => {
    const editor = document.querySelector('${input}'), picker = document.querySelector('${list}');
    return { draft: editor.value, caret: editor.selectionStart, open: !!picker?.getClientRects().length,
      options: [...(picker?.querySelectorAll('[role="option"]:enabled') ?? [])].filter(e => e.getClientRects().length).map(e => e.querySelector('b').textContent),
      chips: [...document.querySelectorAll('.local-agent__draft-plugin')].map(e => ({id: e.dataset.attachmentId, label: e.innerText.trim()})),
      sends: JSON.parse(document.querySelector('#mention-sends').textContent) };
  })()`);
  const insert = async text => { await cmd('Input.insertText', { text }); await frame(); };
  const caret = n => evaluate(`document.querySelector('${input}').setSelectionRange(${n}, ${n})`);
  const boundaries = [];
  for (const [text, expectedOpen] of [
    ['@', true], ['请选择 @', true], ['dev@', false], ['dev@example.org', false],
    ['react@18', false], ['https://example.org/@chrome', false],
    ['说明，@', true], ['说明＠', true], ['请检查当前会话能否引用插件，如图所示@', true],
  ]) {
    await type(input, text);
    const { draft, open, options } = await read();
    assert.equal(draft, text, 'the full input reached the production textarea');
    boundaries.push({ text, expectedOpen, open, options });
  }
  const triggersOkay = boundaries.every(row => row.open === row.expectedOpen && (!row.open || row.options.includes('Chrome')));
  await record('composer-plugin-triggers', boundaries, triggersOkay);

  // IME events target the real editor. Keep the compositionend + Enter pair in the same browser task.
  await type(input, '@chr');
  assert.deepEqual((await read()).options, ['Chrome'], 'the IME test starts with a selectable filtered candidate');
  await evaluate(`(() => {
    const editor = document.querySelector('${input}');
    const enter = isComposing => editor.dispatchEvent(new KeyboardEvent('keydown', { key:'Enter', code:'Enter', keyCode:13, isComposing, bubbles:true, cancelable:true }));
    editor.dispatchEvent(new CompositionEvent('compositionstart', { bubbles:true })); enter(true);
    editor.dispatchEvent(new CompositionEvent('compositionend', { bubbles:true })); enter(false);
  })()`); await frame();
  const composition = await read();
  // Some IMEs report only the 229 sentinel, not isComposing, on the confirmation key.
  await evaluate(`document.querySelector('${input}').dispatchEvent(new KeyboardEvent('keydown', { key:'Enter', code:'Enter', keyCode:229, bubbles:true, cancelable:true }))`); await frame();
  const key229 = await read();
  const imeOkay = [composition, key229].every(s => s.draft === '@chr' && s.open && !s.chips.length && !s.sends.length);
  await record('composer-plugin-ime', { composition, key229 }, imeOkay);
  assert.ok(triggersOkay && imeOkay, 'plugin trigger/IME regressions: see the corresponding recorded DOM and send observations');

  const before = '请对照截图说明：', after = '不要改动这段后文。';
  await type(input, before + after); await caret(before.length); await insert('＠chr');
  const filtered = await read();
  assert.deepEqual(filtered.options, ['Chrome'], 'the query at the caret filters the catalog, independently of the following text');
  await click(list + ' [role="option"]');
  const picked = await read(), expectedText = before + '@Chrome ' + after;
  const pickedOkay = picked.draft === expectedText && picked.caret === before.length + '@Chrome '.length && !picked.open
    && picked.chips.length === 1 && !!picked.chips[0].id && picked.chips[0].label === '@Chrome' && !picked.sends.length;
  await record('composer-plugin-caret-selection', { filtered, picked }, pickedOkay);
  assert.ok(pickedOkay, 'choosing a plugin preserves both sides of the draft, returns the caret and does not send');

  await caret(expectedText.length); await insert('@chr');
  assert.deepEqual((await read()).options, ['Chrome']); await key('Enter');
  const repeated = await read();
  assert.equal(repeated.draft, expectedText, 'choosing the same plugin again removes only the new query');
  assert.deepEqual(repeated.chips, picked.chips, 'the original selected identity survives');
  assert.equal(repeated.sends.length, 0, 'Enter selects; it does not also send');
  await click('[data-ui-action="composer.controls.submit"]');
  const { sends } = await read();
  assert.deepEqual(sends, [{ text: expectedText, pluginSelections: [{ selectionId: picked.chips[0].id, uri: 'plugin://chrome-devtools@builtin', label: 'Chrome' }] }],
    'the composer sends the original catalog URI exactly once, not a URI derived from the display label');
  await record('composer-plugin-dedup-send', { repeated, sends }, true);
}
