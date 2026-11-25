import test from 'node:test';
import assert from 'node:assert/strict';
import { loadGuiModules } from './gui-projection-contract.mjs';

const input = (id, sequence, text = id) => ({ commandId: id, messageId: `message:${id}`, runId: 'run:old', status: 'notApplied', sequence,
  text, filesystemReferences: [], pluginSelections: [], createdAt: '2026-11-07T00:00:00Z' });
const reference = id => ({ referenceId: id, workspaceId: 'input:archive', logicalPath: `${id}.png`, kind: 'file', displayName: id, mediaType: 'image/png', byteLength: 20 });

test('recovery preserves accepted references, guidance and plugins, sorts inputs and deduplicates source identity', async t => {
  const [{ restoreUnappliedInputs }, { emptyComposerState, cloneComposerState }] = await loadGuiModules(t, [
    '/src/components/local-agent/composerRecovery.ts', '/src/components/local-agent/composerSubmission.ts']);
  const one = { ...input('one', 1, 'same text'), filesystemReferences: [reference('image')],
    pluginSelections: [{ selectionId: 'plugin:one', uri: 'plugin://notes@local', label: 'Notes' }],
    guidanceReferences: [{ referenceId: 'guide:one', uri: 'plugin://guide@local', label: 'Guide', toolName: 'skill.read', name: 'guide' }] };
  const two = { ...input('two', 2, 'same text'), filesystemReferences: [reference('image')] };
  const before = structuredClone([one, two]);
  const state = restoreUnappliedInputs(emptyComposerState(), [two, one, one]);
  assert.equal(state.draft, 'same text\n\nsame text', 'equal text in different messages is not duplicate identity');
  assert.deepEqual(state.filesystemReferences, one.filesystemReferences);
  assert.deepEqual(state.guidanceReferences, one.guidanceReferences);
  assert.deepEqual(state.pluginSelections, one.pluginSelections);
  assert.deepEqual(state.filesystemPaths, [], 'archived handles must not be forged into host paths');
  assert.equal(restoreUnappliedInputs(state, [one, two], true), state);
  assert.deepEqual([one, two], before, 'history is never modified');
  const cloned = cloneComposerState(state); cloned.filesystemReferences[0].displayName = 'edited';
  assert.equal(state.filesystemReferences[0].displayName, 'image');
});

test('append confirmation and limits are atomic; undo fingerprint protects newer edits and attachments', async t => {
  const [{ restoreUnappliedInputs, composerContentKey }, { emptyComposerState, cloneComposerState }] = await loadGuiModules(t, [
    '/src/components/local-agent/composerRecovery.ts', '/src/components/local-agent/composerSubmission.ts']);
  const draft = { ...emptyComposerState(), draft: 'Keep my work' };
  assert.throws(() => restoreUnappliedInputs(draft, [input('one', 1)]), /composer_restore_append_confirmation/);
  const state = restoreUnappliedInputs(draft, [input('one', 1)], true);
  assert.equal(state.draft, 'Keep my work\n\none');
  const key = composerContentKey(state), focused = { ...state, focused: false, selectionStart: 0 };
  assert.equal(composerContentKey(focused), key);
  assert.equal(composerContentKey({ ...state, submissionId: 'submission:failed' }), key, 'send ownership does not invalidate a content-preserving Undo');
  assert.notEqual(composerContentKey({ ...state, draft: state.draft + ' edit' }), key);
  const full = { ...emptyComposerState(), filesystemReferences: Array.from({ length: 8 }, (_, i) => reference(String(i))) };
  const before = cloneComposerState(full);
  assert.throws(() => restoreUnappliedInputs(full, [{ ...input('overflow', 3), filesystemReferences: [reference('extra')] }], true), /message_filesystem_reference_limit/);
  assert.deepEqual(full, before);
});

