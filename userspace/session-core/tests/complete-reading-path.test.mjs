// TCR: T-020-GUI_Startup-20261121/locality-fix/revision-window/stable-reader-evolution-01/TCR.md
import test from 'node:test';
import assert from 'node:assert/strict';
import { SessionService } from '../dist/index.js';
import { InMemoryCommandJournal } from './support/memoryJournal.mjs';
import { createSession } from './local-agent-fixtures.mjs';

test('an archived family cannot fit a message-only window: refuse content without replay and keep the exact boundary and read errors', async t => {
  const journal = new InMemoryCommandJournal(), id = 'session:family-view';
  await createSession(journal, id);
  await journal.append({type:'agent.task.created',sessionId:id,runId:'run:test',callId:'call:task',payload:{ taskId:'task:one', agentSessionId:'session:child', displayName:'Child', delivery:'async',createsAgent:true, capabilities:{messaging:true,delegation:false,continuation:true},text:'child task' }});
  const s = new SessionService(journal, {async create(){throw Error('unexpected_actor')}}); t.after(()=>s.dispose());
  const lifecycle = await journal.readAgentLifecycle(id); const query = {view:'readingWindow',sessionId:id,throughSequence:lifecycle.revision};
  let full = 0; journal.read = async function*(){full++;throw Error('full_read_or_permission_error')};
  assert.deepEqual(await s.read(query),{sessionId:id,revision:lifecycle.revision,view:'readingWindow',items:[],nextBefore:null,readingWindow:{kind:'requiresProjection'}});
  assert.equal(full,0);await assert.rejects(s.read({...query,throughSequence:lifecycle.revision+1}),/revision_changed/);
  await assert.rejects(s.snapshot(id),/full_read_or_permission_error/); // The refusal has not authorized, validated or cached any history.
  journal.readAgentLifecycle=async()=>{throw Error('family_read_denied')};await assert.rejects(s.read(query),/family_read_denied/);
  journal.readAgentLifecycle=async()=>({...lifecycle,sessionId:'elsewhere'});await assert.rejects(s.read(query),/session_event_identity_mismatch/);
});

test('a large recent root fits the existing total history budget; a new journal version must still be read', async t=>{
  const j=new InMemoryCommandJournal();const root='session:recent-root';await createSession(j,root);
  await j.append({type:'message.committed',sessionId:root,payload:{messageId:'big',role:'user',content:'x'.repeat(9*1024*1024)}});
  const s=new SessionService(j,{async create(){throw Error('unexpected_actor')}});t.after(()=>s.dispose());
  const original=j.read.bind(j);let version=1,reads=0;j.historyVersion=async()=>String(version);
  j.read=async function*(id){if(id===root)reads++;yield* original(id)};
  await s.snapshot(root);await s.snapshot(root);assert.equal(reads,1,'one view within the total history budget');
  version++;await s.snapshot(root);assert.equal(reads,2,'cross-version reuse is forbidden');
});
