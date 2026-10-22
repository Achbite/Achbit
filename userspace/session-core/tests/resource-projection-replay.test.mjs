import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryCommandJournal } from './support/memoryJournal.mjs';
import { createSession, readEvents, runtimeSnapshot, completedExecutionReply, workspaceBinding } from './local-agent-fixtures.mjs';
import { SessionService, emptySessionState, reduceSession, recoverSession, projectSession } from '../dist/index.js';
import { projectSessionResources } from '../dist/local-agent/resourceProjection.js';
import { projectResourceTool } from '../dist/local-agent/reducer.js';

async function fixture(withArtifacts = false) {
  const journal = new InMemoryCommandJournal(), sessionId = 'session:resource-projection', runId = 'run:resource-projection';
  await createSession(journal, sessionId, [workspaceBinding]);
  const events = await readEvents(journal, sessionId);
  const append = async (type, payload, metadata = {}) => {
    const event = await journal.append({ type, sessionId, payload, ...metadata });events.push(event);return event;
  };
  const index = { workspaceId: 'workspace:index', displayName: 'Indexed directory' };
  await append('session.directory-index.attached', { commandId: 'command:index', workspaceBinding: index });
  await append('message.committed', { messageId: 'message:input', role: 'user', content: 'BODY_NOT_FOR_RESOURCE_READ',
    filesystemReferences: [{ referenceId: 'ref:attachment', workspaceId: 'workspace:attachment', logicalPath: 'input.txt',
      displayName: 'input.txt', kind: 'file', mediaType: 'text/plain', byteLength: 7 }] });
  const runtime = runtimeSnapshot(runId);
  await append('run.started', { inputMessageId: 'message:input', workspaceBindings: [workspaceBinding,index], runtimeSnapshot: runtime }, { runId });
  const records = [];
  for (const [suffix, scope] of [['session','sessionFiles'], ['run','runFiles']]) {
    const callId = `call:${suffix}`, attemptId = `attempt:${suffix}`;
    const input = { workspaceId: workspaceBinding.workspaceId, path: `${suffix}.txt` };
    await append('tool.requested', { providerCallId: `provider:${suffix}`, attemptId, toolName: 'fs.write', input }, { runId, callId });
    await append('approval.requested', { approvalId: `approval:${suffix}`, preview: { summary: `Access ${suffix}`,
      effects: ['localRead'], logicalTargets: ['/reference'], authorizationContext: { fileAccess: { read: ['/reference'], write: [] } } } }, { runId, callId });
    await append('run.waiting', { reason: 'approval' }, { runId });
    await append('approval.resolved', { approvalId: `approval:${suffix}`, commandId: `command:${suffix}`, decision: 'allow',
      authorityId: `authority:${suffix}`, authorizationScope: scope }, { runId, callId });
    const record = completedExecutionReply({ sessionId, runId, callId, attemptId, requestId: `request:${suffix}`, toolName: 'fs.write',
      toolBindingRef: 'binding:write', extensionGenerationRef: runtime.extensionGenerationRef,
      kernelCatalogSnapshotRef: runtime.kernelCatalogSnapshotRef, input }, {
      unrelatedBody: `TOOL_BODY_${suffix}`, fileChanges: [{ workspaceId: workspaceBinding.workspaceId, path: `${suffix}.txt`, kind: 'create',
        before: { exists: false }, after: { exists: true, contentRef: `/archive/${suffix}`, sizeBytes: 3 } }],
    }).record;
    if (withArtifacts && suffix === 'session') record.output.artifacts = [{ artifactId: 'artifact:preview', label: 'Preview',
      logicalPath: 'preview.png', contentType: 'image/png', contentMode: 'fixed' }];
    records.push(record);
    await append('tool.completed', { record }, { runId, callId });
  }
  const settle = async () => {
    await append('run.finishing', { outcome: 'cancelled' }, { runId });
    await append('run.runtime.released', { runRuntimeSnapshotRef: runtime.runRuntimeSnapshotRef,
      extensionGenerationRef: runtime.extensionGenerationRef, kernelCatalogSnapshotRef: runtime.kernelCatalogSnapshotRef,
      providerRuntimeRef: runtime.provider.providerRuntimeRef, pluginInstanceRefs: [], alreadyReleased: false }, { runId });
    await append('run.settled', { outcome: 'cancelled' }, { runId });
  };
  return { journal, sessionId, runId, events, append, settle, records, index };
}
function expectedResources(events, sessionId, recordIds = []) {
  const p = projectSession(recoverSession(sessionId, events));
  return { sessionId, revision: p.revision, workspaceBindings: p.workspaceBindings,
    messages: p.messages.map(({filesystemReferences})=>({filesystemReferences})), shellAuthorizations: p.shellAuthorizations, artifacts: p.artifacts,
    activities: p.activities.filter(a=>a.tool?.recordId && recordIds.includes(a.tool.recordId)).map(a=>({tool:{recordId:a.tool.recordId,
      ...(a.tool.fileChanges?{fileChanges:a.tool.fileChanges}:{})}})) };
}

