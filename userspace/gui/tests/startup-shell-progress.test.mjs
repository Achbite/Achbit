import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { findReactElement, loadGuiModules, loadGuiModelStore, installGuiFetch, decodeGuiProjection } from './gui-projection-contract.mjs';
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

test('welcome is chosen randomly and remains stable while the new conversation is empty', async t => {
  const [{ createLocalAgentStore }, { useSettingsStore }] = await loadGuiModules(t, [
    '/src/state/localAgentStore.ts', '/src/state/settingsStore.ts',
  ]);
  t.mock.method(useSettingsStore.getState(), 'loadUserSettings', async () => {});
  let random = 0.62;
  t.mock.method(Math, 'random', () => random);
  const store = createLocalAgentStore();
  assert.equal(store.getState().welcomeIndex, 2, 'the initial welcome uses the random selection');

  random = 0.91;
  for (const projectId of [null, null, 'project:one', 'project:one', 'project:two', null]) {
    store.getState().startNewSession(projectId);
    assert.equal(store.getState().welcomeIndex, 2, 'both new conversation entries retain the current welcome');
    assert.equal(store.getState().draftProjectId, projectId);
    assert.equal(store.getState().sessionId, null);
  }

  const sessionId = 'session:history';
  store.setState({ sessionId, projection: projectSession(emptySessionState(sessionId)) });
  store.getState().startNewSession('project:one');
  assert.equal(store.getState().welcomeIndex, 3, 'leaving a conversation chooses a new random welcome');
  assert.equal(store.getState().projection, null);
  random = 0.13;
  store.getState().startNewSession(null);
  assert.equal(store.getState().welcomeIndex, 3, 'repeated clicks do not redraw the random selection');
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

test('native startup completion wakes the observer and its subscription is released', async t => {
  const previous = globalThis.window;
  let callback, removed = false, observed = 0;
  globalThis.window = { location: new URL('deepcode-gui://localhost/index.html'), __TAURI__: {
    core: { invoke: async () => {} },
    event: { listen: async (name, handler) => {
      assert.equal(name, 'deepcode:host-startup-complete');
      callback = handler;
      return () => { removed = true; };
    } },
  } };
  t.after(() => { if (previous === undefined) delete globalThis.window; else globalThis.window = previous; });
  const [{ onHostStartupComplete, isRuntimeReady }] = await loadGuiModules(t, ['/src/services/runtimeAdapter.ts']);
  const stop = await onHostStartupComplete(() => observed++);
  callback({ payload: null });
  assert.equal(observed, 1);
  assert.equal(isRuntimeReady({ok:true,data:{ok:true,status:'ok',kernel:'ready',session:'starting'}}), false, 'a wakeup never replaces the actual health check');
  assert.equal(isRuntimeReady({ok:true,data:{ok:true,status:'ok',kernel:'ready',session:'ready'}}), true);
  stop(); assert.equal(removed, true);
  globalThis.window.__DEEPCODE_BROWSER_PREVIEW__ = true;
  const previewStop = await onHostStartupComplete(() => observed++);
  previewStop(); assert.equal(observed, 1);
});


test('catalog loading and failure never masquerade as an empty history', async t => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  t.after(release);
  let failed = true;
  installGuiFetch(t, async url => {
    if (url.pathname.endsWith('/catalog')) {
      await held;
      if (failed) throw new Error('catalog transport failed');
      return Response.json({ ok: true, data: { projects: [], sessions: [] } });
    }
    if (url.pathname.endsWith('/plugins')) return Response.json({ ok: true, data: { revision: 'catalog:empty', plugins: [] } });
    if (url.pathname.endsWith('/profiles')) return Response.json({ ok: true, data: { profiles: [] } });
    if (url.pathname.endsWith('/statuses')) return Response.json({ ok: true, data: [] });
    throw new Error(`Unexpected request: ${url.pathname}`);
  });
  const [{ useLocalAgentStore: store }, { default: Sidebar }] = await loadGuiModules(t, [
    '/src/state/localAgentStore.ts', '/src/achbit-gui/layout/AchbitSidebar.tsx',
  ]);
  const render = () => renderToStaticMarkup(createElement(Sidebar, {
    language: 'en-US', ...store.getState().catalog, catalogStatus: store.getState().catalogStatus,
    collapsedProjectIds: new Set(), sessionStatuses: {}, readRunMarkers: {},
  }));
  const initializing = store.getState().initialize();
  assert.equal(store.getState().catalogStatus, 'pending');
  assert.match(render(), /Loading conversations/);
  assert.doesNotMatch(render(), /No projects yet|No chats yet/);
  release(); await initializing;
  assert.equal(store.getState().catalogStatus, 'error');
  assert.equal(store.getState().error, 'catalog transport failed');
  assert.match(render(), /Unable to load conversations/);
  assert.doesNotMatch(render(), /No projects yet|No chats yet/);
  failed = false;
  await store.getState().refreshCatalog();
  assert.equal(store.getState().catalogStatus, 'ready');
  assert.match(render(), /No projects yet/);
  assert.match(render(), /No chats yet/);
});

test('plugin discovery failure does not invalidate a successfully loaded catalog', async t => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  t.after(release);
  installGuiFetch(t, async url => {
    if (url.pathname.endsWith('/catalog')) return Response.json({ ok: true, data: { projects: [], sessions: [] } });
    if (url.pathname.endsWith('/plugins')) { await held; throw new Error('plugin discovery failed'); }
    if (url.pathname.endsWith('/profiles')) return Response.json({ ok: true, data: { profiles: [] } });
    if (url.pathname.endsWith('/statuses')) return Response.json({ ok: true, data: [] });
    throw new Error(`Unexpected request: ${url.pathname}`);
  });
  const store = await loadGuiModelStore(t);
  const initializing = store.getState().initialize();
  await waitUntil(() => !store.getState().loading, 'catalog ready');
  assert.equal(store.getState().catalogStatus, 'ready');
  release(); await initializing;
  assert.equal(store.getState().catalogStatus, 'ready');
  assert.equal(store.getState().error, 'plugin discovery failed');
});

