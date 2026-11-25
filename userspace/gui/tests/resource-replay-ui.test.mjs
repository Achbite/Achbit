import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadGuiModule, loadGuiModules } from './gui-projection-contract.mjs';

test('change statistics select only displayed rows, retaining the entire archived list',async t=>{
  const {displayedChangedFiles}=await loadGuiModule(t,'/src/components/local-agent/fileChangeSummary.ts');
  const files=Array.from({length:8},(_,index)=>({key:String(index),path:`file-${index}`,changes:[]}));const before=structuredClone(files);
  assert.deepEqual(displayedChangedFiles(files,false,false),[]);
  assert.deepEqual(displayedChangedFiles(files,false,true),[], 'no invisible file rows, even after an earlier show-all');
  assert.deepEqual(displayedChangedFiles(files,true,false),files.slice(0,3));
  assert.equal(displayedChangedFiles(files,true,true),files);
  assert.deepEqual(files,before);
});

test('repeated file edits retain ordered unique receipts, distinct workspaces and revision-scoped net statistics', async t => {
  const { changedFiles, readChangeStatistics } = await loadGuiModule(t, '/src/components/local-agent/fileChangeSummary.ts');
  const row = (i, workspaceId='A') => ({tool:{recordId:'rec:'+i,fileChanges:[{workspaceId,path:'same.txt'}]}});
  const history = Array.from({length:1000}, (_,i)=>row(i));
  const [one,two] = changedFiles([...history,...history,row(0,'B')]);
  assert.equal(one.changes.length,1000); assert.equal(two.changes.length,1); assert.notEqual(one.key,two.key);
  assert.deepEqual(one.changes.map(e=>e.recordId),history.map(e=>e.tool.recordId));
  let reads=0, counts=0;const signal=new AbortController().signal;
  const read=async()=>{reads++;return {workspaceId:'A',path:'same.txt',before:'old',after:'new'};};
  const count=async()=>{counts++;return {added:1,removed:1};};
  const ends=changedFiles([history[0],history.at(-1)])[0];
  await readChangeStatistics(read,'session:A',ends,signal,count);await readChangeStatistics(read,'session:A',one,signal,count);
  assert.deepEqual([reads,counts],[2,1],'immutable first and last match; intervening history remains accessible');
  await readChangeStatistics(read,'session:B',one,signal,count);assert.deepEqual([reads,counts],[4,2]);
});

test('selected Reader tabs scroll only their strip and do not steal focus',async t=>{
  const {revealActiveReaderTab}=await loadGuiModule(t,'/src/components/local-agent/readerTabVisibility.ts');
  const previousStyle=globalThis.getComputedStyle;
  const style={scrollPaddingLeft:'0px',scrollPaddingRight:'0px'};
  globalThis.getComputedStyle=()=>style;
  t.after(()=>{if(previousStyle===undefined)delete globalThis.getComputedStyle;else globalThis.getComputedStyle=previousStyle;});
  let rect={left:150,right:195,width:45};
  const active={closest:()=>({getBoundingClientRect:()=>rect}),focus:()=>assert.fail('revealing a tab must not focus it')};
  const list={scrollLeft:0,querySelector:selector=>{assert.equal(selector,'[role="tab"][aria-selected="true"]');return active;},getBoundingClientRect:()=>({left:10,right:110,width:100})};
  revealActiveReaderTab(list);assert.equal(list.scrollLeft,85);
  rect={left:-10,right:35,width:45};revealActiveReaderTab(list);assert.equal(list.scrollLeft,65);
  rect={left:20,right:65,width:45};revealActiveReaderTab(list);assert.equal(list.scrollLeft,65);
  revealActiveReaderTab(null);
  list.querySelector=()=>null;revealActiveReaderTab(list);assert.equal(list.scrollLeft,65);
  // Preserve both curved ends when the first/last tab reaches the strip edge.
  list.querySelector=()=>active;list.scrollLeft=0;
  style.scrollPaddingLeft='12px';style.scrollPaddingRight='12px';
  rect={left:80,right:110,width:30};revealActiveReaderTab(list);assert.equal(list.scrollLeft,12);
  rect={left:10,right:40,width:30};revealActiveReaderTab(list);assert.equal(list.scrollLeft,0);
  rect={left:25,right:55,width:30};revealActiveReaderTab(list);assert.equal(list.scrollLeft,0);
  rect={left:35,right:135,width:100};revealActiveReaderTab(list);assert.equal(list.scrollLeft,13);
});

test('hidden never-opened Reader does not mount its tree loader',async t=>{
  const {ResourceTree}=await loadGuiModule(t,'/src/components/local-agent/ResourceTree.tsx');
  assert.equal(renderToStaticMarkup(createElement(ResourceTree,{sessionId:'session:history',language:'zh-CN',visible:false,openTarget(){}})),'');
});

