import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadGuiModules, loadGuiModelStore, installGuiFetch, decodeGuiProjection } from './gui-projection-contract.mjs';
import { InMemoryCommandJournal } from '../../session-core/tests/support/memoryJournal.mjs';
import { workspaceBinding, actorWith, createSession, fakeRunPreparation, emptyKernel, completedExecutionReply, providerEvent, messageCommand, waitForProjection, waitUntil } from '../../session-core/tests/local-agent-fixtures.mjs';
import { emptySessionState, projectSession } from '../../session-core/dist/index.js';

test('history navigation is usable before plugin/model discovery settles and late startup cannot rewind it', async t => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  t.after(release);
  const sessionId = 'session:early-history', projection = projectSession(emptySessionState(sessionId));
  installGuiFetch(t, async url => {
    if (url.pathname.endsWith('/catalog')) return Response.json({ok:true,data:{projects:[],sessions:[{id:sessionId,title:'History',workspaceBindings:[],createdAt:'1',updatedAt:'1'}]}});
    if (url.pathname.endsWith('/plugins')) { await held; return Response.json({ok:true,data:{revision:'catalog:slow',plugins:[]}}); }
    if (url.pathname.endsWith('/profiles')) { await held; return Response.json({ok:true,data:{profiles:[]}}); }
    if (url.pathname.endsWith('/statuses')) return Response.json({ok:true,data:[]});
    if (url.pathname.endsWith('/projection')) return Response.json({ok:true,data:projection});
    throw new Error(`Unexpected request: ${url.pathname}`);
  });
  const store = await loadGuiModelStore(t);
  const initializing = store.getState().initialize();
  await waitUntil(() => store.getState().catalog.sessions.length === 1, 'early catalog');
  assert.equal(store.getState().loading, false);
  await store.getState().activateSession(sessionId);
  assert.equal(store.getState().projection.sessionId, sessionId);
  release(); await initializing;
  assert.equal(store.getState().projection.sessionId, sessionId);
  assert.equal(store.getState().loading, false);
});

test('catalog edits made during startup survive late plugin/model discovery', async t => {
  for (const navigate of [false, true]) await t.test(navigate ? 'after navigation' : 'in the initial draft', async t => {
    let release;
    const held = new Promise(resolve => { release = resolve; });
    t.after(release);
    const project = (id, title) => ({ id, title, workspaceBindings: [], createdAt: '1', updatedAt: '1' });
    let catalog = { projects: [project('project:keep', 'Original'), project('project:remove', 'Remove')], sessions: [] };
    installGuiFetch(t, async (url, init) => {
      if (url.pathname.endsWith('/catalog')) return Response.json({ ok: true, data: catalog });
      if (url.pathname.endsWith('/plugins')) { await held; return Response.json({ ok: true, data: { revision: 'catalog:slow', plugins: [] } }); }
      if (url.pathname.endsWith('/profiles')) { await held; return Response.json({ ok: true, data: { profiles: [] } }); }
      if (url.pathname.endsWith('/statuses')) return Response.json({ ok: true, data: [] });
      if (url.pathname.endsWith('/projects') && init.method === 'POST') {
        catalog = { ...catalog, projects: [...catalog.projects, project('project:new', JSON.parse(init.body).title)] };
      } else if (url.pathname.endsWith('/projects/project%3Akeep') && init.method === 'PATCH') {
        catalog = { ...catalog, projects: catalog.projects.map(item => item.id === 'project:keep' ? { ...item, title: JSON.parse(init.body).title } : item) };
      } else if (url.pathname.endsWith('/projects/project%3Aremove') && init.method === 'DELETE') {
        catalog = { ...catalog, projects: catalog.projects.filter(item => item.id !== 'project:remove') };
      } else throw new Error(`Unexpected request: ${init.method} ${url.pathname}`);
      return Response.json({ ok: true, data: catalog });
    });
    const store = await loadGuiModelStore(t);
    const initializing = store.getState().initialize();
    await waitUntil(() => !store.getState().loading, 'early navigation');
    await store.getState().createProject('Created while loading');
    await store.getState().updateProject('project:keep', { title: 'Renamed while loading' });
    await store.getState().deleteProject('project:remove');
    if (navigate) store.getState().startNewSession('project:new');
    const expected = structuredClone(catalog);
    assert.deepEqual(store.getState().catalog, expected);
    release(); await initializing;
    assert.deepEqual(store.getState().catalog, expected, 'late startup must preserve completed catalog operations');
    assert.equal(store.getState().draftProjectId, navigate ? 'project:new' : null);
    assert.equal(store.getState().loading, false);
  });
});