test('the draft welcome stays visible during catalog loading; opening history retains its loading state', async t => {
  const oldSelf = globalThis.self, oldStorage = globalThis.sessionStorage;
  globalThis.self = {};
  globalThis.sessionStorage = { getItem: () => null };
  t.after(() => {
    if (oldSelf === undefined) delete globalThis.self; else globalThis.self = oldSelf;
    if (oldStorage === undefined) delete globalThis.sessionStorage; else globalThis.sessionStorage = oldStorage;
  });
  const [{ default: Panel }, { ConversationTranscript }, { ConversationDisplayProvider },
    { useLocalAgentStore: store }] = await loadGuiModules(t, [
    '/src/components/local-agent/LocalAgentPanel.tsx', '/src/components/local-agent/ConversationTranscript.tsx',
    '/src/components/local-agent/ConversationDisplayProvider.tsx', '/src/state/localAgentStore.ts',
  ]);
  let transcript;
  function Probe() {
    transcript = findReactElement(Panel({}), node => node.type === ConversationTranscript);
    return null;
  }
  const render = sessionId => {
    store.setState({ sessionId, projection: null, loading: true,
      loadingPurpose: sessionId ? 'session' : 'initialization', catalogStatus: 'pending' });
    Object.assign(store.getInitialState(), store.getState());
    renderToStaticMarkup(createElement(ConversationDisplayProvider, null, createElement(Probe)));
    return renderToStaticMarkup(transcript);
  };
  assert.match(render(null), /local-agent__empty--welcome/);
  assert.equal(store.getState().loading, true, 'the request remains busy while its welcome is shown');
  assert.doesNotMatch(render('session:opening'), /local-agent__empty--welcome/);
  assert.equal(transcript.props.loading, true);
});


test('opening an uncatalogued session keeps its loading purpose through lookup failure and cancellation', async t => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  t.after(release);
  installGuiFetch(t, async url => {
    if (url.pathname.endsWith('/catalog')) { await held; throw new Error('catalog lookup failed'); }
    throw new Error(`Unexpected request: ${url.pathname}`);
  });
  const [{ useLocalAgentStore: store }, { useSettingsStore }] = await loadGuiModules(t, [
    '/src/state/localAgentStore.ts', '/src/state/settingsStore.ts',
  ]);
  t.mock.method(useSettingsStore.getState(), 'loadUserSettings', async () => {});
  store.setState({ catalogStatus: 'ready' });
  const opening = store.getState().activateSession('session:external');
  assert.equal(store.getState().sessionId, null, 'identity is not changed before catalog lookup');
  assert.equal(store.getState().loading, true);
  assert.equal(store.getState().loadingPurpose, 'session');
  store.getState().startNewSession();
  release(); await opening;
  assert.equal(store.getState().loading, false);
  assert.equal(store.getState().loadingPurpose, null);
  assert.equal(store.getState().catalogStatus, 'ready', 'cancelled navigation does not publish a directory error');
  assert.equal(store.getState().error, null);
  await store.getState().activateSession('session:external');
  assert.equal(store.getState().catalogStatus, 'error');
  assert.equal(store.getState().error, 'catalog lookup failed');
  assert.equal(store.getState().loadingPurpose, null);
});

