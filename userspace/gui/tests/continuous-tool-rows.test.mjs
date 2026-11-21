import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadGuiModule, loadGuiModules } from './gui-projection-contract.mjs';

const runId = 'run:work';
const block = (id, index) => ({ kind: 'providerHosted', providerToolType: 'web_search', providerCallId: id,
  outputIndex: index, status: 'completed', action: { query: 'same query' } });
const draft = (turnId, blocks, extra = {}) => ({ runId, turnId, blocks, ...extra });
const local = { kind: 'tool', activityId: 'tool:read', label: 'fs.read', status: 'completed', sequence: 1, runId };
const activity = (id, b) => ({ kind: b.kind, activityId: id, label: 'web.search', status: b.status,
  sequence: 2, runId, providerHosted: { providerToolType: b.providerToolType, providerCallId: b.providerCallId, action: b.action } });
const batch = (turn, a) => ({ kind: 'toolGroup', timelineId: `group:${turn}`, sequence: a.sequence, providerRequestId: turn, activityIds: [a.activityId] });
const snapshot = entries => ({ activities: entries.map(([,a]) => a), timeline: entries.map(([r,a]) => batch(r,a)),
  messages: [], narratives: [], plans: [], interactions: [] });

test('continuous tools have one stable row across the live/committed seam without hiding distinct calls', async t => {
  const { projectionItems, assistantDraftItems, conversationRounds } = await loadGuiModule(t, '/src/components/local-agent/conversationItems.ts');
  const rows = (projection, live) => conversationRounds(projectionItems(projection), assistantDraftItems(live), runId).at(-1).rows;
  const a = block('ws_A', 0), b = block('ws_B', 1), live = draft('req:search', [a,b]);
  const history = snapshot([['req:local',local]]);
  const before = structuredClone(history);
  const merged = rows(history, live);
  assert.equal(merged.length,1); assert.deepEqual(merged[0].item.values,[local]); assert.deepEqual(merged[0].draft.blocks,[a,b]);
  assert.equal(merged[0].key,rows(history,null)[0].key);
  assert.deepEqual(rows(history,live),merged,'re-render must not mutate the cached committed items');
  assert.deepEqual(history,before);
  const settledA = activity('activity:A', a);
  const overlap = rows(snapshot([['req:local',local],['req:search',settledA]]), live);
  assert.equal(overlap.length,1); assert.equal(overlap[0].key,merged[0].key);
  assert.deepEqual(overlap[0].item.values,[local,settledA]); assert.deepEqual(overlap[0].draft.blocks,[b]);
  const firstLive = rows(snapshot([]),draft('req:search',[a]));
  const committedOnly = rows(snapshot([['req:search',settledA]]),draft('req:search',[a]));
  assert.equal(committedOnly.length,1); assert.equal(committedOnly[0].key,firstLive[0].key,'a draft-only disclosure survives settlement');
  assert.equal(committedOnly[0].draft,undefined);
  assert.deepEqual(rows(snapshot([['older:request',settledA]]),draft('new:request',[a]))[0].draft.blocks,[a], 'IDs from different requests are distinct');
});

test('visible draft text, plans, other runs and member notices remain boundaries, empty streaming placeholders do not', async t => {
  const { projectionItems, assistantDraftItems, conversationRounds } = await loadGuiModule(t,'/src/components/local-agent/conversationItems.ts');
  const a=block('ws_A',0), b=block('ws_B',2);
  const text={ kind:'narrative', streamId:'text', outputIndex:1, content:'A real paragraph' };
  const planPreview={callIndex:0,providerCallId:'plan',outputIndex:1,title:'Review',summary:'',steps:[],truncated:false};
  const rows=(entries,blocks,extra)=>conversationRounds(projectionItems(snapshot(entries)),assistantDraftItems(draft('req:live',blocks,extra)),runId).at(-1).rows;
  for(const [blocks,extra,boundary] of [[[a,text,b],{},'text'],[[a,b],{planPreview},'planPreview']]){
    const separated=rows([['r',local]],blocks,extra);assert.equal(separated.length,3);
    assert.equal(separated[1].draft.type,boundary);assert.deepEqual(separated[0].draft.blocks,[a]);assert.deepEqual(separated[2].draft.blocks,[b]);
  }
  assert.equal(rows([['r',local]],[a,{...text,content:'  '},b]).length,1);
  const other={...local,runId:'run:previous'};
  assert.equal(rows([['r',other]],[a])[0].item,undefined,'previous run is not part of the draft group');
  const notice={...local,kind:'agent',agent:{phase:'completed',taskId:'task',agentSessionId:'child'}};
  assert.equal(rows([['r',notice]],[a]).length,2);
  const p=snapshot([['one',local],['two',{...local,activityId:'next'}]]);
  p.narratives=[{narrativeId:'empty',runId,content:' '}];
  p.timeline.splice(1,0,{kind:'narrative',narrativeId:'empty',streamId:'s',sequence:2});
  assert.equal(projectionItems(p).length,1,'a whitespace-only historical placeholder is not a boundary');
  assert.equal(projectionItems({...p,narratives:[{...p.narratives[0],sourceReferences:{citations:[],unresolved:true}}]}).length,3,'even without text a visible source notice stays in place');
});

test('the shared disclosure keeps an opened search and the real command error when the search settles', async t => {
  const [{projectionItems,assistantDraftItems,conversationRounds,hostedEntryKey},{ToolActivityGroup},{ConversationVirtualRow}] = await loadGuiModules(t,[
    '/src/components/local-agent/conversationItems.ts','/src/components/local-agent/ToolActivityDetails.tsx','/src/components/local-agent/ConversationVirtualRow.tsx']);
  const bad={...local,activityId:'tool:shell',label:'bash',status:'failed',tool:{operation:'bash',resources:[],error:{code:'exit_nonzero',message:'command failed'}}};
  const b=block('ws_A',0), live=draft('req:web',[b]);
  const layout={state:new Map([['tool-group:expanded',true],[`tool:${bad.activityId}:expanded`,true],
    [`hosted:${hostedEntryKey(runId,live.turnId,b.providerCallId)}:expanded`,true]])};
  const render=(entries,liveDraft)=>{
    const items=projectionItems(snapshot(entries));
    const [row]=conversationRounds(items,assistantDraftItems(liveDraft),runId)[0].rows;
    return renderToStaticMarkup(createElement(ConversationVirtualRow,{rowKey:row.key,eager:true,virtualizer:{layout:()=>layout},
      children:()=>createElement(ToolActivityGroup,{activities:row.item?.values??[],hostedKeys:row.item?.hostedKeys,hostedDraft:row.draft,
        language:'zh-CN',onExpand(){},onOpenWorkspaceResource(){}})}));
  };
  const before=render([['req:b',bad]],live), after=render([['req:b',bad],['req:web',activity('activity:search',b)]],null);
  for(const html of [before,after]){
    assert.equal((html.match(/class="local-agent__tool-group-summary"/g)??[]).length,1);
    assert.match(html,/<strong>运行命令、在网络中搜索<\/strong>/);
    assert.match(html,/exit_nonzero/);assert.match(html,/command failed/);
    assert.equal((html.match(/<code>ws_A<\/code>/g)??[]).length,1);
    assert.ok(html.indexOf('command failed')<html.indexOf('<code>ws_A</code>'));
  }
});
