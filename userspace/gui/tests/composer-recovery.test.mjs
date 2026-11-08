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
  const original = structuredClone(state);
  const result = await submitComposerState('session:a', state, { read: () => state, write: (_key, next) => { state = next; },
    retainFailed: () => assert.fail('empty draft should be restored directly'), send: async () => { throw new Error('resource_unavailable'); } });
  assert.equal(result, false);
  assert.deepEqual(state, original);
});
