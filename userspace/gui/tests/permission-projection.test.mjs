import assert from 'node:assert/strict';
import test from 'node:test';
import { loopSnapshot, projectSession } from '../../session-core/dist/index.js';
import { InMemoryCommandJournal } from '../../session-core/tests/support/memoryJournal.mjs';
import { createSession, readEvents, workspaceBinding } from '../../session-core/tests/local-agent-fixtures.mjs';
import { decodeGuiProjection, installGuiFetch, loadGuiModelStore } from './gui-projection-contract.mjs';

test('GUI uses published child permissions even when its own journal has not advanced', async t => {
  const journal = new InMemoryCommandJournal(), sessionId = 'session:permission-child';
  await createSession(journal, sessionId, [workspaceBinding]);
  const initial = projectSession(loopSnapshot(sessionId, await readEvents(journal, sessionId)).state);
  initial.agentContext = { ownerSessionId: 'session:parent', parentSessionId: 'session:parent',
    parentRunId: 'run:parent', parentCallId: 'call:spawn',
    capabilities: { messaging: true, continuation: true, delegation: true } };
  initial.recipe = { runner: { id: 'custom-driver' }, permissions: { 'agent.permissions.workspaceMutation': 'allow' } };
  initial.permissionOverrides = { 'agent.permissions.workspaceMutation': 'allow' };
  initial.effectivePermissions = { 'agent.permissions.workspaceMutation': 'allow' };
  assert.deepEqual(await decodeGuiProjection(initial), initial);
  let incoming = initial, reads = 0;
  installGuiFetch(t, async url => {
    if (url.pathname.endsWith('/statuses')) return Response.json({ ok: true, data: [{ sessionId,
      revision: initial.revision, run: initial.run }] });
    if (url.pathname.endsWith('/projection')) { reads++; return Response.json({ ok: true, data: incoming }); }
    throw new Error(`Unexpected request ${url.pathname}`);
  });
  const store = await loadGuiModelStore(t);
  store.setState({ sessionId, projection: initial, loading: false });
  await store.getState().refresh();
  incoming = { ...initial, effectivePermissions: { 'agent.permissions.workspaceMutation': 'plan' } };
  await store.getState().refresh();
  assert.equal(reads, 2);
  assert.deepEqual(store.getState().projection.effectivePermissions, incoming.effectivePermissions);
  assert.equal(store.getState().projection.revision, initial.revision);
  assert.deepEqual(store.getState().projection.permissionOverrides, initial.permissionOverrides);
  await assert.rejects(decodeGuiProjection({ ...initial, recipe: { runner: { id: '' } } }), /conversation_projection_invalid/u);
});
