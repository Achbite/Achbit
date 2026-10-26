import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionNotifications } from '../dist/sessionNotifications.js';
import { SessionService } from '../dist/local-agent/service.js';
import { InMemoryCommandJournal } from './support/memoryJournal.mjs';
import { emptyKernel, fakeRunPreparation, messageCommand, providerEvent, readEvents } from './local-agent-fixtures.mjs';

const settled = (sessionId, runId, sequence, parentSessionId = null, outcome = 'completed') => ({
  kind: 'event', sessionId, parentSessionId,
  event: { type: 'run.settled', runId, sequence, payload: { outcome, finalMessageId: 'message:result' } },
});

test('Session production observations retain canonical lineage, idle child updates, and exact root settlement', { timeout: 5000 }, async t => {
  const journal = new InMemoryCommandJournal(), root = 'session:root';
  const frames = [], seen = [], turns = new Map();
  let service, middle, child, previousChildChanges, resolveCompletion;
  const completion = new Promise(resolve => { resolveCompletion = resolve; });
  const notifications = new SessionNotifications(async frame => { frames.push(frame); });
  const changesFor = sessionId => frames.filter(frame => frame.notification.kind === 'change' && frame.notification.sessionId === sessionId).length;
  const settings = { enabled: true, profileId: '', reasoningEffort: '', maxConcurrent: 4,
    maxCallsPerRun: 16, maxMembersPerSession: 4, allowMemberAnalysis: true, allowFullConfiguration: false, presets: '[]' };
  service = new SessionService(journal, { async create({ sessionId }) {
    const preparation = fakeRunPreparation({ contextWindowTokens: 100_000 });
    return { composition: {
      provider: { async *stream(request) {
        const turn = (turns.get(sessionId) ?? 0) + 1;
        turns.set(sessionId, turn);
        const call = input => providerEvent(request.requestId, 'tool.call', { callId: `call:${sessionId}:${turn}`, name: 'agent', input });
        if (sessionId === root) {
          if (turn === 1) yield call({ action: 'spawn', preset: 'collaboration', capabilities: { delegation: true },
            name: 'Coordinator', task: 'Create a reusable reader and obtain its report.', delivery: 'wait' });
          else if (turn === 2) {
            middle = (await service.snapshot(root)).agentChildren[0].agentSessionId;
            child = (await service.snapshot(middle)).agentChildren[0].agentSessionId;
            assert.equal((await service.snapshot(child)).run.status, 'completed');
            previousChildChanges = changesFor(child);
            yield call({ action: 'assign', agentId: child, task: 'Read the second item.' });
          } else if (turn === 3) yield call({ action: 'wait' });
          else yield providerEvent(request.requestId, 'text.delta', { text: 'Visible result.' });
        } else {
          const context = (await readEvents(journal, sessionId))[0].payload.agentContext;
          if (context.parentSessionId === root && turn === 1) yield call({ action: 'spawn', preset: 'analysis',
            name: 'Reader', task: 'Read the first item.', delivery: 'wait' });
          else yield providerEvent(request.requestId, 'text.delta', { text: 'Visible result.' });
        }
        yield providerEvent(request.requestId, 'completed', {});
      } }, kernel: emptyKernel(), runPreparation: { ...preparation.port, async prepare(input) {
        const prepared = await preparation.port.prepare(input);
        prepared.runtimeSnapshot.agentToolsEnabled = true;
        const context = (await readEvents(journal, sessionId))[0].payload.agentContext;
        if (context) prepared.runtimeSnapshot.agentCapabilities = context.capabilities;
        return prepared;
      } }, async dispose() {},
    } };
  } }, {
    async settings() { return settings; }, async saveDefaults() {},
    async models() { return [{ profileId: 'profile:default', name: 'Fixture', model: 'fixture-model',
      parameters: { adapterId: 'openai', kind: 'responses', providerFlavor: null, contextWindowTokens: 100_000,
        maxOutputTokens: 4096, imageInput: false, temperature: null, hostedWebSearch: null }, reasoningEfforts: ['low', 'medium', 'high'] }]; },
    async createSession(input) { return service.createSession(input); },
  }, undefined, undefined, {
    accept(input) {
      seen.push(input);
      notifications.accept(input);
      if (input.kind === 'event' && input.event.type === 'run.settled' && input.sessionId === root) resolveCompletion();
    },
    failed(id, error) { notifications.failed(id, error); },
  });
  t.after(async () => { await service.dispose(); await notifications.close(); });
  await service.createSession({ sessionId: root, displayTitle: 'Root', workspaceBindings: [] });
  await service.submit(messageCommand(root, 'command:managed-notifications', 'Delegate, then continue the reusable reader.'));
  await completion;
  assert.equal((await service.snapshot(root)).run.status, 'completed');
  assert.equal((await service.snapshot(child)).run.status, 'completed');
  await service.dispose();
  await notifications.close();
  const rootSettled = (await readEvents(journal, root)).find(event => event.type === 'run.settled');
  assert.deepEqual(frames.filter(frame => frame.notification.kind === 'settled').map(frame => frame.notification), [{
    kind: 'settled', sessionId: root, runId: rootSettled.runId, eventSequence: rootSettled.sequence, outcome: 'completed',
  }]);
  assert.equal((await readEvents(journal, child)).filter(event => event.type === 'run.settled').length, 2);
  assert.ok(changesFor(child) > previousChildChanges);
  assert.ok(seen.some(input => input.kind === 'draft' && input.sessionId === child));
  assert.ok(seen.filter(input => input.sessionId === child).every(input => input.parentSessionId === middle));
  assert.ok(seen.filter(input => input.sessionId === root).every(input => input.parentSessionId === null));
  assert.doesNotMatch(JSON.stringify(frames), /Visible result|Read the second item/);
});