test('a quiet Shell displays its command before completion, then a bounded live tail without expanding details', async t => {
  const previous = globalThis.self; globalThis.self = {};
  t.after(() => { if (previous === undefined) delete globalThis.self; else globalThis.self = previous; });
  const journal = new InMemoryCommandJournal(), sessionId = 'session:quiet-shell';
  await createSession(journal, sessionId, [workspaceBinding]);
  const tool = {toolBindingRef:'binding:bash',name:'bash',description:'Shell progress test',inputSchema:{type:'object',required:['command'],properties:{command:{type:'string'}}},possibleEffects:['process'],availability:'callable',origin:'coreBuiltin'};
  let release, publish, calls = 0;
  const held = new Promise(resolve => { release = resolve; });
  const actor = actorWith(journal, sessionId, { async *stream(request) {
    if (calls++ === 0) yield providerEvent(request.requestId, 'tool.call', {callId:'provider:shell',name:request.tools.find(item => item.description === tool.description).name,input:{workspace:'primary',command:'printf started; sleep 120; printf done'}});
    else yield providerEvent(request.requestId, 'assistant.message', {messageId:'message:done',content:'Done.'});
    yield providerEvent(request.requestId, 'completed', {});
  } }, emptyKernel({async execute(request, onProgress) {
    publish = onProgress;
    await onProgress({type:'started',startedAt:String(Date.now()-120000)});
    await held;
    return completedExecutionReply(request, {});
  }}), fakeRunPreparation({tools:[tool]}).port, 'quiet-shell');
  t.after(async () => { release(); await actor.dispose(); });
  await actor.submit(messageCommand(sessionId,'command:shell','Run the Shell.'));
  const base = await waitForProjection(actor, p => p.activities.some(a => a.status === 'active' && a.callId));
  const activity = base.activities.find(a => a.callId);
  assert.equal(activity.tool.shell.command,'printf started; sleep 120; printf done');
  assert.equal(activity.tool.shell.result, undefined);
  assert.deepEqual(await decodeGuiProjection(base), base);
  const [{ToolActivityGroup}, {ConversationVirtualRow}, {shellOutputTail}] = await loadGuiModules(t,[
    '/src/components/local-agent/ToolActivityDetails.tsx','/src/components/local-agent/ConversationVirtualRow.tsx','/src/components/local-agent/shellProgress.ts']);
  const layout = {state:new Map()};
  const render = a => renderToStaticMarkup(createElement(ConversationVirtualRow,{rowKey:'shell',eager:true,virtualizer:{layout:()=>layout},children:()=>createElement(ToolActivityGroup,{activities:[a],language:'zh-CN',onExpand(){},onOpenWorkspaceResource(){}})}));
  // Module loading under a busy test runner must not advance this elapsed-time
  // fixture across a whole-second boundary. Keep the exact 120-second assertion.
  assert.ok(Number.isFinite(Number(activity.startedAt)));
  t.mock.method(Date, 'now', () => Number(activity.startedAt) + 120000);
  const quiet = render(activity);
  assert.match(quiet,/sleep 120/); assert.match(quiet,/尚无输出/); assert.match(quiet,/120 秒/);
  assert.doesNotMatch(quiet,/退出码/);
  const text = 'old-hidden\nline-one\nline-two\nline-three\n';
  await publish({type:'output',stream:'stdout',offset:0,bytes:[...new TextEncoder().encode(text)]});
  const updated = await actor.snapshot();
  assert.equal(updated.revision,base.revision);
  const live = updated.activities.find(a => a.callId === activity.callId);
  assert.match(render(live),/line-three/); assert.doesNotMatch(render(live),/old-hidden/);
  assert.match(render(live),/aria-expanded="false"/);
  layout.state.set(`tool:${activity.activityId}:expanded`,true);
  assert.match(render(live),/old-hidden/,'expanding from the compact window preserves the complete available output');
  assert.equal(shellOutputTail('10%\r20%\r30%\r40%'), '20%\n30%\n40%');
  assert.equal(shellOutputTail('x'.repeat(10000)).length,241);
});