test('tool headers show only operation descriptions through success, failure and pending states',async t=>{
  const {toolGroupSummary}=await loadGuiModule(t,'/src/components/local-agent/ToolActivityDetails.tsx');
  const read={activityId:'read',runId:'run',kind:'tool',status:'completed',label:'fs.read',sequence:1,tool:{operation:'fs.read',resources:[]}};
  assert.equal(toolGroupSummary([read,read],'zh-CN'),'已读取文件');
  const failed=toolGroupSummary([read,{...read,status:'failed'}],'zh-CN');
  assert.equal(failed,'读取文件');
  const pending=toolGroupSummary([{...read,status:'requested',label:'fs.write',tool:undefined}],'zh-CN');
  assert.equal(pending,'修改文件');
  assert.equal(toolGroupSummary([{...read,status:'failed'}],'en-US'),'File reads');
  assert.equal(toolGroupSummary([read,{...read,status:'cancelled',label:'bash',tool:undefined}],'zh-CN'),'读取文件、运行命令');
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


test('file change rounds preserve record ownership, source order and later projection updates', async t => {
  const { roundChangeActivities } = await loadGuiModule(t, '/src/components/local-agent/fileChangeSummary.ts');
  const activity = (id, recordId, runId) => ({ activityId: id, runId, tool: { recordId } });
  const first = activity('first', 'record:shared', 'run:other');
  const second = activity('second', 'record:one', 'run:other');
  const unrelated = activity('unrelated', 'record:unrelated', 'run:one');
  const projection = { activities: [first, second, unrelated], fileChangeRounds: [
    { runId: 'run:one', recordIds: ['record:one', 'record:shared', 'record:shared'] },
    { runId: 'run:two', recordIds: ['record:shared'] },
    { runId: 'run:one', recordIds: ['record:unrelated'] },
  ] };
  const before = structuredClone(projection);
  assert.deepEqual(roundChangeActivities(projection, 'run:one'), [first, second]);
  assert.deepEqual(roundChangeActivities(projection, 'run:two'), [first]);
  assert.deepEqual(roundChangeActivities(projection, 'run:missing'), []);
  assert.deepEqual(roundChangeActivities(null, 'run:one'), []);
  assert.deepEqual(roundChangeActivities({ ...projection, fileChangeRounds: undefined }, 'run:one'), []);
  const next = { ...projection, activities: [...projection.activities, activity('later', 'record:one', 'run:one')] };
  assert.deepEqual(roundChangeActivities(next, 'run:one'), [first, second, next.activities[3]]);
  assert.deepEqual(roundChangeActivities(projection, 'run:one'), [first, second]);
  assert.deepEqual(projection, before, 'indexing does not change the canonical projection');
});

test('closed output shortcuts do not mount artifact image readers', async t => {
  const { ArtifactShortcuts } = await loadGuiModule(t, '/src/components/local-agent/ArtifactLinks.tsx');
  const markup = renderToStaticMarkup(createElement(ArtifactShortcuts, { title:'Outputs',
    artifacts:[{artifactId:'artifact:image',sessionId:'session:history',title:'Deferred image',contentMode:'fixed',mediaType:'image/png'}],
    onOpen:async()=>{},
  }));
  assert.match(markup, /<summary class="ac-disclosure-summary" data-ui-component="DisclosureSummary">Outputs<svg\b[^>]*data-ui-icon="chevronRight"[^>]*aria-hidden="true"/);
  assert.equal(markup.replace(/<[^>]*>/g, ''), 'Outputs', 'the decorative glyph adds no text to the original label');
  assert.doesNotMatch(markup, /document-artifact|Deferred image/, 'no thumbnail reader mounts before the disclosure is opened');
});


test('artifact thumbnails wait for execution readiness, then read and release normally',async t=>{
  const React=await import('react');
  const [{ArtifactImageLink},{useLocalAgentStore:store},{useConversationHost}]=await loadGuiModules(t,[
    '/src/components/local-agent/ArtifactLinks.tsx','/src/state/localAgentStore.ts','/src/components/local-agent/ConversationHost.tsx']);
  let effect,showImage,reads=0,releases=0;
  const element={}, previousObserver=globalThis.IntersectionObserver;
  globalThis.IntersectionObserver=class {
    constructor(callback){this.callback=callback;}
    observe(target){assert.equal(target,element);showImage=()=>this.callback([{target,isIntersecting:true}]);}
    unobserve(){} disconnect(){}
  };
  t.after(()=>{if(previousObserver)globalThis.IntersectionObserver=previousObserver;else delete globalThis.IntersectionObserver;});
  t.mock.method(React.default,'useEffect', callback=>{effect=callback;});
  t.mock.method(useConversationHost(),'loadImage',async()=>{reads++;return {url:'blob:test',release(){releases++;}};});
  function Probe(){const preview=ArtifactImageLink({artifact:{artifactId:'artifact:pending',sessionId:'session:history'},label:'Image',title:'Image'});preview.props.triggerRef.current=element;return null;}
  store.setState({runtimeReady:false});Object.assign(store.getInitialState(),store.getState());
  renderToStaticMarkup(createElement(Probe));effect();await Promise.resolve();assert.equal(reads,0);
  store.setState({runtimeReady:true});Object.assign(store.getInitialState(),store.getState());
  renderToStaticMarkup(createElement(Probe));const dispose=effect();await Promise.resolve();assert.equal(reads,0,'a mounted offscreen image has not requested archive bytes');
  showImage();await Promise.resolve();assert.equal(reads,1);
  dispose();assert.equal(releases,1);
});
