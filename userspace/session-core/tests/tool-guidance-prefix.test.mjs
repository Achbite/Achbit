import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionActor } from '../dist/index.js';
import { achbitProductComponents } from '../dist/local-agent/productInstructions.js';
import { SessionConfigurationRegistry } from '../dist/local-agent/sessionConfiguration.js';
import { buildConversationProviderRequest } from '../dist/local-agent/contextComposer.js';
import { InMemoryCommandJournal } from './support/memoryJournal.mjs';
import {
  fakeRunPreparation, emptyKernel, completedExecutionReply, providerEvent, createSession,
  messageCommand, readEvents, waitForProjection, workspaceBinding, idFactory,
} from './local-agent-fixtures.mjs';

const tools = [
  ['fs.read', 'workspaceRead', { path: { type: 'string' } }],
  ['bash', 'process', { command: { type: 'string' } }],
  ['skill.read', 'localRead', { name: { type: 'string' } }],
  ['plugin.search', 'localRead', { query: { type: 'string' } }],
].map(([name, effect, properties]) => ({
  name, description: name, toolBindingRef: `binding:${name}`, origin: 'coreBuiltin',
  availability: 'callable', possibleEffects: [effect],
  inputSchema: { type: 'object', properties, required: [] },
}));

test('Skill reads, activation and subsequent Loops retain core tool definitions and sent history', async t => {
  for (const apiSurface of ['chatCompletions', 'responses']) {
    const sessionId = `session:skill-prefix-${apiSurface}`;
    const journal = new InMemoryCommandJournal();
    await createSession(journal, sessionId, [workspaceBinding]);
    const frontend = 'plugin://frontend@local';
    const operations = 'plugin://achbit-iteration@builtin';
    const preparation = fakeRunPreparation({ tools, apiSurface, contextWindowTokens: 100000 });
    const runPreparation = { ...preparation.port, async prepare(request) {
      const prepared = await preparation.port.prepare(request);
      const runtime = prepared.runtimeSnapshot;
      Object.assign(runtime.environment, { productDocsPath: '/fixture/docs',
        hostDataDirectory: '/fixture/state', runtimeExecutables: { kernel: '/fixture/kernel', cli: '/fixture/cli' } });
      for (const plugin of runtime.selectedPlugins.plugins) {
        plugin.skillEntryPath = plugin.uri === frontend ? '/fixture/frontend/SKILL.md' : '/fixture/iteration/SKILL.md';
      }
      return prepared;
    } };
    const toolGuidance = new SessionConfigurationRegistry(undefined, achbitProductComponents)
      .productToolGuidance({ productComponents: ['achbit.product-operations'] });
    const requests = [];
    const provider = { async *stream(request) {
      const step = requests.length;
      assert.ok(step < 6, 'the two completed Loops and explicit selection need six requests');
      if (step > 0) {
        assert.deepEqual(request.tools, requests[0].tools, 'Skill metadata must keep every tool declaration stable');
        assert.deepEqual(request.messages.slice(0, requests.at(-1).messages.length), requests.at(-1).messages,
          'new requests must retain all previously sent messages');
      }
      requests.push(structuredClone(request));
      if (step === 0 || step === 3 || step === 1) {
        const name = step === 1 ? 'plugin_activate' : 'skill_read';
        const input = step === 1 ? { pluginUris: [frontend] } : { name: 'achbit-iteration' };
        yield apiSurface === 'responses'
          ? providerEvent(request.requestId, 'output.item.completed', { outputIndex: 0, item: {
            type: 'function_call', call_id: `native:${step}`, name, arguments: JSON.stringify(input), status: 'completed',
          } })
          : providerEvent(request.requestId, 'tool.call', { callId: `native:${step}`, name, input });
      } else {
        yield providerEvent(request.requestId, 'text.delta', { text: 'Finished.' });
      }
      yield providerEvent(request.requestId, 'completed', {});
    } };
    const actor = new SessionActor(sessionId, journal, {
      provider, runPreparation, toolGuidance,
      kernel: emptyKernel({ async execute(request) {
        assert.equal(request.toolName, 'skill.read');
        return completedExecutionReply(request, { content: '# Iteration\nFollow the actual entry point.' });
      } }),
      async dispose() {},
    }, { nextId: idFactory(`skill-prefix-${apiSurface}`) });
    t.after(() => actor.dispose());

    await actor.submit(messageCommand(sessionId, 'command:first', 'Read the iteration Skill and activate the frontend Skill.'));
    await waitForProjection(actor, state => state.run?.status === 'completed');
    await actor.submit(messageCommand(sessionId, 'command:second', 'Read the iteration Skill again, then answer.'));
    await waitForProjection(actor, state => state.run?.status === 'completed' && requests.length === 5);
    await actor.submit({ ...messageCommand(sessionId, 'command:third', 'Use the selected Skills.'), pluginSelections: [
      { uri: frontend, label: 'Frontend', selectionId: 'selection:frontend' },
      { uri: operations, label: 'Iteration', selectionId: 'selection:iteration' },
    ] });
    await waitForProjection(actor, state => state.run?.status === 'completed' && requests.length === 6);

    for (const index of [1, 4]) {
      const result = requests[index].messages.at(-1);
      assert.equal(result.role, 'tool');
      assert.match(result.content, /^# Iteration\nFollow the actual entry point\.\n\nAchbit product resources:/);
      assert.ok(result.content.includes('/fixture/cli'));
    }
    const activated = JSON.parse(requests[2].messages.at(-1).content);
    assert.deepEqual(activated.skillEntries, [{ uri: frontend, path: '/fixture/frontend/SKILL.md' }]);
    const selected = requests[5].messages.at(-1);
    assert.equal(selected.role, 'user');
    assert.ok(selected.content.startsWith('Use the selected Skills.'));
    for (const path of ['/fixture/frontend/SKILL.md', '/fixture/iteration/SKILL.md', '/fixture/cli']) {
      assert.ok(selected.content.includes(path));
    }
    const events = await readEvents(journal, sessionId);
    assert.equal(events.filter(event => event.type === 'run.started').length, 3);
    const latest = events.findLast(event => event.type === 'context.composed');
    const started = events.findLast(event => event.type === 'run.started');
    const replay = buildConversationProviderRequest({
      purpose: 'agent', responseConstraint: 'normal', sessionId, runId: started.runId,
      providerRequestId: 'request:replay', runtime: started.payload.runtimeSnapshot, toolGuidance,
      events: events.filter(event => event.sequence <= latest.payload.modelView.throughSequence),
      modelViewEvents: events, workspaceBindings: [workspaceBinding],
    });
    assert.deepEqual(replay.request.messages, requests[5].messages, 'frozen model views survive a fresh context build');
    assert.deepEqual(replay.request.tools, requests[5].tools);
    await actor.dispose();
  }
});
