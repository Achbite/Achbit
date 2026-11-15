import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionActor, loopSnapshot, projectSession } from '../dist/index.js';
import { decodeProviderNativeReplay, modelReasoningEfforts, modelThinkingModes } from '../../protocol/dist/index.js';
import { providerUsageFromEvents, combineTokenUsage, emptySessionState } from '../dist/local-agent/reducer.js';
import { SessionConfigurationRegistry } from '../dist/local-agent/sessionConfiguration.js';
import { createProviderToolAliases } from '../dist/local-agent/providerToolCodec.js';
import { InMemoryCommandJournal } from './support/memoryJournal.mjs';
import { assertRuntimeContract } from './support/runtimeContract.mjs';
import { fakeRunPreparation, createSession, workspaceBinding, emptyKernel, completedExecutionReply, failedExecutionReply,
  providerEvent, messageCommand, waitForProjection, readEvents } from './local-agent-fixtures.mjs';

const native = { apiSurface: 'anthropicMessages', content: [
  { type: 'thinking', thinking: 'first', signature: 'opaque-a' },
  { type: 'text', text: 'Inspect both files.' },
  { type: 'redacted_thinking', data: 'opaque-redaction' },
  { type: 'tool_use', id: 'native:a', name: 'read', input: { path: 'a' } },
  { type: 'thinking', thinking: 'second', signature: 'opaque-b' },
  { type: 'tool_use', id: 'native:b', name: 'read', input: { path: 'b' } },
] };

test('shared model policy exposes only supported effort and disable choices', () => {
  const profile={kind:'anthropic',providerFlavor:'openai',model:'claude-opus-4-7'};
  assert.deepEqual(modelReasoningEfforts(profile),['low','medium','high','xhigh','max']);
  assert.deepEqual(modelReasoningEfforts({...profile,model:'claude-sonnet-4-6'}),['low','medium','high','max']);
  assert.deepEqual(modelReasoningEfforts({...profile,model:'claude-sonnet-4-5'}),[]);
  assert.deepEqual(modelThinkingModes({...profile,model:'claude-sonnet-5-5'}),['enabled']);
  assert.deepEqual(modelThinkingModes({...profile,model:'claude-opus-5-5',reasoningEffort:'low'}),['enabled']);
  assert.deepEqual(modelReasoningEfforts({...profile,model:'claude-mythos-preview'}),['low','medium','high','max']);
  assert.deepEqual(modelThinkingModes({...profile,model:'claude-opus-5',reasoningEffort:'xhigh'}),['enabled']);
  assert.deepEqual(modelThinkingModes({...profile,model:'claude-opus-5',reasoningEffort:'high'}),['enabled','disabled']);
  assert.deepEqual(modelReasoningEfforts({...profile,kind:'ollama',model:'gpt-oss:20b'}),['low','medium','high']);
  assert.deepEqual(modelThinkingModes({...profile,kind:'ollama',model:'gpt-oss:20b'}),['enabled']);
  assert.deepEqual(modelReasoningEfforts({...profile,kind:'ollama',model:'qwen3:8b'}),[]);
});

