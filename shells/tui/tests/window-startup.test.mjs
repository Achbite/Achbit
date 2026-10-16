import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { tmpdir } from 'node:os';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { closeFinishedWindow, launchWindow, native, runInCurrentWindow } from '../macos/window.mjs';

const font = { name: 'DeepCodeQuietTerminalMonoSC-Regular', size: 12 };
const owner = { windowId: 42, tty: '/dev/ttys-test' };
async function fixture(t) {
  const temporary = await mkdtemp(join(tmpdir(), 'deepcode-window-test-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  return { font, args: [], binary: '/unused/tui', cwd: temporary, environment: {}, temporary };
}

test('native errors retain the failed stage and original timeout diagnostics', () => {
  const cause = Object.assign(new Error('spawnSync /usr/bin/osascript ETIMEDOUT'), { code: 'ETIMEDOUT', stderr: Buffer.from('Apple event did not return') });
  for (const [action, stage] of [['prepare', 'font preparation'], ['create', 'Terminal window creation'], ['apply', 'window font application']]) {
    assert.throws(() => native(action, {}, () => { throw cause; }), error => {
      assert.equal(error.cause, cause);
      assert.ok(error.message.includes(stage));
      assert.ok(error.message.includes('ETIMEDOUT'));
      assert.ok(error.message.includes('Apple event did not return'));
      return true;
    });
  }
});

test('launcher waits for the ready frame, not font application or the release file', async t => {
  const config = await fixture(t);
  let folder;
  let applied;
  const application = new Promise(resolve => { applied = resolve; });
  let finished = false;
  const pending = launchWindow(config, async (action, value) => {
    if (action === 'create') { folder = dirname(value.ownerPath); return owner; }
    if (action === 'apply') applied();
    return {};
  }).then(code => { finished = true; return code; });
  await application;
  assert.equal(finished, false);
  assert.equal((await readFile(join(folder, 'launch.json'), 'utf8')).includes('/unused/tui'), true);
  await writeFile(join(folder, 'rendered.json'), JSON.stringify({ pid: 123 }));
  assert.equal(await pending, 0);
  assert.equal(await readFile(join(folder, 'accepted'), 'utf8'), '');
});

test('partial creation preserves ownership and closes only that window on failure', async t => {
  const config = await fixture(t);
  const closed = [];
  await assert.rejects(launchWindow(config, async (action, value) => {
    if (action === 'create') {
      await writeFile(value.ownerPath, JSON.stringify(owner));
      await writeFile(join(dirname(value.ownerPath), 'exit.json'), JSON.stringify({ code: 130 }));
      throw new Error('tab lookup failed');
    }
    if (action === 'close') closed.push(value);
    return {};
  }), /Terminal window creation: tab lookup failed/);
  assert.deepEqual(closed, [owner]);
  assert.deepEqual(await readdir(config.temporary), []);
});

test('font failure and child startup failure do not become successful launches', async t => {
  for (const failing of ['apply', 'child']) {
    const config = await fixture(t);
    const closed = [];
    let folder;
    await assert.rejects(launchWindow(config, async (action, value) => {
      if (action === 'create') { folder = dirname(value.ownerPath); return owner; }
      if (action === 'apply') {
        await writeFile(join(folder, 'exit.json'), JSON.stringify({ code: 1, error: 'spawn ENOENT' }));
        if (failing === 'apply') throw new Error('font was not applied');
      }
      if (action === 'close') closed.push(value);
      return {};
    }), failing === 'apply' ? /window font application: font was not applied/ : /TUI initialization and first frame:.*spawn ENOENT/);
    assert.deepEqual(closed, [owner]);
    assert.deepEqual(await readdir(config.temporary), []);
  }
});

test('native bridge records a new window before tab metadata can fail and protects unrelated windows', async () => {
  const source = await readFile(new URL('../macos/font-bridge.js', import.meta.url), 'utf8');
  const records = [];
  const windows = [];
  const closed = [];
  let windowTabs = [{ tty: () => owner.tty }];
  const existing = { id: () => 7, tabs: () => [{ tty: () => '/dev/ordinary' }] };
  const created = { id: () => owner.windowId, tabs: () => windowTabs };
  windows.push(existing);
  const allWindows = Object.assign(() => windows, { id: () => windows.map(w => w.id()) });
  const terminal = {
    running: () => true, windows: allWindows,
    doScript: () => { windows.push(created); return { tty: () => { throw new Error('tty lookup failed'); } }; },
    close: window => closed.push(window.id()),
  };
  const dollar = Object.assign(text => ({ dataUsingEncoding: () => ({ writeToFileAtomically: path => { records.push({ path, owner: JSON.parse(text) }); return true; } }) }), { NSUTF8StringEncoding: 4 });
  const context = vm.createContext({ ObjC: { import() {} }, Application: () => terminal, $: dollar });
  vm.runInContext(source, context);
  assert.throws(() => context.run(['create', JSON.stringify({ command: 'owned launch', ownerPath: '/owned/owner.json' })]), /tty lookup failed/);
  assert.deepEqual(records, [{ path: '/owned/owner.json', owner: { windowId: 42, tty: null } }]);
  context.run(['close', JSON.stringify(owner)]);
  assert.deepEqual(closed, [42]);
  windowTabs = [{ tty: () => owner.tty }, { tty: () => '/dev/ordinary' }];
  assert.throws(() => context.run(['close', JSON.stringify(owner)]), /refusing to close unrelated tabs/);
  assert.deepEqual(closed, [42]);
});

test('the command window runs in its current tty until TUI exit and restores its appearance', async t => {
  const config = { ...await fixture(t), tty: owner.tty, args: ['--api', 'http://127.0.0.1:8123', '--session', 'session:test'] };
  const previous = { ...owner, name: 'Menlo-Regular', size: 13, title: 'my shell' };
  const calls = [];
  const child = new EventEmitter();
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  let finished = false;
  const pending = runInCurrentWindow(config, async (action, value) => {
    calls.push({ action, value });
    if (action === 'capture') return previous;
    return {};
  }, (binary, args, options) => {
    assert.equal(binary, config.binary);
    assert.deepEqual(args, config.args);
    assert.equal(options.stdio, 'inherit');
    assert.equal(options.env.DEEPCODE_TUI_WINDOW_TTY, owner.tty);
    assert.equal(options.env.DEEPCODE_API_URL, 'http://127.0.0.1:8123');
    markStarted();
    return child;
  }).then(code => { finished = true; return code; });
  await started;
  assert.equal(finished, false, 'the wrapper must stay attached to the actual TUI process');
  assert.deepEqual(calls.map(call => call.action), ['prepare', 'capture', 'apply']);
  child.emit('close', 7);
  assert.equal(await pending, 7, 'the TUI exit code reaches the command wrapper');
  assert.deepEqual(calls.at(-1), { action: 'restore', value: previous });
  assert.equal(calls.some(call => ['create', 'close'].includes(call.action)), false);
});

test('a failed font application restores the borrowed tab and preserves the error', async t => {
  const config = { ...await fixture(t), tty: owner.tty };
  const previous = { ...owner, name: 'Menlo-Regular', size: 13, title: '' };
  const failure = new Error('font application timed out');
  const restored = [];
  await assert.rejects(runInCurrentWindow(config, async (action, value) => {
    if (action === 'capture') return previous;
    if (action === 'apply') throw failure;
    if (action === 'restore') restored.push(value);
    return {};
  }, () => assert.fail('TUI cannot start before its font is applied')), error => error === failure);
  assert.deepEqual(restored, [previous]);
});

test('the native bridge borrows only the matching tab and restores its font size and title', async () => {
  const source = await readFile(new URL('../macos/font-bridge.js', import.meta.url), 'utf8');
  function tab(tty, appearance) {
    const value = { tty: () => tty };
    for (const key of ['fontName', 'fontSize', 'customTitle']) Object.defineProperty(value, key, {
      get: () => () => appearance[key], set: next => { appearance[key] = next; },
    });
    return value;
  }
  const initial = { fontName: 'Menlo-Regular', fontSize: 13, customTitle: 'original title' };
  const selected = { ...initial };
  const ordinary = { ...initial, customTitle: 'other shell' };
  let bounds = [40, 50, 900, 600];
  const window = { id: () => owner.windowId, tabs: () => [tab('/dev/ordinary', ordinary), tab(owner.tty, selected)] };
  Object.defineProperty(window, 'bounds', { get: () => () => bounds, set: value => { bounds = value; } });
  const terminal = { running: () => true, windows: () => [window], activate() {} };
  const context = vm.createContext({ ObjC: { import() {} }, Application: () => terminal });
  vm.runInContext(source, context);
  const previous = JSON.parse(context.run(['capture', JSON.stringify({ tty: owner.tty })]));
  assert.deepEqual(previous, { ...owner, name: initial.fontName, size: initial.fontSize, title: initial.customTitle });
  context.run(['apply', JSON.stringify({ ...owner, ...font })]);
  assert.deepEqual(selected, { fontName: font.name, fontSize: font.size, customTitle: 'DeepCode' });
  context.run(['restore', JSON.stringify(previous)]);
  assert.deepEqual(selected, initial);
  assert.deepEqual(ordinary, { ...initial, customTitle: 'other shell' });
  assert.deepEqual(bounds, [40, 50, 900, 600]);
});

test('normal TUI exit restores appearance before scheduling the parent-shell cleanup', async t => {
  const config = { ...await fixture(t), tty: owner.tty };
  const previous = { ...owner, name: 'Menlo-Regular', size: 13, title: 'original' };
  const calls = [];
  const code = await runInCurrentWindow(config, async (action, value) => {
    calls.push(action);
    return action === 'capture' ? previous : {};
  }, () => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit('close', 0));
    return child;
  }, async (target, waitForPid, temporary) => {
    assert.equal(calls.at(-1), 'restore');
    assert.deepEqual(target, previous);
    assert.equal(waitForPid, process.ppid);
    assert.equal(temporary, config.temporary);
    calls.push('schedule');
  });
  assert.equal(code, 0);
  assert.equal(calls.at(-1), 'schedule');
});