test('slow IPC coalesces invalidations but preserves each settlement and drains accepted events on close', async () => {
  const frames = [];
  let release;
  const blocked = new Promise(resolve => { release = resolve; });
  const notifications = new SessionNotifications(async frame => {
    frames.push(frame);
    if (frames.length === 1) await blocked;
  });
  const draft = { kind: 'draft', sessionId: 'session:child', draft: { text: 'private draft' } };
  notifications.accept(draft);
  for (let index = 0; index < 20; index++) notifications.accept(draft);
  notifications.accept({ kind: 'toolProgress', sessionId: 'session:child', runId: 'run:child', callId: 'call:child', progress: { text: 'private progress' } });
  notifications.accept(settled('session:root', 'run:first', 11));
  notifications.accept(settled('session:root', 'run:second', 18, null, 'cancelled'));
  notifications.accept(settled('session:child', 'run:child', 8, 'session:root'));
  const closed = notifications.close();
  notifications.accept(settled('session:late', 'run:late', 1));
  release();
  await closed;
  assert.deepEqual(frames.filter(frame => frame.notification.kind === 'settled').map(frame => frame.notification.runId), ['run:first', 'run:second']);
  assert.equal(frames.filter(frame => frame.notification.kind === 'change' && frame.notification.sessionId === 'session:child').length, 2);
  assert.ok(frames.every(frame => frame.protocolVersion === 'deepcode.local-agent' && frame.type === 'session.notification'));
  assert.doesNotMatch(JSON.stringify(frames), /private|session:late/);
});

test('notification failures remain explicit without throwing into the Session producer', async () => {
  const frames = [];
  const notifications = new SessionNotifications(async frame => { frames.push(frame); });
  notifications.failed('session:one', new Error('observer fixture failure'));
  await notifications.close();
  assert.deepEqual(frames[0].notification, { kind: 'error', code: 'session_observation_failed', message: 'observer fixture failure' });
  const error = new Error('broken stdout');
  const broken = new SessionNotifications(async () => { throw error; });
  assert.doesNotThrow(() => broken.accept(settled('session:one', 'run:one', 7)));
  await assert.rejects(broken.close(), thrown => thrown === error);
});
