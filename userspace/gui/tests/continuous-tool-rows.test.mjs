import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { findReactElement, loadGuiModule, loadGuiModules } from './gui-projection-contract.mjs';

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

test('child notices fold across independent tools, with chronological Reader actions and stable virtual disclosure', async t => {
  const [{projectionItems, conversationRounds}, {ToolActivityGroup}, {ConversationVirtualRow}, {AgentNavigationScope, AgentGroupSummary}, {READER_OPEN_EVENT}] = await loadGuiModules(t, [
    '/src/components/local-agent/conversationItems.ts','/src/components/local-agent/ToolActivityDetails.tsx','/src/components/local-agent/ConversationVirtualRow.tsx',
    '/src/components/local-agent/agentNavigation.tsx','/src/components/local-agent/readerState.ts']);
  const notice = (sequence, agentSessionId, phase, status = 'completed') => ({kind:'agent', activityId:`notice:${sequence}`, runId, sequence,
    label:'Reviewer', status, agent: {agentSessionId, phase, ...(phase === 'updated' ? {} : {taskId:`task:${agentSessionId}`})} });
  const read = n => ({...local, sequence:n, activityId:`read:${n}`});
  const [a,b] = ['session:gui', 'session:kernel'];
  const activities = [read(1),notice(2,a,'started'),notice(3,a,'updated'),read(4),notice(5,b,'started'),
    notice(6,a,'updated'),read(7),notice(8,a,'completed'),notice(9,b,'completed')];
  const rows = cells => conversationRounds(projectionItems(snapshot(cells.map(x => [`turn:${x.sequence}`, x]))), [], runId)[0].rows;
  const early = rows(activities.slice(0,4)), final = rows(activities);
  assert.deepEqual(final.map(r => r.item.values.map(x => x.sequence)), [[1],[2,3,5,6,8,9],[4,7]]);
  assert.deepEqual(early.map(r => r.key), final.map(r => r.key), 'later agent updates and ordinary calls cannot rekey earlier disclosures');
  const cache = new Map(), virtualizer = { layout(key) { if (!cache.has(key)) cache.set(key,{state:new Map()}); return cache.get(key); } };
  const render = list => renderToStaticMarkup(createElement(AgentNavigationScope, {sessionId:'session:parent'}, list.map(row => createElement(ConversationVirtualRow,
    {key:row.key, rowKey:row.key, eager:true, virtualizer, children:() => createElement(ToolActivityGroup, {activities:row.item.values, language:'zh-CN', onExpand(){},onOpenWorkspaceResource(){}})}))));
  const closed = render(final);
  assert.equal((closed.match(/class="agent-tasks__fold"/g) ?? []).length, 1);
  assert.match(closed, /2 个子代理/); assert.match(closed, />已完成</); assert.doesNotMatch(closed, /Reviewer/);
  assert.equal((closed.match(/class="local-agent__tool-group-summary"/g) ?? []).length, 2, 'both tool disclosures still render');
  assert.match(render(rows(activities.slice(1,3))), /1 个子代理/);
  assert.doesNotMatch(render(rows([notice(3,a,'updated'),notice(6,a,'updated')])), /已完成/, 'delivery is not task completion');
  const memberKey = early[1].key;
  virtualizer.layout(memberKey).state.set('tool-group:expanded',true);
  const expanded = render(final);
  assert.deepEqual([...expanded.matchAll(/aria-label="Reviewer · ([^"]+)"/g)].map(match => match[1]),
    ['已开始','已更新','已开始','已更新','已完成','已完成']);
  assert.match(expanded, /<details[^>]*open/); assert.equal((expanded.match(/class="local-agent__tool-group-summary"[^>]*aria-expanded="false"/g) ?? []).length,2);
  const failed = render(rows([...activities.slice(0,8),notice(9,b,'completed','failed')]));
  const summary = failed.match(/<summary\b[^>]*>[\s\S]*?<\/summary>/)[0];
  assert.match(summary, />失败</); assert.doesNotMatch(summary, />已完成</);
  const previousWindow = globalThis.window; globalThis.window = new EventTarget(); t.after(() => { globalThis.window = previousWindow; });
  const opened = []; window.addEventListener(READER_OPEN_EVENT,event => opened.push(event.detail.target));
  function ClickEventEntries() {
    const tree = AgentGroupSummary({activities:final[1].item.values, language:'zh-CN'});
    for (const row of tree.props.children) findReactElement(row,node => typeof node.props.onClick === 'function').props.onClick();
    return null;
  }
  renderToStaticMarkup(createElement(AgentNavigationScope,{sessionId:'session:parent'},createElement(ClickEventEntries)));
  assert.deepEqual(opened.map(x => x.agentSessionId),[a,a,b,a,a,b]);
  assert.ok(opened.every(x => x.parentSessionId === 'session:parent'));
  assert.equal(new Set(opened.map(x => x.entryId)).size,6, 'retained child still has a distinct Reader entry for each event');
});

