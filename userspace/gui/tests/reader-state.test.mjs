import test from 'node:test';
import assert from 'node:assert/strict';
import { loadGuiModule } from './gui-projection-contract.mjs';

async function setup(t) {
  const previous = globalThis.sessionStorage;
  const values = new Map();
  globalThis.sessionStorage = {
    getItem: key => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
  };
  t.after(() => {
    if (previous === undefined) delete globalThis.sessionStorage;
    else globalThis.sessionStorage = previous;
  });
  return loadGuiModule(t, '/src/components/local-agent/readerState.ts');
}

const diff = { kind: 'diff', file: { path: 'example.ts', changes: [{ recordId: 'record:diff', index: 0 }] } };

for (const target of [diff, { kind: 'file', path: '/workspace/example.ts' }]) {
  test(`restoring a collapsed ${target.kind} keeps its tab without revealing the Reader`, async t => {
    const { saveViewState, readReaderViewState, readerTargetKey } = await setup(t);
    saveViewState('session:a:selection', target);
    saveViewState('session:a:visible', false);
    saveViewState('session:b:selection', { kind: 'file', path: '/workspace/other.ts' });
    saveViewState('session:b:visible', true);
    assert.equal(readReaderViewState('session:b').visible, true);
    const restored = readReaderViewState('session:a');
    assert.equal(restored.visible, false, 'switching away and back must not act like opening a file');
    assert.equal(restored.activeId, readerTargetKey(target));
    assert.deepEqual(restored.tabs, [{ id: readerTargetKey(target), target }]);
    assert.equal(restored.expanded, false);
    saveViewState('session:a:visible', true);
    assert.equal(readReaderViewState('session:a').visible, true, 'explicit reopening can still be restored');
  });
}

test('closing the selected diff does not recreate it and new conversations start closed', async t => {
  const { saveViewState, readReaderViewState } = await setup(t);
  saveViewState('session:a:selection', diff);
  saveViewState('session:a:selection', null);
  saveViewState('session:a:visible', false);
  for (const sessionId of ['session:a', 'session:new', null]) {
    assert.deepEqual(readReaderViewState(sessionId), { sessionId, tabs: [], activeId: null, visible: false, expanded: false });
  }
});

test('browser selection is reconciled with live native pages without overriding collapsed visibility', async t => {
  const { saveViewState, readReaderViewState, reconcileReaderPages } = await setup(t);
  const selection = { kind: 'browser', previewId: 'preview:one' };
  saveViewState('session:a:selection', selection);
  saveViewState('session:a:visible', false);
  const restored = readReaderViewState('session:a');
  assert.deepEqual(restored.tabs, [], 'only the Host can establish a live native page');
  const reconciled = reconcileReaderPages(restored, [{ previewId: 'preview:one', sessionId: 'session:a', status: 'ready' }], selection);
  assert.equal(reconciled.activeId, 'browser:preview:one');
  assert.equal(reconciled.visible, false);
});

test('only explicitly closing the selected native page selects the remaining file in either event order', async t => {
  const { reconcileReaderPages, selectReaderTarget, readReaderViewState, removeReaderTab } = await setup(t);
  const session = 'session:read';
  const file = selectReaderTarget(readReaderViewState(session), session, { kind: 'file', path: '/docs/report.html' });
  const page = selectReaderTarget(file, session, { kind: 'browser', previewId: 'preview:report' });
  const disappeared = reconcileReaderPages(page, []);
  assert.deepEqual([disappeared.tabs, disappeared.activeId], [file.tabs, null]);
  for (const closed of [removeReaderTab(disappeared, page.activeId, true),
    reconcileReaderPages(removeReaderTab(page, page.activeId, true), [])]) {
    assert.deepEqual([closed.tabs, closed.activeId], [file.tabs, file.activeId]);
  }
  const start = removeReaderTab({ ...page, activeId: null }, page.activeId, false);
  assert.deepEqual([start.tabs, start.activeId], [file.tabs, null]);
});

// TCR: .task-artifacts/browser-interaction-20261117/TCR.md.
test('file-backed output and body links open the same file target as the file tree', async t => {
  const { artifactReaderTarget, selectReaderTarget, readerTargetKey, readReaderViewState } = await setup(t);
  const artifact = { artifactId: 'artifact:first', sessionId: 'session:a', contentMode: 'fixed', contentType: 'text/markdown',
    label: 'report.md', workspaceId: 'workspace:a', logicalPath: 'reviews/report.md' };
  const anotherReference = { ...artifact, artifactId: 'artifact:another', resourceKey: 'resource:report' };
  const file = { kind: 'workspace', workspaceId: 'workspace:a', logicalPath: 'reviews/report.md' };
  const before = structuredClone([artifact, anotherReference]);
  assert.deepEqual(artifactReaderTarget(artifact), file);
  assert.deepEqual(artifactReaderTarget(anotherReference), file, 'archive identity does not create another file tab');
  let state = selectReaderTarget(readReaderViewState('session:a'), 'session:a', artifactReaderTarget(artifact));
  state = selectReaderTarget(state, 'session:a', artifactReaderTarget(anotherReference));
  state = selectReaderTarget(state, 'session:a', file);
  assert.equal(state.tabs.length, 1);
  assert.deepEqual(state.tabs[0].target, file);
  assert.equal(state.activeId, readerTargetKey(file));
  assert.deepEqual([artifact, anotherReference], before, 'routing a file link does not rewrite archived facts');
});

