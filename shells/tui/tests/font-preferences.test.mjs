import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { DEFAULT_USER_SETTINGS } from '../../../userspace/protocol/dist/index.js';
import { BUILTIN_FONTS, fontPreference, shellQuote, windowArguments } from '../macos/font-preferences.mjs';

test('TUI follows GUI defaults and the terminal group without writing another preference', () => {
  assert.deepEqual(fontPreference({}, DEFAULT_USER_SETTINGS), {
    family: 'warm', name: 'DeepCodeQuietTerminalReadingSC-Regular', file: 'DeepCodeQuietTerminalReadingSC-Regular.ttf', size: 12,
  });
  const settings = { 'gui.fontFamily': 'warm-sans', 'gui.terminalFontFamily': 'inherit', 'gui.codeFontSize': 14 };
  const original = structuredClone(settings);
  assert.equal(fontPreference(settings, DEFAULT_USER_SETTINGS).name, 'DeepCodeQuietTerminalReadingSansSC-Regular');
  assert.equal(fontPreference({ ...settings, 'gui.terminalFontFamily': 'compact-kai' }, DEFAULT_USER_SETTINGS).name, 'DeepCodeQuietTerminalMonoKaiSC-Regular');
  assert.equal(fontPreference(settings, DEFAULT_USER_SETTINGS, 'compact').name, 'DeepCodeQuietTerminalMonoSC-Regular');
  assert.equal(fontPreference(settings, DEFAULT_USER_SETTINGS, 'system').name, 'Menlo-Regular');
  assert.deepEqual(settings, original);
  for (const family of Object.keys(BUILTIN_FONTS)) {
    const selected = fontPreference(settings, DEFAULT_USER_SETTINGS, family);
    assert.equal(selected.file, `${selected.name}.ttf`);
    assert.equal(selected.size, 14);
  }
});

test('window options preserve TUI arguments and reject unavailable font selections', () => {
  assert.deepEqual(windowArguments(['--font', 'compact', '-C', '/tmp/项目 A', '--plugin', 'plugin://tools']), {
    font: 'compact', inPlace: false, forward: ['-C', '/tmp/项目 A', '--plugin', 'plugin://tools'],
  });
  assert.deepEqual(windowArguments(['--in-place', '--smoke']), { font: 'follow', inPlace: true, forward: ['--smoke'] });
  assert.throws(() => windowArguments(['--font']));
  assert.throws(() => windowArguments(['--font', 'unavailable']));
  assert.throws(() => fontPreference({}, DEFAULT_USER_SETTINGS, 'unavailable'));
  assert.throws(() => fontPreference({ 'gui.codeFontSize': 0 }, DEFAULT_USER_SETTINGS));
  assert.throws(() => fontPreference({ 'gui.fontFamily': '' }, DEFAULT_USER_SETTINGS));
});

test('the dedicated window command preserves spaces quotes and literal shell syntax', () => {
  const values = ['/Applications/测试 app/node', "it's a path", '$(printf unexpected)', '`printf unexpected`', 'a\nb'];
  const output = execFileSync('/bin/sh', ['-c', `printf '%s\\0' ${values.map(shellQuote).join(' ')}`]);
  assert.deepEqual(output.toString().split('\0').slice(0, -1), values);
});