test('child folds do not move notices across a user message, pending approval, interaction or parent run', async t => {
  const {projectionItems} = await loadGuiModule(t,'/src/components/local-agent/conversationItems.ts');
  const update = (i, run = runId) => ({ kind:'agent',activityId:`u:${i}`,sequence:i,runId:run,label:'Gui',status:'completed',agent:{phase:'updated',agentSessionId:'session:gui'} });
  const approval = {...local, kind:'approval', activityId:'approval:p', status:'waiting', sequence:3};
  const question = {...local,kind:'interaction',activityId:'interaction:q',callId:'q',sequence:6};
  const cells = [update(1),update(2),approval,update(4),update(5),question,update(7),update(8),update(10),update(11,'other')];
  const p = snapshot(cells.map(x => [`r:${x.sequence}`,x]));
  p.interactions = [{callId:'q',sequence:6,runId,status:'pending'}];
  p.messages = [{messageId:'user-boundary',role:'user',content:'Next request',runId,sequence:9}];
  p.timeline.splice(8,0,{kind:'message',messageId:'user-boundary',sequence:9});
  const rows = projectionItems(p);
  assert.deepEqual(rows.map(r => r.type === 'toolGroup' ? r.values.map(v => v.activityId) : r.type),
    [['u:1','u:2'],['approval:p'],['u:4','u:5'],'interaction',['u:7','u:8'],'message',['u:10'],['u:11']]);
  assert.equal(rows[1].values[0].status,'waiting'); assert.equal(rows[3].value.status,'pending');
});

test('folded conflict counts follow Provider requests across split and merged rows, not every rejected or failed call', async t => {
  const [{projectionItems},{ToolActivityGroup},{ConversationVirtualRow}] = await loadGuiModules(t,[
    '/src/components/local-agent/conversationItems.ts','/src/components/local-agent/ToolActivityDetails.tsx','/src/components/local-agent/ConversationVirtualRow.tsx']);
  const rejected = (id, rules, code = 'session_control_turn_conflict') => ({...local, callId: id, activityId: `tool:${id}`,
    status: 'rejected', inputRejection: { code, message: `original error ${id}`, issues: rules.map(rule => ({ rule,
      path: rule === 'required' ? '$.delivery' : '$', message: `original issue ${id}` })) } });
  const first = rejected('source-a', ['control_turn_source']);
  const peers = Array.from({length: 4}, (_, n) => rejected(`held:${n}`, ['control_turn_peer']));
  const second = rejected('bad-field', ['required','control_turn_source'], 'session_control_shape_invalid');
  const ordinary = rejected('individual', ['json_object'], 'provider_tool_call_arguments_invalid');
  const service = rejected('service', ['session_control_schema'], 'agent_loop_failed');
  const legacy = rejected('no-role', ['control_turn']);
  const failed = {...local, activityId:'tool:failed', status:'failed', tool:{operation:'bash', resources:[], error:{code:'exit_nonzero', message:'command failed'}}};
  const entries = [['a',first], ...peers.map(a => ['a',a]), ['b',second], ['b',rejected('held:b',['control_turn_peer'])],
    ['b',ordinary], ['c',service], ['d',legacy], ['e',failed], ['f',local]];
  const p = snapshot(entries);
  p.narratives = [{narrativeId:'middle',runId,content:'Interposed narrative'}];
  p.timeline.splice(1,0,{kind:'narrative',narrativeId:'middle',streamId:'middle',sequence:2});
  const groups = projectionItems(p).filter(item => item.type === 'toolGroup');
  assert.equal(groups.length, 2, 'existing continuous disclosure still merges adjacent requests');
  assert.deepEqual(groups.map(group => group.batchConflicts), [[{providerRequestId:'a',sources:1,peers:4}], [{providerRequestId:'b',sources:1,peers:1}]]);
  const layout={state:new Map()};
  const render=group=>renderToStaticMarkup(createElement(ConversationVirtualRow,{rowKey:group.groupId,eager:true,virtualizer:{layout:()=>layout},
    children:()=>createElement(ToolActivityGroup,{activities:group.values,batchConflicts:group.batchConflicts,language:'zh-CN',onExpand(){},onOpenWorkspaceResource(){}})}));
  assert.match(render(groups[0]), /1 项触发冲突，4 项随批未执行/u);
  assert.match(render(groups[1]), /1 项触发冲突，1 项随批未执行/u);
  layout.state.set('tool-group:expanded',true);
  for (const a of [second, service, failed]) layout.state.set(`tool:${a.activityId}:expanded`,true);
  const html=render(groups[1]);
  assert.match(html,/session_control_shape_invalid/u); assert.match(html,/original error bad-field/u); assert.match(html,/\$\.delivery/u);
  assert.match(html,/随批未执行/u); assert.match(html,/original error service/u); assert.match(html,/command failed/u);
});

