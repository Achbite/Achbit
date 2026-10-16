import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionService } from '../dist/index.js';
import { reduceAgentLifecycle } from '../dist/local-agent/agentLifecycle.js';
import { InMemoryCommandJournal } from './support/memoryJournal.mjs';
import { emptyKernel, fakeRunPreparation, messageCommand, providerEvent, readEvents, waitUntil } from './local-agent-fixtures.mjs';

test('settled children release Actors; management and history reads stay cold; continuation reopens the same Session', async t => {
  const journal = new InMemoryCommandJournal();
  const ownerId = 'session:actor-owner';
  const opened = new Map(), disposed = new Map(), managementReads = [];
  const read = journal.readAgentLifecycle.bind(journal);
  journal.readAgentLifecycle = async id => {
    const result = await read(id);
    managementReads.push(id);
    assert.doesNotMatch(JSON.stringify(result), /Task body|Child evidence|runtimeSnapshot|"content"|"text"/u);
    return result;
  };
  let rootTurn = 0, memberId, service;
  service = new SessionService(journal, { async create({ sessionId }) {
    opened.set(sessionId, (opened.get(sessionId) ?? 0) + 1);
    const preparation = fakeRunPreparation();
    return { composition: { kernel: emptyKernel(), runPreparation: { ...preparation.port, async prepare(input) {
        const prepared = await preparation.port.prepare(input);
        prepared.runtimeSnapshot.agentToolsEnabled = true;
        const creation = (await readEvents(journal, sessionId))[0];
        if (creation.payload.agentContext) prepared.runtimeSnapshot.agentCapabilities = creation.payload.agentContext.capabilities;
        return prepared;
      } },
      async dispose() { disposed.set(sessionId, (disposed.get(sessionId) ?? 0) + 1); },
      provider: { async *stream(request) {
        if (sessionId !== ownerId) {
          yield providerEvent(request.requestId, 'text.delta', { text: 'Child evidence.' });
        } else {
          rootTurn += 1;
          let input;
          if (rootTurn === 1) input = { action: 'spawn', preset: 'collaboration', name: 'Member', task: 'Task body one.', delivery: 'wait' };
          if (rootTurn === 2) {
            memberId = (await service.snapshot(ownerId)).agentChildren[0].agentSessionId;
            assert.equal(disposed.get(memberId), 1, 'result delivery releases the child composition before the next request');
            input = { action: 'send', agentId: memberId, text: 'Task body continuation.' };
          }
          if (rootTurn === 3) input = { action: 'wait' };
          if (rootTurn === 4) {
            assert.equal(disposed.get(memberId), 2);
            input = { action: 'spawn', name: 'Analysis', task: 'Task body two.', delivery: 'wait' };
          }
          if (input) yield providerEvent(request.requestId, 'tool.call', { callId: `call:actor:${rootTurn}`, name: 'agent', input });
          else yield providerEvent(request.requestId, 'text.delta', { text: 'Root evidence.' });
        }
        yield providerEvent(request.requestId, 'completed', {});
      } },
    } };
  } }, {
    async settings() { return { enabled: true, profileId: '', reasoningEffort: '', maxConcurrent: 4,
      maxCallsPerRun: 16, maxMembersPerSession: 4, allowMemberAnalysis: true }; },
    async models() { return [{ profileId: 'profile:default', name: 'Default', model: 'fixture-model', parameters: { adapterId: 'openai', kind: 'responses', providerFlavor: null, contextWindowTokens: 100000, maxOutputTokens: 4096, imageInput: false, temperature: null, hostedWebSearch: null }, reasoningEfforts: ['low', 'medium', 'high'] }]; },
    async createSession(input) { return service.createSession(input); },
  });
  t.after(() => service.dispose());
  await service.createSession({ sessionId: ownerId, displayTitle: 'Owner', workspaceBindings: [] });
  await service.submit(messageCommand(ownerId, 'command:actors', 'Start the work.'));
  await waitUntil(async () => ['completed', 'failed', 'indeterminate'].includes((await service.snapshot(ownerId)).run?.status), 'agent actor reclamation');
  assert.equal((await service.snapshot(ownerId)).run.status, 'completed', JSON.stringify((await service.snapshot(ownerId)).terminalError));
  const parent = await service.snapshot(ownerId);
  assert.equal(rootTurn, 5);
  assert.equal(parent.agentTasks.length, 3);
  assert.equal(parent.agentChildren.length, 2);
  assert.equal(opened.get(memberId), 2, 'one activation for each actual task, none for family scans');
  for (const child of parent.agentChildren) {
    const count = opened.get(child.agentSessionId);
    assert.equal(disposed.get(child.agentSessionId), count);
    const history = await service.snapshot(child.agentSessionId);
    assert.ok(history.messages.some(message => message.content === 'Child evidence.'));
    assert.equal(opened.get(child.agentSessionId), count, 'history does not reopen an Actor');
  }
  assert.ok(managementReads.includes(memberId), 'family admission uses the narrow journal path');
  const lifecycle = await journal.readAgentLifecycle(ownerId);
  const relations = lifecycle.events.filter(event => event.type !== 'session.created')
    .reduce(reduceAgentLifecycle, { agentTasks: [], agentChildren: [] });
  assert.deepEqual(relations.agentChildren, parent.agentChildren);
  assert.deepEqual(relations.agentTasks.map(({ result: _result, ...task }) => task),
    parent.agentTasks.map(({ text: _text, result: _result, ...task }) => task));
  assert.equal((await readEvents(journal, memberId)).filter(event => event.type === 'session.created').length, 1);
});
