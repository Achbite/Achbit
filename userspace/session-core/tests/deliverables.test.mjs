import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryCommandJournal } from './support/memoryJournal.mjs';
import { actorWith, fakeRunPreparation, emptyKernel, completedExecutionReply, providerEvent, createSession, messageCommand, readEvents, waitForProjection, workspaceBinding } from './local-agent-fixtures.mjs';
import { recoverSession } from '../dist/local-agent/reducer.js';
import { presentArtifacts } from '../dist/local-agent/deliverables.js';
import { decodeSessionControlCall } from '../dist/local-agent/sessionControls.js';
import { decodeRunPluginConfig } from '../dist/local-agent/skillPlugins.js';
import { decodeToolPromptProviderSnapshots } from '../dist/local-agent/toolPromptContributions.js';
import { decodeConversationReadQuery } from '../dist/local-agent/conversationRead.js';

const resource = (id, key, modifiedAt) => ({artifactId:id, label:id, uri:`artifact://${id}`, resourceKey:key,
  contentType:'image/png', contentMode:'fixed', modifiedAt});

test('observations remain resources; explicit delivery survives replay, updates one item, and never resends pixels', async t => {
  const journal = new InMemoryCommandJournal(), sessionId = 'session:deliverables';
  await createSession(journal, sessionId, [workspaceBinding]);
  const tools = [{toolBindingRef:'binding:observe',name:'browser.observe',description:'Observe a test page.',
    inputSchema:{type:'object',properties:{}},possibleEffects:['localRead'],availability:'callable',origin:'coreBuiltin'}];
  const images = [resource('artifact:temp','observation:temp','2026-10-09T00:01:00Z'),
    resource('artifact:v1','file:report','2026-10-09T00:02:00Z'),resource('artifact:v2','file:report','2026-10-09T00:03:00Z')];
  let turn = 0, reads = 0, deliveryId;
  const requests=[];
  const provider={async *stream(request){
    requests.push(request);turn++;
    if ([1,2,4].includes(turn)) yield providerEvent(request.requestId,'tool.call',{callId:`native:${turn}`,name:'browser_observe',input:{}});
    else if (turn===3 || turn===5) {
      if (turn===5) {
        const result=request.messages.filter(m=>m.role==='tool').map(m=>JSON.parse(m.content)).find(v=>Array.isArray(v.items));
        deliveryId=result.items[0].deliveryId;
        assert.equal(result.items[0].uri,'artifact://artifact:v1');
      }
      yield providerEvent(request.requestId,'tool.call',{callId:`native:${turn}`,name:'artifact_present',input:{items:[{
        artifactId:turn===3?'artifact:v1':'artifact:v2',label:'Review report',...(deliveryId?{deliveryId}:{})}]}});
    } else {
      assert.equal(turn,6);
      assert.ok(!request.messages.some(m=>m.toolImages?.length),'presentation must not rehydrate observation pixels');
      yield providerEvent(request.requestId,'text.delta',{text:'Review: ![report](artifact://artifact:v2)'});
    }
    yield providerEvent(request.requestId,'completed',{});
  }};
  const actor=actorWith(journal,sessionId,provider,emptyKernel({async execute(request){
    const artifact=images[reads++];return completedExecutionReply(request,{artifacts:[artifact],modelImages:[{artifactId:artifact.artifactId,purpose:'observation'}]});
  }}),fakeRunPreparation({tools,contextWindowTokens:16000}).port,'deliverables');
  t.after(()=>actor.dispose());
  await actor.submit(messageCommand(sessionId,'command:start','Inspect and present a report, then update it.'));
  const done=await waitForProjection(actor,p=>p.run?.status==='completed');
  assert.equal(done.artifacts.length,3);
  assert.equal(done.deliverables.length,1);
  assert.equal(done.deliverables[0].artifactId,'artifact:v2');
  assert.equal(done.deliverables[0].deliveryId,deliveryId);
  assert.equal(done.deliverables[0].updatedAt,'2026-10-09T00:03:00Z');
  assert.equal(done.artifacts[1].artifactId,'artifact:v1','old body references retain their immutable resource');
  const events=await readEvents(journal,sessionId);
  assert.equal(events.filter(e=>e.type==='artifacts.presented').length,2);
  assert.deepEqual(recoverSession(sessionId,events).deliverables[deliveryId],done.deliverables[0]);
  assert.throws(()=>presentArtifacts({sessionId,artifacts:{},deliverables:{}},'run:x','call:x','native:x',[{artifactId:'absent',label:'bad'}],()=> 'id'),/Unknown archived resource/);
});

test('plugin activation and configuration accept more than the former selection cap', () => {
  const uris=Array.from({length:17},(_,i)=>`plugin://tool-${i}@local`);
  assert.equal(decodeSessionControlCall('call:many','plugin.activate',{pluginUris:uris}).pluginUris.length,17);
  assert.equal(decodeRunPluginConfig({extensionGenerationRef:'generation:many',permissions:{},selectedPlugins:uris.map(uri=>({uri,displayName:uri,capabilitySummary:'Provides a task capability.'}))}).selectedPlugins.length,17);
  const contributions = Array.from({length:129}, (_,index)=>({contributionRef:`contribution:${index}`,canonicalToolName:`task_${index}`,promptSnippet:"Use this task capability.",usageGuidelines:[]}));
  assert.equal(decodeToolPromptProviderSnapshots([{providerRef:'provider:many',origin:'coreBuiltin',contributions}])[0].contributions.length,129);
  const imageIds = Array.from({length:9}, (_,index)=>`artifact:${index}`);
  assert.deepEqual(decodeConversationReadQuery({sessionId:'session:images',view:'images',imageIds}).imageIds,imageIds);
});