test('an old startup catalog failure cannot invalidate a newer successful catalog', async t => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  t.after(release);
  let reads = 0;
  installGuiFetch(t, async url => {
    if (url.pathname.endsWith('/catalog')) {
      if (++reads === 1) { await held; throw new Error('old catalog request failed'); }
      return Response.json({ ok: true, data: { projects: [], sessions: [] } });
    }
    if (url.pathname.endsWith('/plugins')) throw new Error('plugin discovery failed early');
    if (url.pathname.endsWith('/profiles')) return Response.json({ ok: true, data: { profiles: [] } });
    throw new Error(`Unexpected request: ${url.pathname}`);
  });
  const store = await loadGuiModelStore(t);
  await store.getState().initialize();
  await store.getState().refreshCatalog();
  assert.equal(store.getState().catalogStatus, 'ready');
  release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(store.getState().catalogStatus, 'ready');
  assert.equal(store.getState().error, 'plugin discovery failed early', 'the original initialization failure is retained');
});


test('cancelling a catalog lookup does not leave failed startup permanently pending', async t => {
  let releaseStartup, releaseLookup;
  const startup = new Promise(resolve => { releaseStartup = resolve; });
  const lookup = new Promise(resolve => { releaseLookup = resolve; });
  t.after(() => { releaseStartup(); releaseLookup(); });
  let reads = 0;
  installGuiFetch(t, async url => {
    if (url.pathname.endsWith('/catalog')) {
      await (++reads === 1 ? startup : lookup);
      throw new Error('directory unavailable');
    }
    if (url.pathname.endsWith('/plugins')) return Response.json({ ok: true, data: { revision: 'catalog:empty', plugins: [] } });
    if (url.pathname.endsWith('/profiles')) return Response.json({ ok: true, data: { profiles: [] } });
    throw new Error(`Unexpected request: ${url.pathname}`);
  });
  const [{ useLocalAgentStore: store }, { useSettingsStore }] = await loadGuiModules(t, [
    '/src/state/localAgentStore.ts', '/src/state/settingsStore.ts',
  ]);
  t.mock.method(useSettingsStore.getState(), 'loadUserSettings', async () => {});
  const initializing = store.getState().initialize();
  const opening = store.getState().activateSession('session:external');
  store.getState().startNewSession();
  releaseLookup(); await opening;
  assert.equal(store.getState().catalogStatus, 'pending');
  releaseStartup(); await initializing;
  assert.equal(store.getState().catalogStatus, 'error');
  assert.equal(store.getState().sessionId, null);
  assert.equal(store.getState().loadingPurpose, null);
});

test('startup publishes models before plugin discovery and preserves a later user selection', async t => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  t.after(release);
  const profiles = [
    { id: 'profile:first', enabled: true, reasoningEffort: 'medium' },
    { id: 'profile:chosen', enabled: true, reasoningEffort: 'high' },
  ];
  installGuiFetch(t, async url => {
    if (url.pathname.endsWith('/catalog')) return Response.json({ ok:true, data:{projects:[],sessions:[]} });
    if (url.pathname.endsWith('/profiles')) return Response.json({ok:true,data:{profiles,defaultProfileId:profiles[0].id}});
    if (url.pathname.endsWith('/plugins')) { await held; throw new Error('plugin discovery unavailable'); }
    if (url.pathname.endsWith('/statuses')) return Response.json({ok:true,data:[]});
    throw new Error(`Unexpected request: ${url.pathname}`);
  });
  const store = await loadGuiModelStore(t);
  const initializing = store.getState().initialize();
  await waitUntil(() => store.getState().profiles.length === 2, 'independent model configuration');
  assert.equal(store.getState().selectedProfileId, profiles[0].id);
  store.setState({selectedProfileId:profiles[1].id,reasoningEffortOverride:'high'});
  release(); await initializing;
  assert.equal(store.getState().selectedProfileId, profiles[1].id);
  assert.equal(store.getState().reasoningEffortOverride, 'high');
  assert.equal(store.getState().catalogStatus, 'ready');
  assert.equal(store.getState().error, 'plugin discovery unavailable');
});