test('a rejected batch names what did not run and shows each root reason once without dropping field evidence', async t => {
  const [{ ToolActivityGroup }, { ConversationVirtualRow }] = await loadGuiModules(t, [
    '/src/components/local-agent/ToolActivityDetails.tsx', '/src/components/local-agent/ConversationVirtualRow.tsx']);
  const operations = ['agent','agent','computer.control','computer.control','browser.page','bash'];
  const calls = operations.map((operation, i) => {
    const rule = i < 2 ? 'control_turn_source' : 'control_turn_peer';
    const message = `Original batch reason ${i}: agent(action=send) [source-A], agent(action=send) [source-B].`;
    return { ...local, activityId: `rejected:${i}`, label: operation, status: 'rejected',
      inputRejection: { code: 'session_control_turn_conflict', message, issues: [{ path: '$', rule, message }] } };
  });
  const error = calls[0].inputRejection;
  error.issues.push({ path: '$.input', rule: 'field_constraint', message: error.message, expected: 'a receiver' });
  const layout = { state: new Map() };
  const render = (language, activities = calls) => renderToStaticMarkup(createElement(ConversationVirtualRow,
    { rowKey:'conflict', eager:true, virtualizer:{layout:()=>layout}, children:()=>createElement(ToolActivityGroup,
      { activities, batchConflicts:[{providerRequestId:'request',sources:2,peers:4}], language,onExpand(){},onOpenWorkspaceResource(){} }) }));
  for (const language of ['zh-CN','en-US']) {
    layout.state.clear();
    const closed = render(language);
    assert.match(closed, language === 'zh-CN' ? /<strong>批次未执行：2 项触发冲突，4 项随批未执行<\/strong>/u : /<strong>Batch not executed: 2 triggered the conflict, 4 held back<\/strong>/u);
    assert.doesNotMatch(closed, /Original batch reason|source-A/);
    layout.state.set('tool-group:expanded', true);
    for (const call of calls) layout.state.set(`tool:${call.activityId}:expanded`, true);
    const details = render(language);
    assert.doesNotMatch(details, /agent 未完成|bash 未完成|did not complete|didn't complete/i);
    assert.match(details, /<strong>agent<\/strong>/);
    assert.match(details, /\$\.input/); assert.match(details, /a receiver/);
    assert.equal(details.split(calls[1].inputRejection.message).length - 1, 1, 'a repeated root marker is not a second error');
    assert.match(details, /session_control_turn_conflict/);
    assert.match(details, /source-A/);
    layout.state.set('tool:failed-command:expanded', true);
    const mixed = render(language, [...calls, { ...local, activityId:'failed-command', label:'bash', status:'failed', tool:{ operation:'bash', resources:[], error:{code:'actual_exit',message:'Real failed command'} }}]);
    assert.match(mixed, language === 'zh-CN' ? /<strong>运行命令 · 批次未执行：2 项触发冲突，4 项随批未执行<\/strong>/u
      : /<strong>Commands · Batch not executed: 2 triggered the conflict, 4 held back<\/strong>/u);
    assert.match(mixed, /actual_exit/); assert.match(mixed, /Real failed command/);
  }
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