test('file routing distinguishes workspaces and paths while archive-only and explicit interactive outputs retain their existing viewers', async t => {
  const { artifactReaderTarget, selectReaderTarget, readReaderViewState, readerTargetKey } = await setup(t);
  const artifact = { artifactId: 'artifact:report', sessionId: 'session:a', contentMode: 'fixed', contentType: 'text/html',
    label: 'report.html', workspaceId: 'workspace:a', logicalPath: 'one/report.html' };
  const target = artifactReaderTarget(artifact);
  for (const other of [
    { ...artifact, logicalPath: 'two/report.html' },
    { ...artifact, workspaceId: 'workspace:b' },
  ]) {
    const first = selectReaderTarget(readReaderViewState('session:a'), 'session:a', target);
    assert.equal(selectReaderTarget(first, 'session:a', artifactReaderTarget(other)).tabs.length, 2,
      'same names in different file locations remain distinct');
  }
  const archived = { artifactId: 'artifact:bytes', sessionId: 'session:a', label: 'report.html' };
  assert.deepEqual(artifactReaderTarget(archived), { kind: 'artifact', artifact: archived }, 'a file path is never guessed from a label');
  assert.notEqual(readerTargetKey(target), readerTargetKey({ kind: 'artifact', artifact, interactive: true }),
    'an explicitly requested interactive component is not converted into a static file view');
});

test('the Reader reuses one physical file across manual picks, tree, body links and overlapping workspaces', async t => {
  const { readReaderViewState, selectReaderTarget, identifyReaderFiles } = await setup(t);
  const session = 'session:main', canonical = '/private/tmp/project/notes/a.txt';
  const picked = { kind: 'file', path: '/tmp/project/notes/a.txt' };
  const tree = { kind: 'resource', name: 'a.txt', resource: { workspaceId: 'root', logicalPath: 'notes/a.txt' } };
  const body = { kind: 'workspace', workspaceId: 'nested', logicalPath: 'a.txt', line: 4, column: 3 };
  const ownerIds = [];
  const identify = async (owner, target) => {
    ownerIds.push(owner);
    return target.kind === 'workspace' && target.workspaceId === 'other-folder' ? '/elsewhere/a.txt' : canonical;
  };
  async function open(state, target) {
    const { located, restored } = await identifyReaderFiles(session, target, state.tabs, identify);
    return selectReaderTarget(state, session, located, true, restored);
  }
  for (const order of [[picked, tree, body], [body, tree, picked], [tree, picked, body]]) {
    let state = readReaderViewState(session);
    for (const target of order) state = await open(state, target);
    assert.equal(state.tabs.length, 1);
    const first = state.activeId;
    state = await open(state, { ...body, line: 9, column: 2 });
    assert.equal(state.activeId, first);
    assert.deepEqual([state.tabs[0].target.line, state.tabs[0].target.column], [9, 2]);
    state = await open(state, picked);
    assert.equal(state.activeId, first);
    assert.equal(state.tabs[0].target.kind, 'workspace', 'reuse keeps the existing bound read');
    state = await open(state, { ...body, workspaceId: 'other-folder' });
    assert.equal(state.tabs.length, 2, 'distinct files with the same name remain separate');
    state = await open(state, { ...body, sourceSessionId: 'session:child' });
    assert.equal(state.tabs.length, 3, 'even the same physical file retains its owning Session');
  }
  assert.ok(ownerIds.includes('session:child'));
});

test('concurrent opens retain the latest position, and restored paths resolve before tab reuse', async t => {
  const { readReaderViewState, selectReaderTarget, identifyReaderFiles, saveViewState } = await setup(t);
  const session = 'session:restore';
  const legacy = { kind: 'file', path: '/tmp/习题/a.ts' };
  const link = { kind: 'workspace', workspaceId: 'root', logicalPath: '习题/a.ts', line: 8, column: 2 };
  const canonical = '/private/tmp/习题/a.ts';
  saveViewState(session + ':selection', legacy);
  let state = readReaderViewState(session);
  const { located, restored } = await identifyReaderFiles(session, link, state.tabs, async () => canonical);
  state = selectReaderTarget(state, session, located, true, restored);
  const current = state.activeId;
  const older = { ...located, line: 2, column: 1 };
  state = selectReaderTarget(state, session, older, false);
  assert.equal(state.tabs.length, 1);
  assert.equal(state.activeId, current);
  assert.equal(state.tabs[0].target.line, 8);
  state = selectReaderTarget(state, session, { ...older, canonicalPath: '/different/a.ts' }, false);
  assert.equal(state.tabs.length, 2, 'a different, slower open still gets its own tab');
  assert.equal(state.activeId, current);
  const original = new Error('Host denied the requested file');
  await assert.rejects(identifyReaderFiles(session, link, state.tabs, async () => { throw original; }), error => error === original);
});

test('reopening a file selects its existing tab and preserves unrelated tabs and layout', async t => {
  const { selectReaderTarget, readerTargetKey } = await setup(t);
  const file = { kind: 'workspace', workspaceId: 'workspace:a', logicalPath: 'A.md' };
  const unrelated = { id: 'file:/notes.txt', target: { kind: 'file', path: '/notes.txt' } };
  const state = { sessionId: 'session:a', visible: true, expanded: true, activeId: unrelated.id,
    tabs: [unrelated, { id: readerTargetKey(file), target: file }] };
  const selected = selectReaderTarget(state, 'session:a', { ...file });
  assert.deepEqual(selected.tabs, state.tabs);
  assert.equal(selected.activeId, readerTargetKey(file));
  assert.equal(selected.expanded, true);
  assert.equal(state.activeId, unrelated.id);
});