test('cleanup waits for its entry to exit and leaves an ordinary live shell alone', async () => {
  let alive = true;
  const closed = [];
  const callNative = async (action, value) => { closed.push({ action, value }); return { closed: true }; };
  const config = { ...owner, waitForPid: 123 };
  assert.deepEqual(await closeFinishedWindow(config, callNative, () => alive, async () => {
    assert.deepEqual(closed, []);
    alive = false;
  }), { closed: true });
  assert.deepEqual(closed, [{ action: 'closeFinished', value: owner }]);
  closed.length = 0;
  assert.deepEqual(await closeFinishedWindow(config, callNative, () => true, async () => {}), { closed: false });
  assert.deepEqual(closed, []);
});

test('finished-window cleanup closes only the original empty single-tab window', async () => {
  const source = await readFile(new URL('../macos/font-bridge.js', import.meta.url), 'utf8');
  const closed = [];
  let processes = ['zsh'];
  const target = { tty: () => owner.tty, busy: () => false, processes: () => processes };
  let tabs = [target];
  const terminal = { running: () => true, windows: () => [
    { id: () => owner.windowId, tabs: () => tabs },
    { id: () => 99, tabs: () => [{ tty: () => '/dev/ordinary', processes: () => ['zsh'] }] },
  ], close: window => closed.push(window.id()) };
  const context = vm.createContext({ ObjC: { import() {} }, Application: () => terminal });
  vm.runInContext(source, context);
  const close = value => JSON.parse(context.run(['closeFinished', JSON.stringify(value)]));
  assert.deepEqual(close(owner), { closed: false }, 'ordinary shell is still running');
  processes = [];
  assert.deepEqual(close({ ...owner, tty: '/dev/different' }), { closed: false });
  tabs = [target, { tty: () => '/dev/ordinary' }];
  assert.deepEqual(close(owner), { closed: false }, 'another tab prevents closing the window');
  assert.deepEqual(closed, []);
  tabs = [target];
  assert.deepEqual(close(owner), { closed: true });
  assert.deepEqual(closed, [owner.windowId]);
});