test('native replay decoder retains block order and opaque bytes and rejects unknown structure', () => {
  const decoded = decodeProviderNativeReplay(native);
  assert.deepEqual(decoded, native);
  decoded.content[0].signature = 'mutated';
  assert.equal(native.content[0].signature, 'opaque-a');
  for (const value of [{ ...native, apiSurface: 'responses' }, { ...native, content: [] },
    { ...native, content: [{ type: 'unknown', data: 'opaque' }] },
    { ...native, content: [{ type: 'tool_use', id: 'x', name: 'read', input: '{broken' }] }]) {
    assert.throws(() => decodeProviderNativeReplay(value), /provider_native_replay_invalid/u);
  }
  for (const outcome of ['completed', 'denied', 'failed', 'cancelled', 'inputRejected', 'notExecuted', 'indeterminate']) {
    assertRuntimeContract('ModelMessage', { role: 'tool', content: 'Original outcome.', toolCallId: 'logical', providerCallId: 'native', toolOutcome: outcome });
  }
  assert.throws(() => assertRuntimeContract('ModelMessage', { role: 'user', content: 'Text', toolOutcome: 'failed' }));
  const message = { role: 'assistant', content: '', providerReplay: native, reasoningContent: 'firstsecond' };
  assertRuntimeContract('ModelMessage', message);
  for (const extra of [{ reasoningSignature: 'flat' }, { providerItems: [{ type: 'web_search_call' }] }]) {
    assert.throws(() => assertRuntimeContract('ModelMessage', { ...message, ...extra }));
  }
  const event = providerEvent('request:one', 'assistant.message', { messageId: 'message:one', content: '',
    providerReplay: native, reasoningContent: 'firstsecond', reasoningSignature: 'flat' });
  assert.throws(() => assertRuntimeContract('ProviderEvent', event));
  const settlement = { providerRequestId: 'request:one', providerRuntimeRef: 'runtime:one', purpose: 'agent',
    outcome: 'completed', orderedCallIds: [], providerReplay: native, reasoningContent: 'firstsecond' };
  for (const extra of [{ reasoningSignature: 'flat' }, { hostedWebSearchCalls: [{}] }, { orderedOutputBlocks: [] }]) {
    assert.throws(() => assertRuntimeContract('ProviderTurnSettledPayload', { ...settlement, ...extra }));
  }
});

test('reasoning aggregates preserve coverage and never add the subset to total output', () => {
  const sessionId='session:usage'; let sequence=0;
  const events=[];
  for (const [index,reasoning] of [3,undefined,0].entries()) {
    const providerRequestId='request:'+index;
    events.push({type:'provider.turn.settled',sessionId,sequence:++sequence,payload:{providerRequestId}});
    events.push({type:'context.updated',sessionId,sequence:++sequence,payload:{providerRequestId,inputTokens:10,outputTokens:6,
      ...(reasoning===undefined?{}:{reasoningOutputTokens:reasoning})}});
  }
  const usage=providerUsageFromEvents({sessionId,revision:sequence,events});
  assert.equal(usage.outputTokens,18);
  assert.deepEqual(usage.reasoningUsage,{outputTokens:3,reportedCallCount:2,complete:false});
  const unknown=emptySessionState('other').tokenUsage;
  assert.equal(unknown.reasoningUsage,undefined);
  assert.deepEqual(combineTokenUsage(usage,unknown).reasoningUsage,usage.reasoningUsage);
  const invalid=structuredClone(events); invalid[1].payload.reasoningOutputTokens=7;
  assert.throws(()=>providerUsageFromEvents({sessionId,revision:sequence,events:invalid}),/provider_usage_reasoning_invalid/u);
});