test('attachment-only recovered drafts are sendable data and submission failure retains all accepted resources', async t => {
  const [{ restoreUnappliedInputs }, { emptyComposerState, composerStateIsEmpty, submitComposerState }] = await loadGuiModules(t, [
    '/src/components/local-agent/composerRecovery.ts', '/src/components/local-agent/composerSubmission.ts']);
  let state = restoreUnappliedInputs(emptyComposerState(), [{ ...input('image-only', 1, ''), filesystemReferences: [reference('image')] }]);
  assert.equal(composerStateIsEmpty(state), false);
  state.submissionId = 'submission:failed';
  const original = structuredClone(state);
  const result = await submitComposerState('session:a', state, { read: () => state, write: (_key, next) => { state = next; },
    retainFailed: () => assert.fail('empty draft should be restored directly'), send: async () => { throw new Error('resource_unavailable'); } });
  assert.equal(result, false);
  assert.deepEqual(state, original);
});

test('legacy draft selections and restored guidance keep their identity and explain where a retired Skill went', async t => {
  const [{ useLocalAgentStore: store }, { useSettingsStore: settings }, { retiredDraftSkillNotice },
    { restoreUnappliedInputs }, { emptyComposerState }] = await loadGuiModules(t, [
    '/src/state/localAgentStore.ts', '/src/state/settingsStore.ts', '/src/pluginLocalization.ts',
    '/src/components/local-agent/composerRecovery.ts', '/src/components/local-agent/composerSubmission.ts',
  ]);
  const catalog = { revision: 'now', plugins: [{ uri: 'plugin://achbit-documents@builtin', enabled: true, available: true }] };
  store.setState({ pluginCatalog: catalog, profiles: [{ id: 'configured', enabled: true }], selectedProfileId: 'configured' });
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (...args) => { requests.push(args); throw Error('unexpected_host_call'); };
  t.after(() => { globalThis.fetch = originalFetch; });
  const saved = { selectionId: 'selection:old', uri: 'plugin://achbit-product@builtin', label: 'Old product guide' };
  const oldGuide = { referenceId: 'ref:old', uri: 'plugin://achbit-iteration@builtin', label: '旧迭代方法', toolName: 'skill.read', name: 'achbit-iteration' };
  const oldMessage = { ...input('old', 1, 'original text'), guidanceReferences: [oldGuide] };
  const original = structuredClone(oldMessage);
  const recovered = restoreUnappliedInputs(emptyComposerState(), [oldMessage]);
  for (const [language, selections, references, expected] of [
    ['en-US', [saved], [], /Old product guide.*operations\.md.*Remove/],
    ['zh-CN', [], recovered.guidanceReferences, /旧迭代方法.*本机维护 Skill.*移除此引用/],
  ]) {
    settings.setState(s => ({ effectiveSettings: { ...s.effectiveSettings, 'workbench.language': language } }));
    await assert.rejects(store.getState().sendMessage('original text', [], selections, [], undefined, [], undefined,
      { guidanceReferences: references }), expected);
    assert.match(store.getState().error, expected);
  }
  assert.deepEqual(requests, [], 'stale references must not create a session, upload anything, or execute a command');
  assert.deepEqual(oldMessage, original);
  assert.deepEqual(recovered.guidanceReferences, original.guidanceReferences);
  assert.equal(retiredDraftSkillNotice(catalog, [], [], 'en-US'), null, 'removing the draft chip clears the notice');
  const replacement = { ...saved, uri: 'plugin://achbit-product@skill-mount' };
  assert.equal(retiredDraftSkillNotice(catalog, [replacement], [], 'en-US'), null, 'local replacements keep their independent identity');
  const olderHost = { ...catalog, plugins: [...catalog.plugins, { uri: saved.uri, enabled: true, available: true }] };
  assert.equal(retiredDraftSkillNotice(olderHost, [saved], [], 'en-US'), null);
  const other = { ...saved, uri: 'plugin://unrelated@builtin' };
  await assert.rejects(store.getState().sendMessage('missing plugin', [], [other]), /plugin_selection_unavailable:plugin:\/\/unrelated@builtin/);
});
