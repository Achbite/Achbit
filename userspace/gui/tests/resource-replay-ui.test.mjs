import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadGuiModule, loadGuiModules } from './gui-projection-contract.mjs';

test('change statistics select only displayed rows, retaining the entire archived list',async t=>{
  const {displayedChangedFiles}=await loadGuiModule(t,'/src/components/local-agent/fileChangeSummary.ts');
  const files=Array.from({length:8},(_,index)=>({key:String(index),path:`file-${index}`,changes:[]}));const before=structuredClone(files);
  assert.deepEqual(displayedChangedFiles(files,false,false,false),[]);
  assert.deepEqual(displayedChangedFiles(files,false,true,false),files.slice(0,3));
  assert.equal(displayedChangedFiles(files,false,true,true),files);
  assert.equal(displayedChangedFiles(files,true,false,false),files);
  assert.deepEqual(files,before);
});

test('selected Reader tabs scroll only their strip and do not steal focus',async t=>{
  const {revealActiveReaderTab}=await loadGuiModule(t,'/src/components/local-agent/readerTabVisibility.ts');
  let rect={left:150,right:195,width:45};
  const active={closest:()=>({getBoundingClientRect:()=>rect}),focus:()=>assert.fail('revealing a tab must not focus it')};
  const list={scrollLeft:0,querySelector:selector=>{assert.equal(selector,'[role="tab"][aria-selected="true"]');return active;},getBoundingClientRect:()=>({left:10,right:110,width:100})};
  revealActiveReaderTab(list);assert.equal(list.scrollLeft,85);
  rect={left:-10,right:35,width:45};revealActiveReaderTab(list);assert.equal(list.scrollLeft,65);
  rect={left:20,right:65,width:45};revealActiveReaderTab(list);assert.equal(list.scrollLeft,65);
  revealActiveReaderTab(null);
  list.querySelector=()=>null;revealActiveReaderTab(list);assert.equal(list.scrollLeft,65);
});

test('hidden never-opened Reader does not mount its tree loader',async t=>{
  const {ResourceTree}=await loadGuiModule(t,'/src/components/local-agent/ResourceTree.tsx');
  assert.equal(renderToStaticMarkup(createElement(ResourceTree,{sessionId:'session:history',language:'zh-CN',visible:false,openTarget(){}})),'');
});

test('tool headers retain counts and operation descriptions through success, failure and pending states',async t=>{
  const {toolGroupSummary}=await loadGuiModule(t,'/src/components/local-agent/ToolActivityDetails.tsx');
  const read={activityId:'read',runId:'run',kind:'tool',status:'completed',label:'fs.read',sequence:1,tool:{operation:'fs.read',resources:[]}};
  assert.match(toolGroupSummary([read,read],'zh-CN'),/2 个工具.*已读取文件/);
  const failed=toolGroupSummary([read,{...read,status:'failed'}],'zh-CN');
  assert.match(failed,/2 个工具.*读取文件/);assert.match(failed,/已结束 1/);assert.doesNotMatch(failed,/已读取文件|失败/);
  const pending=toolGroupSummary([{...read,status:'requested',label:'fs.write',tool:undefined}],'zh-CN');
  assert.match(pending,/已请求 1 个工具.*修改文件/);assert.doesNotMatch(pending,/已修改文件/);
  assert.match(toolGroupSummary([{...read,status:'failed'}],'en-US'),/1 tools.*File reads.*Finished/i);
});

function projectionFor(kind){
  const approval={approvalId:'approval:auto',callId:'call:auto',runId:'run:auto',preview:{approvalReviewer:'agent',summary:'Inspect file',effects:['localRead'],logicalTargets:['a.txt']}};
  const plan={planId:'plan:auto',runId:'run:auto',revision:1,status:'pending',title:'Plan',steps:[],mutationManifest:[],review:{status:'reviewing',providerRequestId:'request:review'}};
  return {sessionId:'session:auto',pendingApproval:kind==='tool'?approval:null,pendingPlan:kind==='plan'?plan:null,
      plans:kind==='plan'?[plan]:[],interactions:[],workspaceBindings:[],contextCompositions:[],queuedInputs:[],
      run:{runId:'run:auto',status:'running'},effectivePermissions:{'agent.permissions.workspaceMutation':'review'}};
}

test('automatic tool and Plan review leave the ordinary composer and draft intact; user escalation still shows decisions',async t=>{
  const oldSelf=globalThis.self;globalThis.self={};t.after(()=>{if(oldSelf===undefined)delete globalThis.self;else globalThis.self=oldSelf;});
  const [{ConversationComposer},{foregroundApproval,foregroundPlan},{useAgentComposer},{useLocalAgentStore:store},{emptyComposerState}]=await loadGuiModules(t,[
    '/src/components/local-agent/ConversationComposer.tsx','/src/components/local-agent/composerDecisions.ts',
    '/src/components/local-agent/useAgentComposer.ts','/src/state/localAgentStore.ts','/src/components/local-agent/composerSubmission.ts']);
  const oldStorage=globalThis.sessionStorage;
  globalThis.sessionStorage={getItem:()=>JSON.stringify({...emptyComposerState(),draft:'审批期间保留的普通草稿'})};
  t.after(()=>{if(oldStorage===undefined)delete globalThis.sessionStorage;else globalThis.sessionStorage=oldStorage;});
  let composer;
  function Probe(){
    composer=useAgentComposer('zh-CN',()=>{});
    return createElement(ConversationComposer,{language:'zh-CN',composer,uiActionError:null});
  }
  const render=projection=>{
    store.setState({sessionId:projection.sessionId,projection,loading:false});
    Object.assign(store.getInitialState(),store.getState());
    return renderToStaticMarkup(createElement(Probe));
  };
  for(const kind of ['tool','plan']){
    const projection=projectionFor(kind),before=structuredClone(projection);
    const html=render(projection);
    assert.match(html,/审批期间保留的普通草稿<\/textarea>/);
    assert.doesNotMatch(html,/local-agent__composer-shell--decision|local-agent__auto-review/);
    assert.deepEqual(projection,before);
    assert.equal(composer.pendingApproval,null);
    assert.equal(composer.pendingPlan,null);
    assert.equal(foregroundApproval(projection.pendingApproval,projection.run),null);
    assert.equal(foregroundPlan(projection.pendingPlan,projection.effectivePermissions),null);
  }
  const manual=projectionFor('tool');manual.run={...manual.run,status:'waiting',waitingReason:'approval'};
  manual.pendingApproval.preview.review={decision:'ask',reason:'需要用户确认目录'};
  const html=render(manual);
  assert.match(html,/local-agent__composer-shell--decision/);assert.match(html,/需要用户确认目录/);
  assert.equal(composer.pendingApproval,manual.pendingApproval);
  assert.equal(foregroundApproval(manual.pendingApproval,manual.run),manual.pendingApproval);
  assert.equal(foregroundApproval(manual.pendingApproval,{...manual.run,status:'running'}),manual.pendingApproval,'explicit ask is already a user decision');
});
