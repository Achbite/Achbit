import test from 'node:test';
import assert from 'node:assert/strict';
import { loadGuiModules } from './gui-projection-contract.mjs';

test('GUI slash menu discovers actions and leaves paths and ordinary messages alone', async t => {
  const [commands] = await loadGuiModules(t, ['/src/components/local-agent/composerCommands.ts']);
  const all = commands.suggestComposerCommands('/').map(item => item.id);
  for (const name of ['focus', 'new', 'model', 'context', 'permissions', 'attach', 'plugins', 'agents', 'cancel', 'help']) {
    assert.ok(all.includes(name), name);
  }
  assert.deepEqual(commands.suggestComposerCommands('/mo').map(item => item.id), ['model']);
  for (const draft of ['ordinary text', '/remote/workspace/file.txt', '/focus fix the error', '/model ', ' /mo', '\t/mo']) {
    assert.deepEqual(commands.suggestComposerCommands(draft), [], draft);
  }
  assert.deepEqual(commands.parseComposerCommand('/model'), { name: 'model', argument: '' });
  assert.deepEqual(commands.parseComposerCommand('/focus fix\nthe error'), { name: 'focus', argument: 'fix\nthe error' });
  for (const draft of ['/remote/workspace/file.txt', '/api/v1', '/tmp', '/unknown', '/unknown 请解释这个名字',
    '/model 是什么意思？', '/new explain', '/focusdir', ' /new', '\t/focus task', 'explain /model']) {
    assert.equal(commands.parseComposerCommand(draft), null, draft);
  }
  assert.deepEqual(commands.parseComposerCommand('/new  '), { name: 'new', argument: '' });
});

test('GUI commands dispatch existing actions without sending model prompts or cancelling on view change', async t => {
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const [{ useLocalAgentStore: store }, { useAgentComposer }] = await loadGuiModules(t, [
    '/src/state/localAgentStore.ts', '/src/components/local-agent/useAgentComposer.ts',
  ]);
  const previousStorage = globalThis.sessionStorage;
  let draft = '/new', composer, sent = 0, cancelled = 0;
  globalThis.sessionStorage = {
    getItem: () => JSON.stringify({ draft, pastedTexts: [], pastedImages: [], filesystemPaths: [], pluginSelections: [] }),
    setItem(_key, value) { draft = JSON.parse(value).draft; },
  };
  t.after(() => { if (previousStorage === undefined) delete globalThis.sessionStorage; else globalThis.sessionStorage = previousStorage; });
  store.setState({ sessionId: 'session:remote', projection: { run: { status: 'running' }, plans: [] },
    profiles: [], selectedProfileId: null, cancelRun: async () => { cancelled++; }, sendMessage: async () => { sent++; } });
  function Probe() { composer = useAgentComposer('zh-CN', () => {}); return null; }
  function render() { Object.assign(store.getInitialState(), store.getState()); renderToStaticMarkup(createElement(Probe)); }
  render();
  assert.equal(composer.canSend, true, 'GUI commands do not require a model');
  await composer.submitDraft();
  assert.equal(store.getState().sessionId, null);
  assert.equal(cancelled, 0);
  assert.equal(sent, 0);
  draft = '/cancel';
  store.setState({ sessionId: 'session:remote', projection: { run: { status: 'running' }, plans: [] } });
  render();
  await composer.submitDraft();
  assert.equal(cancelled, 1);
  assert.equal(sent, 0);
  draft = '/cancel';
  store.setState({ cancelRun: async () => { throw new Error('cancel rejected'); } });
  render();
  await composer.submitDraft();
  assert.equal(draft, '/cancel', 'a matched action failure keeps the draft');
  assert.equal(sent, 0, 'a failed command never falls through to chat');
});