test('resource views equal full projection fields, select only requested records and never activate an Actor or full journal read', async t => {
  const f=await fixture();const original=structuredClone(f.events);
  const service=new SessionService(f.journal,{async create(){throw new Error('resource_view_started_actor');}});t.after(()=>service.dispose());
  f.journal.read=async function*(){throw new Error('resource_view_read_full_journal');};
  for(const ids of [[],[f.records[0].recordId],f.records.map(r=>r.recordId),['record:absent']]) {
    assert.deepEqual(await service.resourceSnapshot(f.sessionId,ids),expectedResources(f.events,f.sessionId,ids));
  }
  const narrow=await f.journal.readResources(f.sessionId,[f.records[0].recordId]);
  const encoded=JSON.stringify(narrow);
  assert.ok(!encoded.includes('BODY_NOT_FOR_RESOURCE_READ'));
  assert.ok(encoded.includes('TOOL_BODY_session'));
  assert.ok(!encoded.includes('TOOL_BODY_run'));
  assert.ok(!encoded.includes('runtimeSnapshot'));
  const view=await service.resourceSnapshot(f.sessionId);view.workspaceBindings[0].displayName='not canonical';
  assert.deepEqual(await service.resourceSnapshot(f.sessionId),expectedResources(f.events,f.sessionId));
  assert.deepEqual(f.events,original);
});

test('artifact previews use resource fields and retain full projection visibility and decoding errors', async t => {
  const f=await fixture(true);
  const service=new SessionService(f.journal,{async create(){throw new Error('artifact_preview_started_actor');}});t.after(()=>service.dispose());
  f.journal.read=async function*(){throw new Error('artifact_preview_read_full_journal');};
  const view=await service.resourceSnapshot(f.sessionId);
  assert.deepEqual(view,expectedResources(f.events,f.sessionId));
  assert.deepEqual(view.artifacts.map(a=>a.artifactId),['artifact:preview']);
  assert.equal(view.activities.length,0);
  const read=await f.journal.readResources(f.sessionId);
  assert.ok(!JSON.stringify(read).includes('TOOL_BODY_run'));
  const bad=structuredClone(read);
  const badRecord=bad.events.find(e=>e.payload.record)?.payload.record;
  badRecord.output.artifacts[0].contentType=null;
  assert.deepEqual(projectSessionResources(bad,[],projectResourceTool).artifacts,[]);
  const badEvents=structuredClone(f.events);
  badEvents.find(e=>e.type==='tool.completed').payload.record.output.artifacts[0].contentType=null;
  assert.deepEqual(projectSessionResources(bad,[],projectResourceTool),expectedResources(badEvents,f.sessionId));
  await f.settle();
  await f.append('conversation.revised',{commandId:'command:edit',messageId:'message:input',fromSequence:3,throughSequence:f.events.at(-1).sequence});
  const revised=await service.resourceSnapshot(f.sessionId);
  assert.deepEqual(revised,expectedResources(f.events,f.sessionId));
  assert.deepEqual(revised.artifacts,[]);
});

test('resource grants, revocation, workspace membership and message edits retain full replay semantics',async t=>{
  const f=await fixture();const service=new SessionService(f.journal,{async create(){throw new Error('unexpected_actor');}});t.after(()=>service.dispose());
  const check=async()=>assert.deepEqual(await service.resourceSnapshot(f.sessionId,f.records.map(r=>r.recordId)),expectedResources(f.events,f.sessionId,f.records.map(r=>r.recordId)));
  await check();await f.settle();await check();
  assert.deepEqual((await service.resourceSnapshot(f.sessionId)).shellAuthorizations.map(g=>g.scope),['sessionFiles']);
  const base={workspaceId:'workspace:replacement',displayName:'Replacement'};
  await f.append('session.workspaces.updated',{commandId:'command:base',baseBindings:[base],workspaceBindings:[base,f.index]});await check();
  await f.append('session.directory-index.detached',{commandId:'command:detach',workspaceId:f.index.workspaceId});await check();
  const through=f.events.at(-1).sequence;
  await f.append('conversation.revised',{commandId:'command:edit',messageId:'message:input',fromSequence:3,throughSequence:through});await check();
  const edited=await service.resourceSnapshot(f.sessionId,f.records.map(r=>r.recordId));
  assert.equal(edited.messages.length,0);assert.equal(edited.activities.length,0);assert.equal(edited.shellAuthorizations.length,1);
  await f.append('approval.revoked',{commandId:'command:revoke',authorityId:'authority:session'},{runId:f.runId});await check();
  assert.equal((await service.resourceSnapshot(f.sessionId)).shellAuthorizations.length,0);
});

