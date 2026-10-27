import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, cp, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync, spawnSync } from 'node:child_process';

test('packaged Windows font helper reads settings over stdin and keeps diagnostics off stdout', async t => {
  const root = await mkdtemp(join(tmpdir(), 'achbit font config '));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'tui/macos'), { recursive: true });
  await mkdir(join(root, 'node_modules/@achbit'), { recursive: true });
  await cp(new URL('../font-config.mjs', import.meta.url), join(root, 'tui/font-config.mjs'));
  await cp(new URL('../macos/font-preferences.mjs', import.meta.url), join(root, 'tui/macos/font-preferences.mjs'));
  await symlink(fileURLToPath(new URL('../../../userspace/protocol', import.meta.url)), join(root, 'node_modules/@achbit/protocol'), 'junction');
  const script = join(root, 'tui/font-config.mjs');
  const settings = { 'gui.fontFamily': 'warm-sans', 'gui.terminalFontFamily': 'inherit', 'gui.codeFontSize': 16 };
  const run = choice => JSON.parse(execFileSync(process.execPath, [script, choice], { input: JSON.stringify(settings), encoding: 'utf8' }));
  assert.deepEqual(run('follow'), { family: 'warm-sans', size: 16, name: 'Achbit TUI Reading Sans SC',
    file: join(root, 'tui/fonts/AchbitQuietTerminalReadingSansSC-Regular.ttf') });
  assert.equal(run('compact').name, 'Achbit TUI Mono SC');
  const invalid = spawnSync(process.execPath, [script, 'follow'], { input: 'not json', encoding: 'utf8' });
  assert.notEqual(invalid.status, 0);
  assert.equal(invalid.stdout, '');
  assert.match(invalid.stderr, /Font preference read failed/);
});