test('history selection can supersede a pending read while mutations remain busy', async t => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  t.after(release);
  const sessions = ['slow','chosen'].map(name => ({id:`session:${name}`,title:name,workspaceBindings:[],createdAt:'1',updatedAt:'1'}));
  installGuiFetch(t, async url => {
    if (url.pathname.endsWith('/statuses')) return Response.json({ok:true,data:[]});
    if (url.pathname.endsWith('/projection')) {
      const id = decodeURIComponent(url.pathname.split('/').at(-2));
      if (id === sessions[0].id) await held;
      return Response.json({ok:true,data:projectSession(emptySessionState(id))});
    }
    throw new Error(`Unexpected request: ${url.pathname}`);
  });
  const [{ useLocalAgentStore: store }, { default: Sidebar }, { useSettingsStore }] = await loadGuiModules(t, [
    '/src/state/localAgentStore.ts', '/src/achbit-gui/layout/AchbitSidebar.tsx', '/src/state/settingsStore.ts',
  ]);
  t.mock.method(useSettingsStore.getState(), 'loadUserSettings', async () => {});
  store.setState({catalog:{projects:[],sessions},catalogStatus:'ready'});
  const slow = store.getState().activateSession(sessions[0].id);
  await waitUntil(() => store.getState().loading, 'pending history');
  let tree;
  function Probe() {
    tree = Sidebar({language:'en-US',projects:[],sessions,catalogStatus:'ready',
      sessionStatuses:{},readRunMarkers:{},collapsedProjectIds:new Set(),busy:true,activationBusy:false,
      onActivateSession: session => store.getState().activateSession(session.id)});
    return tree;
  }
  renderToStaticMarkup(createElement(Probe));
  const choose = findReactElement(tree, node => node.type === 'button' && node.props.title === 'chosen');
  assert.equal(choose.props.disabled, false, 'history loading does not disable another selection');
  await choose.props.onClick();
  assert.equal(store.getState().projection.sessionId, sessions[1].id);
  release(); await slow;
  assert.equal(store.getState().projection.sessionId, sessions[1].id, 'the late old read cannot replace the chosen view');
  assert.equal(store.getState().loading, false);
});

test('late history restoration still receives the initial default model', async t => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  t.after(release);
  const sessionId = 'session:no-recorded-model';
  installGuiFetch(t, async url => {
    if (url.pathname.endsWith('/catalog')) return Response.json({ok:true,data:{projects:[],sessions:[{id:sessionId,title:'Old history',workspaceBindings:[],createdAt:'1',updatedAt:'1'}]}});
    if (url.pathname.endsWith('/profiles')) return Response.json({ok:true,data:{profiles:[{id:'profile:default',enabled:true}]}});
    if (url.pathname.endsWith('/plugins')) { await held; return Response.json({ok:true,data:{revision:'catalog:empty',plugins:[]}}); }
    if (url.pathname.endsWith('/statuses')) return Response.json({ok:true,data:[]});
    if (url.pathname.endsWith('/projection')) return Response.json({ok:true,data:projectSession(emptySessionState(sessionId))});
    throw new Error(`Unexpected request: ${url.pathname}`);
  });
  const [{useLocalAgentStore:store},{useSettingsStore}] = await loadGuiModules(t, ['/src/state/localAgentStore.ts','/src/state/settingsStore.ts']);
  t.mock.method(useSettingsStore.getState(),'loadUserSettings',async()=>{});
  const initializing=store.getState().initialize();
  await waitUntil(()=>store.getState().defaultProfileId==='profile:default','initial profiles');
  await store.getState().activateSession(sessionId);
  release(); await initializing;
  assert.equal(store.getState().sessionId,sessionId);
  assert.equal(store.getState().selectedProfileId,'profile:default');
});

test('late history restoration cannot swallow the initial profile error', async t => {
  let release;
  const held = new Promise(resolve => { release = resolve; });
  t.after(release);
  const sessionId = 'session:profile-failure';
  installGuiFetch(t, async url => {
    if (url.pathname.endsWith('/catalog')) return Response.json({ok:true,data:{projects:[],sessions:[{id:sessionId,title:'History',workspaceBindings:[],createdAt:'1',updatedAt:'1'}]}});
    if (url.pathname.endsWith('/profiles')) return Response.json({ok:false,message:'original profile failure'});
    if (url.pathname.endsWith('/plugins')) { await held; return Response.json({ok:true,data:{revision:'catalog:empty',plugins:[]}}); }
    if (url.pathname.endsWith('/statuses')) return Response.json({ok:true,data:[]});
    if (url.pathname.endsWith('/projection')) return Response.json({ok:true,data:projectSession(emptySessionState(sessionId))});
    throw new Error(`Unexpected request: ${url.pathname}`);
  });
  const [{useLocalAgentStore:store},{useSettingsStore}] = await loadGuiModules(t, ['/src/state/localAgentStore.ts','/src/state/settingsStore.ts']);
  t.mock.method(useSettingsStore.getState(),'loadUserSettings',async()=>{});
  const initializing=store.getState().initialize();
  await waitUntil(()=>store.getState().errorSource==='profiles','initial profile failure');
  await store.getState().activateSession(sessionId);
  release(); await initializing;
  assert.equal(store.getState().sessionId,sessionId);
  assert.equal(store.getState().errorSource,'profiles');
  assert.equal(store.getState().error,'original profile failure');
});