test('overlapping resource previews share one read, isolate results and discard successful or failed reads afterwards', async t => {
  const f=await fixture(true), originalRead=f.journal.readResources.bind(f.journal);
  const service=new SessionService(f.journal,{async create(){throw new Error('unexpected_actor');}});t.after(()=>service.dispose());
  let release, reads=0;
  const gate=new Promise(resolve=>{release=resolve;});
  f.journal.readResources=async(...args)=>{reads++;await gate;return originalRead(...args);};
  const pending=[service.resourceSnapshot(f.sessionId),service.resourceSnapshot(f.sessionId)];
  assert.equal(reads,1);release();
  const [first,second]=await Promise.all(pending);
  assert.deepEqual(first,expectedResources(f.events,f.sessionId));assert.deepEqual(second,first);
  first.artifacts[0].label='caller mutation';
  assert.equal(second.artifacts[0].label,'Preview');
  assert.deepEqual(await service.resourceSnapshot(f.sessionId),expectedResources(f.events,f.sessionId));
  assert.equal(reads,2);
  const failure=new Error('fresh_resource_read_failure');
  f.journal.readResources=async()=>{reads++;throw failure;};
  const failed=await Promise.allSettled([service.resourceSnapshot(f.sessionId),service.resourceSnapshot(f.sessionId)]);
  assert.equal(reads,3);
  for(const result of failed){assert.equal(result.status,'rejected');assert.equal(result.reason,failure);}
  f.journal.readResources=originalRead;
  assert.deepEqual(await service.resourceSnapshot(f.sessionId),expectedResources(f.events,f.sessionId));
});

test('resource reads preserve fresh journal errors and reject wrong identity, order and missing approval facts',async t=>{
  const f=await fixture();const read=f.journal.readResources.bind(f.journal);
  const service=new SessionService(f.journal,{async create(){throw new Error('unexpected_actor');}});t.after(()=>service.dispose());
  f.journal.readResources=async()=>{throw new Error('original_resource_read_failure');};
  await assert.rejects(service.resourceSnapshot(f.sessionId),/original_resource_read_failure/);
  f.journal.readResources=read;assert.equal((await service.resourceSnapshot(f.sessionId)).revision,f.events.length);
  const value=await read(f.sessionId);
  for(const bad of [{...value,events:value.events.map((e,i)=>i===1?{...e,sessionId:'session:other'}:e)},
    {...value,events:[value.events[0],value.events[0]]}]) assert.throws(()=>projectSessionResources(bad,[],projectResourceTool),/session_event_/);
  const missing={...value,events:value.events.filter(e=>e.type!=='approval.requested')};
  assert.throws(()=>projectSessionResources(missing,[],projectResourceTool),/approval_request_missing/);
  await f.journal.deleteSession(f.sessionId);await assert.rejects(service.resourceSnapshot(f.sessionId),/session_not_found/);
});

test('exclusive history replay shares the reducer semantics but cannot mutate caller events or later public snapshots',async()=>{
  const f=await fixture();await f.settle();const original=structuredClone(f.events);
  let state=emptySessionState(f.sessionId);
  for(let i=0;i<f.events.length;i++) {
    const previous=state;const before=structuredClone(previous);
    state=reduceSession(previous,f.events[i]);
    assert.deepEqual(previous,before,'public reduce must not change its input state');
    assert.deepEqual(before,i===0?emptySessionState(f.sessionId):recoverSession(f.sessionId,f.events.slice(0,i)));
    assert.deepEqual(state,recoverSession(f.sessionId,f.events.slice(0,i+1)));
  }
  const recovered=recoverSession(f.sessionId,f.events.slice(0,5));const saved=structuredClone(recovered);
  reduceSession(recovered,f.events[5]);assert.deepEqual(recovered,saved,'recovered state does not retain writable replay ownership');
  const invalid={...f.events[5],sequence:recovered.revision+2};
  assert.throws(()=>reduceSession(recovered,invalid),/session_event_sequence_gap/);assert.deepEqual(recovered,saved);
  assert.deepEqual(f.events,original);
});
