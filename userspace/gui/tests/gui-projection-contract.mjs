import assert from 'node:assert/strict';
import { after } from 'node:test';
import { fileURLToPath } from 'node:url';
import { createServer } from 'vite';
import { Children, isValidElement } from 'react';

// Find a semantic control in an already-rendered React tree without fixing its
// wrapper depth or sibling position. This does not mount a browser DOM.
export function findReactElement(root, matches) {
  const found = [];
  const visit = value => Children.forEach(value, node => {
    if (!isValidElement(node)) return;
    if (matches(node)) found.push(node);
    visit(node.props.children);
  });
  visit(root);
  assert.equal(found.length, 1, 'expected exactly one matching control');
  return found[0];
}

// Load the real GUI module graph without a browser, file watcher, or listening server.
function createGuiLoader() {
  return createServer({
    root: fileURLToPath(new URL('../', import.meta.url)),
    configFile: false,
    envFile: false,
    appType: 'custom',
    server: { middlewareMode: true, hmr: false, ws: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
}

let guiLoader;
let guiApiPromise;
after(() => guiLoader?.close());

export async function loadGuiModelStore(t) {
  // Each store case owns its module-level initialization and request lifecycle.
  const loader = await createGuiLoader();
  t.after(() => loader.close());
  return (await loader.ssrLoadModule('/src/state/localAgentStore.ts')).useLocalAgentStore;
}

export function installGuiFetch(t, handler) {
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => handler(new URL(url), init);
  t.after(() => { globalThis.fetch = previousFetch; });
}

export async function decodeGuiProjection(projection) {
  const guiApi = await (guiApiPromise ??= createGuiLoader().then(loader => {
    guiLoader = loader;
    return loader.ssrLoadModule('/src/services/localAgentApi.ts');
  }));
  const previousFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    assert.equal(new URL(url).pathname,
      `/api/conversation/sessions/${encodeURIComponent(projection.sessionId)}/projection`);
    assert.equal(init.method ?? 'GET', 'GET');
    return Response.json({ ok: true, data: projection });
  };
  try {
    return await guiApi.getLocalAgentProjection(projection.sessionId);
  } finally {
    globalThis.fetch = previousFetch;
  }
}

export async function loadGuiModule(t, path) {
  return (await loadGuiModules(t, [path]))[0];
}

export async function loadGuiModules(t, paths) {
  const loader = await createGuiLoader();
  t.after(() => loader.close());
  return await Promise.all(paths.map((path) => loader.ssrLoadModule(path)));
}

/** A Host double for tests which already own a projected Session. Split at human turn boundaries. */
export function transcriptFixture(p, around) {
  const users=p.messages.filter(m=>m.role==='user'), starts=users.filter(m=>!m.runId).map(m=>m.sequence);
  const index=Math.max(0,starts.findLastIndex(n=>n<=(around??p.revision))), start=index?starts[index]:1;
  const next=starts[index+1]??null, end=next===null?p.revision:next-1;
  const within=x=>x.sequence>=start&&x.sequence<=end;
  const timeline=p.timeline.filter(within);
  const activityIds=new Set(timeline.flatMap(r=>r.activityIds??[])), planIds=new Set(timeline.map(r=>r.planId));
  const content={sessionId:p.sessionId,revision:p.revision,timeline,messages:p.messages.filter(within),narratives:p.narratives.filter(within),
    activities:p.activities.filter(x=>within(x)||activityIds.has(x.activityId)),plans:p.plans.filter(x=>planIds.has(x.planId)),
    interactions:p.interactions.filter(within),artifacts:p.artifacts,workspaceBindings:p.workspaceBindings,
    ...(p.runTimings?{runTimings:p.runTimings}:{}),...(p.fileChangeRounds?{fileChangeRounds:p.fileChangeRounds}:{})};
  const fields=['sessionId','revision','run','mode','modelSettings','subagentSettings','effectivePermissions','assistantDraft','pendingInteraction','pendingApproval','pendingApprovals',
    'pendingPlan','agentContext','agentTasks','agentChildren','pendingAgentDecisions','queuedInputs','terminalError','failureSnapshot','contextHandoff','providerAttempts'];
  const current=Object.fromEntries(fields.filter(k=>k in p).map(k=>[k,p[k]]));
  const transcript={sessionId:p.sessionId,revision:p.revision,start,end,previous:starts[index-1]??null,next,content,
    fileChangeDetails: (p.activities ?? []).filter(a=>a.tool?.recordId && a.tool.fileChanges?.length).map(a=>({runId:a.runId,activityId:a.activityId,tool:{recordId:a.tool.recordId,fileChanges:a.tool.fileChanges}})),
    navigation:users.map(m=>({sequence:m.sequence,key:m.messageId,label:m.content.trim().slice(0,180)})),...(next===null?{current}:{})};
  return {sessionId:p.sessionId,revision:p.revision,view:'transcript',items:[],nextBefore:transcript.previous,transcript};
}

export function overviewFixture(p) {
  const receipt=p.contextCompositions.find(r=>r.providerRequestId===p.contextUsage?.providerRequestId);
  const overview={sessionId:p.sessionId,revision:p.revision,todoList:p.todoList,todoRun:p.tokenUsageHistory.find(r=>r.runId===p.todoList?.runId)??null,
    totalTokenUsage:p.totalTokenUsage,deliverables:p.deliverables,childDeliverables:[],memberIds:(p.agentChildren??[]).map(m=>m.agentSessionId),
    measurement:receipt&&p.contextUsage?{usage:p.contextUsage,receipt:{sequence:receipt.sequence,partitions:receipt.partitions}}:null};
  return {sessionId:p.sessionId,revision:p.revision,view:'overview',items:[],nextBefore:null,overview};
}

export async function journalReading(journal,id,query) {
  const {projectTranscriptFacts}=await import('../../session-core/dist/local-agent/reducer.js');
  const {ownOverview}=await import('../../session-core/dist/local-agent/transcriptOverview.js');
  if(query.view==='overview') {
    const {surfaced,...own}=await ownOverview(journal,id,true);
    return {sessionId:id,revision:own.revision,view:'overview',items:[],nextBefore:null,overview:{...own,childDeliverables:[],memberIds:[]}};
  }
  const transcript=projectTranscriptFacts(id,await journal.readTranscriptFacts(id,query.around),query.around);
  return {sessionId:id,revision:transcript.revision,view:'transcript',items:[],nextBefore:transcript.previous,transcript};
}

export const okFixture = data => Response.json({ok:true,data});
export function installPageFixture(t, makeView, handler) {
  const seen=[];
  installGuiFetch(t,async (url,init)=>{
    const id=decodeURIComponent(url.pathname.split('/').at(-2)), route=url.pathname.split('/').at(-1);
    const query=route==='read'?JSON.parse(init.body):null;
    seen.push({id,route,query});
    if(query?.view==='transcript'||query?.view==='overview') {
      const p=await makeView(id,init,query);
      return p instanceof Response ? p : okFixture(query.view==='transcript'?transcriptFixture(p,query.around):overviewFixture(p));
    }
    if(handler) return handler(url,init);
    if(route==='statuses') return okFixture([]);
    throw new Error('unexpected_test_route:'+route);
  });
  return seen;
}

export async function openSnapshot(store,id) {
  await store.getState().activateSession(id);
  return store.getState().projection;
}