test('one Session Loop replays native thinking, redaction and two calls exactly once with their terminal tool facts', async t => {
  const sessionId = 'session:native-replay';
  const journal = new InMemoryCommandJournal();
  await createSession(journal, sessionId, [workspaceBinding]);
  const tools = [{ name: 'fs.read', toolBindingRef: 'binding:read', description: 'Read a UTF-8 file.',
    origin: 'coreBuiltin', availability: 'callable', possibleEffects: ['workspaceRead'], inputSchema: {
      type: 'object', additionalProperties: false, required: ['path'], properties: { path: {type:'string'},
        startLine:{type:'integer',minimum:1},maxLines:{type:'integer',minimum:1,maximum:5000} },
    } }];
  const preparation = fakeRunPreparation({ tools, apiSurface:'anthropicMessages', contextWindowTokens:32000,
    permissions:{'agent.permissions.workspaceMutation':'allow','agent.permissions.engineeringDecisions':'delegate'} });
  const capabilities = await new SessionConfigurationRegistry().create({ context:{id:'coding'}, controls:{id:'none'}, compaction:{id:'none'} });
  const requests=[]; let executions=0;
  const actor = new SessionActor(sessionId, journal, { capabilities,
    runPreparation:{...preparation.port, async prepare(input) {
      const value=await preparation.port.prepare(input); value.runtimeSnapshot.codingTools=true;
      value.runtimeSnapshot.toolSelection={controls:[],plugins:false};
      value.runtimeSnapshot.providerToolAliases=createProviderToolAliases(['fs.read'],[],true); return value;
    }},
    kernel:emptyKernel({async execute(request) {
      executions++;
      return request.input.path==='a' ? failedExecutionReply(request,{}, {code:'read_failed',message:'Original read failure'})
        : completedExecutionReply(request,{content:'second file'});
    }}),
    provider:{async *stream(request) {
      assertRuntimeContract('ProviderRequest',request); requests.push(structuredClone(request));
      if (requests.length===1) {
        const event=providerEvent(request.requestId,'assistant.message',{messageId:'native-message:one',content:'Inspect both files.',reasoningContent:'firstsecond',providerReplay:structuredClone(native)});
        assertRuntimeContract('ProviderEvent',event); yield event;
        for (const id of ['a','b']) yield providerEvent(request.requestId,'tool.call',{callId:'native:'+id,name:'read',arguments:JSON.stringify({path:id})});
      } else {
        const replay=request.messages.filter(message=>message.providerReplay);
        assert.equal(replay.length,1,'narrative and tool projections must not duplicate the native message');
        assert.deepEqual(replay[0].providerReplay,native);
        assert.equal(replay[0].reasoningSignature,undefined,'signatures remain attached to their original blocks');
        assert.deepEqual(replay[0].toolCalls.map(call=>call.providerCallId),['native:a','native:b']);
        assert.deepEqual(request.messages.filter(message=>message.role==='tool').map(message=>message.toolOutcome),['failed','completed']);
        yield providerEvent(request.requestId,'assistant.message',{messageId:'native-message:two',content:'Done.',
          providerReplay:{apiSurface:'anthropicMessages',content:[{type:'text',text:'Done.'}]}});
      }
      yield providerEvent(request.requestId,'completed',{usage:{inputTokens:20,outputTokens:6,reasoningOutputTokens:4,contextWindowTokens:32000}});
    }},async dispose(){} });
  t.after(()=>actor.dispose());
  await actor.submit(messageCommand(sessionId,'command:native','Read the files.'));
  const projection=await waitForProjection(actor,value=>['completed','failed','indeterminate','cancelled'].includes(value.run?.status));
  assert.equal(projection.run.status,'completed',JSON.stringify(projection.terminalError));
  assert.equal(executions,2); assert.equal(requests.length,2);
  const carrier = projection.contextCompositions[0].messages.find(message => message.contributionId.startsWith('provider-inputs:'));
  assert.deepEqual(carrier.blocks.map(block => block.kind), ['reasoning','text','reasoning','toolCall','reasoning','toolCall']);
  assert.equal(projection.tokenUsage.outputTokens,12);
  assert.deepEqual(projection.tokenUsage.reasoningUsage,{outputTokens:8,reportedCallCount:2,complete:true});
  const events=await readEvents(journal,sessionId);
  const settled=events.find(event=>event.type==='provider.turn.settled'&&event.payload.outcome==='completed');
  assert.deepEqual(settled.payload.providerReplay,native);
  assertRuntimeContract('ProviderTurnSettledPayload', settled.payload);
  assert.deepEqual(projectSession(loopSnapshot(sessionId,events).state),projection);
  for (const mutation of [
    payload => { payload.providerReplay.content[3].id = 'wrong-native-id'; },
    payload => { payload.reasoningSignature = 'flat'; },
    payload => { payload.hostedWebSearchCalls = []; },
    payload => { payload.providerReplay.apiSurface = 'responses'; },
  ]) {
    const invalid = structuredClone(events);
    mutation(invalid.find(event => event.type === 'provider.turn.settled' && event.payload.providerRequestId === settled.payload.providerRequestId).payload);
    assert.throws(() => loopSnapshot(sessionId,invalid), /provider_native_replay/u);
  }
});
