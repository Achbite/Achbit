import assert from 'node:assert/strict';
import test from 'node:test';
import { SessionService, sessionControlToolDefinitions } from '../dist/index.js';
import { recipeForMode } from '../dist/local-agent/sessionMode.js';
import { createProviderToolAliases } from '../dist/local-agent/providerToolCodec.js';
import { activeConversationEvents } from '../dist/local-agent/conversationHistory.js';
import { InMemoryCommandJournal } from './support/memoryJournal.mjs';
import { emptyKernel, fakeRunPreparation, messageCommand, providerEvent, readEvents, waitForProjection, workspaceBinding } from './local-agent-fixtures.mjs';

const setMode = (sessionId, mode, commandId = `mode:${mode}`) => ({schemaVersion:'achbit.command.v3', type:'session.mode.set', sessionId, commandId, mode});
const recipe = {permissions:{'agent.permissions.workspaceMutation':'plan','agent.permissions.shell':'review'},
  permissionPolicy:{id:'workspace-only'}, workspaceSandbox:{backendId:'platform-default'},
  productComponents:[], tools:{kernel:['fs.read','fs.write'],controls:[],plugins:false},
  configuration:{context:{id:'journal'},controls:{id:'standard'},compaction:{id:'summary'}}, runner:{id:'standard'}};

test('minimal narrows the saved recipe without changing model, permissions or sandbox; full restores exactly the base', () => {
  const base = {...recipe, profileId:'model:kept',reasoningEffort:'high'};
  const original = structuredClone(base);
  const minimal = recipeForMode(base,'minimal');
  assert.deepEqual(base, original);
  assert.deepEqual(minimal.tools, {kernel:['fs.read','fs.write'],controls:[],plugins:false});
  assert.deepEqual(minimal.configuration, {context:{id:'coding'},controls:{id:'none'},compaction:{id:'none'}});
  for (const field of ['permissions','permissionPolicy','workspaceSandbox','profileId','reasoningEffort']) assert.deepEqual(minimal[field],base[field]);
  assert.deepEqual(recipeForMode(base,'full'),base);
});

test('Session mode persists without inference, active run stays frozen, later runs recompose and retain history', async t => {
  const journal = new InMemoryCommandJournal(), requests = [], installations = [], released = [];
  let releaseFirst, firstStarted;
  const started = new Promise(resolve => firstStarted = resolve);
  const blocked = new Promise(resolve => releaseFirst = resolve);
  const provider = {async *stream(request) {
    requests.push(structuredClone(request));
    if (requests.length === 1) {firstStarted(); await blocked;}
    yield providerEvent(request.requestId,'text.delta',{text:`Answer ${requests.length}: retained history.`});
    yield providerEvent(request.requestId,'completed',{});
  }};
  const factory = { async create({codingTools}) {
    const installed = {codingTools, disposed:false}; installations.push(installed);
    const preparation = fakeRunPreparation({contextWindowTokens:100000});
    return {composition:{provider, kernel:emptyKernel(), runPreparation:{...preparation.port,
      async prepare(input) {
        const result = await preparation.port.prepare(input);
        const runtime = result.runtimeSnapshot;
        runtime.codingTools = codingTools ? true : undefined;
        runtime.toolSelection = {controls:codingTools ? [] : undefined, plugins:!codingTools};
        runtime.providerToolAliases = createProviderToolAliases(codingTools ? [] : sessionControlToolDefinitions().map(t => t.name), input.previousProviderToolAliases,codingTools);
        return result;
      }, async release(input) {released.push(input); return preparation.port.release(input);}},
      async dispose(){assert.equal(installed.disposed,false);installed.disposed=true;}}};
  }};
  let service = new SessionService(journal,factory);
  t.after(async () => {releaseFirst(); await service.dispose(true);});
  const sessionId='session:mode';
  await service.createSession({sessionId,displayTitle:'Mode',workspaceBindings:[workspaceBinding]});
  await service.createSession({sessionId:'session:other',displayTitle:'Other',workspaceBindings:[]});
  await service.submit(messageCommand(sessionId,'input:one','Keep the phrase cobalt river in this conversation.'));
  await started;
  const before = await service.snapshot(sessionId);
  assert.equal(before.run.mode,'full');
  assert.equal((await service.submit(setMode(sessionId,'minimal'))).status,'accepted');
  const changed = await service.snapshot(sessionId);
  assert.equal(changed.mode,'minimal'); assert.equal(changed.run.mode,'full');
  assert.equal(requests.length,1); assert.equal(installations.length,2,'saving a choice cannot replace active implementations');
  assert.equal((await service.snapshot('session:other')).mode,'full');
  const revision=changed.revision;
  assert.equal((await service.submit(setMode(sessionId,'minimal'))).status,'replayed');
  await service.submit(setMode(sessionId,'minimal','mode:again'));
  assert.equal((await service.snapshot(sessionId)).revision,revision,'same choice writes no redundant event');
  await service.submit(messageCommand(sessionId,'input:queued','This supplement belongs to the current run.'));
  assert.equal((await service.snapshot(sessionId)).queuedInputs[0].runId, before.run.runId);
  releaseFirst();
  const wait = () => waitForProjection({snapshot:()=>service.snapshot(sessionId)},state=>state.run?.status==='completed');
  await wait();
  assert.equal(requests.length,2);
  assert.ok(requests[1].tools.length>0,'queued input still uses the full run');
  await service.submit(messageCommand(sessionId,'input:two','Continue using the phrase from before.'));
  await wait();
  assert.equal((await service.snapshot(sessionId)).run.mode,'minimal');
  assert.equal(requests.length,3);
  assert.equal(requests[2].tools.length,0,'no Session controls in minimal mode');
  assert.ok(requests[0].tools.length>0);
  assert.ok(requests[2].messages.some(m=>m.content.includes('cobalt river')));
  assert.equal(installations[0].disposed,true);
  await service.dispose();
  service = new SessionService(journal,factory);
  assert.equal((await service.snapshot(sessionId)).mode,'minimal');
  await service.submit(setMode(sessionId,'full'));
  assert.equal(requests.length,3,'reopening and setting a mode make no Provider request');
  await service.submit(messageCommand(sessionId,'input:three','Continue after restoring full mode.'));
  await wait();
  assert.equal(requests.length,4); assert.ok(requests[3].tools.length>0);
  assert.equal((await service.snapshot(sessionId)).run.mode,'full');
  assert.ok(requests[3].messages.some(m=>m.content.includes('cobalt river')));
  const events=await readEvents(journal,sessionId);
  assert.deepEqual(events.filter(e=>e.type==='run.started').map(e=>e.payload.runtimeSnapshot.mode),['full','minimal','full']);
  assert.equal(events.some(e=>e.type==='run.started' && e.payload.contextStart),false);
  assert.equal(events.filter(e=>e.type==='message.committed' && e.payload.role==='user').length,4);
  assert.equal(events.filter(e=>e.type==='session.mode.updated').length,2);
  assert.equal(released.length,3);
});

test('history revision does not undo an independently saved mode', () => {
  const e=(type,sequence,payload)=>({type,sequence,payload,eventId:`e:${sequence}`,sessionId:'session:edit'});
  const events=[e('session.created',1,{}),e('input.accepted',2,{messageId:'m:1'}),e('session.mode.updated',3,{mode:'minimal'}),
    e('conversation.revised',4,{fromSequence:2,throughSequence:3})];
  assert.ok(activeConversationEvents(events).some(e=>e.type==='session.mode.updated'));
});
