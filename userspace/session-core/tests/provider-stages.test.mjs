import assert from 'node:assert/strict';
import test from 'node:test';
import { runtimeSnapshot, workspaceBinding } from './local-agent-fixtures.mjs';
import { buildAgentProviderRequest } from '../dist/local-agent/contextComposer.js';
import { prepareContextCompaction } from '../dist/local-agent/compaction.js';
import { createSessionCapabilities, stageForRequest } from '../dist/local-agent/sessionCapabilities.js';
import { emptySessionState } from '../dist/local-agent/reducer.js';
import { loopSnapshot } from '../dist/local-agent/loop.js';
import { admitSessionEvents } from '../dist/local-agent/admission.js';

const tool = (name, effect) => ({ name, toolBindingRef: `binding:${name}`, description: name,
  origin: 'coreBuiltin', availability: 'callable', possibleEffects: [effect],
  inputSchema: { type: 'object', properties: {}, required: [] } });

for (const owner of ['providerHosted', 'kernelAdapter', 'unavailable']) {
  for (const stage of ['ordinary', 'handoff', 'plan', 'confirmed-plan']) {
    test(`Provider stage ${stage} only narrows ${owner}, including compaction`, async () => {
      const sessionId = 'session:stage', runId = 'run:stage';
      const webSearch = owner === 'providerHosted' ? { owner, providerToolType: 'web_search' }
        : owner === 'kernelAdapter' ? { owner, toolName: 'web.search' } : { owner };
      const runtime = runtimeSnapshot(runId, { apiSurface: 'responses',
        hostedWebSearch: owner === 'providerHosted' ? 'web_search' : 'none', webSearch,
        tools: [tool('session.read', 'localRead'), tool('fs.read', 'workspaceRead'), tool('bash', 'process'),
          ...(owner === 'kernelAdapter' ? [tool('web.search', 'network')] : [])] });
      const state = emptySessionState(sessionId);
      if (stage.includes('plan')) runtime.planMode = 'manual';
      if (stage === 'confirmed-plan') state.activePlanRef = { planId: 'plan:stage', runId, revision: 1 };
      const contextStart = { historyThroughSequence: 1, previousProfileId: 'profile:previous' };
      if (stage === 'handoff') state.contextHandoff = { ...contextStart, runId, status: 'reading' };
      const events = [
        { type: 'session.created', sessionId, sequence: 1,
          payload: { displayTitle: 'Stage fixture', workspaceBindings: [workspaceBinding] } },
        { type: 'message.committed', sessionId, sequence: 2,
          payload: { messageId: 'message:stage', role: 'user', content: 'Read session:reference and continue.' } },
        { type: 'run.started', sessionId, runId, sequence: 3,
          payload: { inputMessageId: 'message:stage', workspaceBindings: [workspaceBinding], runtimeSnapshot: runtime,
            ...(stage === 'handoff' ? { contextStart } : {}) } },
      ];
      const frozen = structuredClone(runtime);
      const toolStage = stageForRequest(createSessionCapabilities(), runtime, state);
      const input = { sessionId, runId, runtime, events, workspaceBindings: [workspaceBinding], toolStage };
      const agent = await buildAgentProviderRequest({ ...input, providerRequestId: 'request:agent', responseConstraint: 'normal' });
      const requestEvent = { type: 'context.compaction.requested', sessionId, runId, sequence: 4,
        payload: { compactionId: 'compaction:stage', providerRequestId: 'request:summary',
          trigger: 'pressure', coveredThroughSequence: 3 } };
      const compaction = prepareContextCompaction({ ...input, requestEvent });
      const narrowed = stage === 'handoff' || stage === 'plan';
      for (const { request, receipt } of [agent, compaction]) {
        assert.deepEqual(request.hostedTools, owner === 'providerHosted' && !narrowed
          ? [{ type: 'webSearch', providerToolType: 'web_search' }] : []);
        assert.equal(request.tools.some(item => item.name === 'bash'), !narrowed);
        assert.equal(request.tools.some(item => item.name === 'web_search'), owner === 'kernelAdapter' && !narrowed);
        assert.equal(receipt.tools.some(item => item.origin === 'providerHosted'), owner === 'providerHosted' && !narrowed);
        if (stage === 'handoff') assert.deepEqual(request.tools.map(item => item.name), ['session_read']);
      }
      const admit = (receipt, facts = events) => admitSessionEvents(loopSnapshot(sessionId, facts),
        [{ type: 'context.composed', sessionId, runId, payload: receipt }]);
      assert.doesNotThrow(() => admit(agent.receipt), 'production journal admission must accept the projected stage');
      if (stage === 'handoff') {
        assert.throws(() => admit(compaction.receipt, [...events, requestEvent]), /model_handoff_read_required/,
          'unread history cannot be compacted even when a request can be composed');
      } else assert.doesNotThrow(() => admit(compaction.receipt, [...events, requestEvent]));
      if (stage !== 'handoff') {
        const expanded = structuredClone(agent.receipt);
        const hostedTool = { itemId: 'web.search', label: 'web_search', canonicalName: 'web.search',
          wireName: 'web_search', origin: 'providerHosted', availability: 'callable' };
        expanded.tools.push(hostedTool, hostedTool);
        assert.throws(() => admit(expanded), /context_composition_search_owner_mismatch/);
        if (owner !== 'providerHosted') {
          expanded.tools.pop();
          assert.throws(() => admit(expanded), /context_composition_search_owner_mismatch/);
        }
      }
      assert.equal(compaction.request.responseConstraint, 'answerOnly');
      assert.deepEqual(runtime, frozen, 'stage projection must not mutate the frozen run capability');
    });
  }
}
