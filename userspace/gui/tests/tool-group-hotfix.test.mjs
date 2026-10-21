import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadGuiModules } from './gui-projection-contract.mjs';

function tool(id, operation = `fs.${id}`) {
  return {activityId:`tool:${id}`,kind:'tool',status:'completed',label:operation,
    runId:'run:mixed',callId:`call:${id}`,sequence:1,tool:{operation,resources:[]}};
}
function computer(id) {
  return {...tool(id,'computer.control'),tool:{operation:'computer.control',resources:[],
    computer:{action:'observe',input:{action:'observe'},window:{title:`Editor ${id}`}}}};
}
async function renderer(t) {
  const [{ToolActivityGroup},{ConversationVirtualRow}]=await loadGuiModules(t,[
    '/src/components/local-agent/ToolActivityDetails.tsx','/src/components/local-agent/ConversationVirtualRow.tsx']);
  const layout={state:new Map()};
  return {layout,render:activities=>renderToStaticMarkup(createElement(ConversationVirtualRow,{
    rowKey:'mixed-history',eager:true,virtualizer:{layout:()=>layout},
    children:()=>createElement(ToolActivityGroup,{activities,language:'en-US',onExpand(){},onOpenWorkspaceResource(){}}),
  }))};
}

test('ordinary, browser, computer and approval activities use exactly one shared disclosure in original order',async t=>{
  const {layout,render}=await renderer(t);
  const approval={activityId:'approval:fourth',kind:'approval',status:'completed',label:'Allow operation',runId:'run:mixed',callId:'call:fourth',sequence:1};
  const browser={...computer('B'),tool:{operation:'browser.page',resources:[],computer:{action:'refreshInterface',input:{action:'refreshInterface'}}}};
  const activities=[tool('first'),tool('second'),computer('A'),tool('third'),approval,tool('fourth'),browser];
  const original=structuredClone(activities);
  const folded=render(activities);
  assert.equal((folded.match(/class="local-agent__tool-group-summary"/g)??[]).length,1);
  assert.equal((folded.match(/aria-expanded="false"/g)??[]).length,1);
  assert.doesNotMatch(folded,/fs\.first|fs\.second|fs\.third|fs\.fourth|Observe · Editor A|Refresh application interface|Accepted/);
  layout.state.set('tool-group:expanded',true);
  const html=render(activities);
  assert.equal((html.match(/class="local-agent__tool-group-summary"/g)??[]).length,1,'computer boundaries do not introduce a second grouping rule');
  assert.ok(html.indexOf('fs.first')<html.indexOf('fs.second'));
  assert.ok(html.indexOf('fs.second')<html.indexOf('Editor A'));
  assert.ok(html.indexOf('Editor A')<html.indexOf('fs.third'));
  assert.ok(html.indexOf('fs.third')<html.indexOf('Accepted'));
  assert.ok(html.indexOf('Accepted')<html.indexOf('fs.fourth'));
  assert.equal((html.match(/aria-expanded="false"/g)??[]).length,activities.length,'each operation retains its own collapsed details inside the expanded group');
  assert.match(render([...activities,tool('fifth')]),/fs\.fifth/,'an arriving peer preserves explicit group expansion');
  layout.state.set('tool-group:expanded',false);
  assert.equal(render(activities),folded);
  assert.deepEqual(activities,original);
  for(const computers of [[computer('A')],[computer('A'),computer('B')]]) {
    const only=render(computers);
    assert.equal((only.match(/class="local-agent__tool-group-summary"/g)??[]).length,1,'computer-only groups use the same disclosure');
    assert.doesNotMatch(only,/Observe · Editor/);
  }
});

test('an arriving computer operation never forces expansion and the compact Shell preview stays within the folded group',async t=>{
  const {layout,render}=await renderer(t);
  const calls=[tool('first'),tool('second')];
  assert.doesNotMatch(render(calls),/fs\.first/);
  assert.doesNotMatch(render([...calls,computer('A')]),/fs\.first|fs\.second|Observe · Editor/);
  layout.state.set('tool-group:expanded',true);
  assert.match(render([...calls,computer('A')]),/Observe · Editor A/);
  layout.state.set('tool-group:expanded',false);
  const running={...tool('running','bash'),status:'active',startedAt:String(Date.now()),
    tool:{operation:'bash',resources:[],shell:{command:'sleep 120',cwd:'.',executionScope:'workspace',terminal:false}},
    liveOutput:{stdout:'recent output\n',stderr:'',stdoutBytes:14,stderrBytes:0,truncated:false}};
  const html=render([...calls,running,computer('A')]);
  assert.equal((html.match(/class="local-agent__tool-group-summary"/g)??[]).length,1);
  assert.match(html,/sleep 120/);assert.match(html,/recent output/);
  assert.doesNotMatch(html,/fs\.first|fs\.second|Observe · Editor/);
});
