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
