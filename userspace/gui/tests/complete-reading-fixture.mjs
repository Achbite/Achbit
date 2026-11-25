import assert from 'node:assert/strict';
import { emptySessionState, projectSession } from '../../session-core/dist/index.js';
import { installGuiFetch, loadGuiModelStore, okFixture } from './gui-projection-contract.mjs';
export const pause=()=>new Promise(resolve=>setImmediate(resolve));
export function history(id,turns=6) {
  const p=projectSession(emptySessionState(id)), at='2026-11-24T00:00:00Z';
  for(let n=0;n<turns;n++) {
    for(const role of ['user','assistant']) {
      const sequence=p.messages.length+2,messageId=id+'-'+sequence;
      const receipt=role==='assistant'?{runId:'run:'+n,providerRequestId:'req:'+n}:{};
      p.messages.push({sequence,messageId,content:role+' '+n,role,createdAt:at,filesystemReferences:[],pluginSelections:[],feedback:null,...receipt});
      p.timeline.push({kind:'message',messageId,sequence,timelineId:'timeline:'+messageId,...(role==='assistant'?{streamId:'stream:'+messageId}:{})});
    }
  }
  p.revision=p.messages.at(-1)?.sequence??1;
  if(turns)p.run={runId:'run:'+(turns-1),status:'completed',profileId:'profile:one',workspaceBindings:[]};
  return p;
}
export async function reader(t,views,intercept,extra) {
  const store=await loadGuiModelStore(t);
  const catalog=()=>({projects:[],sessions:views.map(p=>({id:p.sessionId,createdAt:'2026-11-24',updatedAt:'2026-11-24',title:p.sessionId,workspaceBindings:[]}))});
  store.setState({catalog:catalog()});store.getState().observeHistory('ready');
  const seen = [];
  installGuiFetch(t, async (url, init) => {
    const route = url.pathname.split('/').at(-1);
    const id = decodeURIComponent(url.pathname.split('/').at(-2));
    seen.push({ id, route });
    if (route === 'projection') {
      const value = await (intercept?.(id, init) ?? views.find(p => p.sessionId === id));
      return value instanceof Response ? value : okFixture(value);
    }
    if (extra) return extra(url, init);
    if (route === 'catalog') return okFixture(catalog());
    if (route === 'statuses') return okFixture(views.map(p => ({ sessionId: p.sessionId, revision: p.revision,
      run: p.run ? { runId: p.run.runId, status: p.run.status } : null })));
    assert.fail('unexpected route ' + url.pathname);
  });
  const reads = () => seen.filter(request => request.route === 'projection');
  const open = async id => { await store.getState().activateSession(id); return store.getState(); };
  return { store, seen, reads, open };
}
