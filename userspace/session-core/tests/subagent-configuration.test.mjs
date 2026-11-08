import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_USER_SETTINGS } from '@achbit/protocol';
import { SessionService, SessionConfigurationRegistry } from '../dist/index.js';
import { agentOperationDefinitions, sessionControlToolDefinitions, decodeSessionControlCall } from '../dist/local-agent/sessionControls.js';
import { agentPresets } from '../dist/local-agent/agentConfiguration.js';
import { InMemoryCommandJournal } from './support/memoryJournal.mjs';
import { assertRuntimeContract } from './support/runtimeContract.mjs';
import { emptyKernel, fakeRunPreparation, messageCommand, providerEvent, readEvents, waitUntil, workspaceBinding } from './local-agent-fixtures.mjs';

const caps = { messaging: true, continuation: true, delegation: true };
const customFields = ['capabilities','reasoningEffort','context','loop','tools','productComponents','permissions','runner','permissionPolicy','workspaceSandbox'];
const call = (request, id, input) => providerEvent(request.requestId, 'tool.call', { callId:id, name:'agent', input });
const answer = (request, text) => providerEvent(request.requestId, 'text.delta', { text });
const textOf = request => JSON.stringify(request.messages);

async function fixture(t, handler, full = false, recipe, settingsOverrides = {}) {
  const journal = new InMemoryCommandJournal(), requests = new Map();
  const owner = 'session:configuration-root';
  const settings = { enabled:true, profileId:'', reasoningEffort:'', maxConcurrent:4, maxCallsPerRun:16,
    maxMembersPerSession:4, allowMemberAnalysis:true, allowFullConfiguration:full, presets:'[]', ...settingsOverrides };
  const configurations = new SessionConfigurationRegistry(undefined, [
    { id:'fixture.selected', text:'SELECTED_PRODUCT_GUIDANCE', enabledByDefault:false },
    { id:'fixture.other', text:'UNSELECTED_PRODUCT_GUIDANCE', enabledByDefault:false },
  ]);
  const read = { name:'fs.read', toolBindingRef:'binding:read', description:'Read a referenced file.', origin:'coreBuiltin',
    availability:'callable', possibleEffects:[], inputSchema:{type:'object',properties:{path:{type:'string'}},required:['path']} };
  let service;
  service = new SessionService(journal, { async create({sessionId,promptContributions}) {
    const preparation = fakeRunPreparation({ contextWindowTokens:100_000, tools:[read] });
    return { composition:{ async dispose(){}, kernel:emptyKernel(), runPreparation:{...preparation.port, async prepare(input) {
      const prepared = await preparation.port.prepare(input);
      const creation = (await readEvents(journal, sessionId))[0].payload;
      prepared.runtimeSnapshot.instructions.push(...promptContributions);
      prepared.runtimeSnapshot.agentToolsEnabled = true;
      prepared.runtimeSnapshot.agentCapabilities = creation.agentContext?.capabilities ?? caps;
      prepared.runtimeSnapshot.toolSelection = creation.recipe?.tools;
      const selected = creation.recipe?.tools?.kernel;
      if (selected) prepared.runtimeSnapshot.tools = prepared.runtimeSnapshot.tools.filter(tool => selected.includes(tool.name));
      return prepared;
    }}, provider:{async *stream(request, signal) {
      const history = requests.get(sessionId) ?? [];
      history.push(structuredClone(request)); requests.set(sessionId, history);
      yield* handler({owner,sessionId,request,signal,turn:history.length,service,journal});
      yield providerEvent(request.requestId,'completed',{});
    }}} };
  }}, { async settings(){return settings;}, async saveDefaults(value){Object.assign(settings,value);},
    async models(){return ['profile:default','profile:chosen'].map(profileId => ({
    profileId, name:profileId, model:profileId, parameters:{adapterId:'openai',kind:'responses',providerFlavor:null,
      contextWindowTokens:100_000,maxOutputTokens:4096,imageInput:false,temperature:null,hostedWebSearch:null},reasoningEfforts:['low','high'] }));},
    async createSession(input){return service.createSession(input);}
  }, configurations);
  t.after(() => service.dispose());
  await service.createSession({sessionId:owner,displayTitle:'Configuration test',workspaceBindings:[workspaceBinding],...(recipe?{recipe}:{})});
  return {owner,service,journal,requests, async run(){
    await service.submit(messageCommand(owner,'command:configuration','Complete the assigned checks.'));
    try { await waitUntil(async()=> ['completed','failed','cancelled','indeterminate'].includes((await service.snapshot(owner)).run?.status),'configuration run'); }
    catch(error){ t.diagnostic(JSON.stringify((await readEvents(journal,owner)).filter(event=>event.type==='run.runtime.release_failed'||event.type==='session.control.rejected').map(event=>({type:event.type,error:event.payload.error})))); throw error; }
    const projection = await service.snapshot(owner);
    assert.equal(projection.run.status,'completed',JSON.stringify(projection.run.error));
    return projection;
  }};
}

test('default template discovery omits custom fields and full configuration exposes registered choices', () => {
  assert.equal(DEFAULT_USER_SETTINGS['agent.subagents.allowFullConfiguration'],false);
  const basic = agentOperationDefinitions(caps).find(operation=>operation.action==='spawn');
  for(const name of customFields) assert.equal(basic.inputSchema.properties[name],undefined,name);
  assert.ok(basic.inputSchema.properties.preset);
  assert.ok(basic.inputSchema.properties.profileId);
  const advanced = agentOperationDefinitions(caps,{fullConfiguration:true,productComponentIds:['fixture.selected']}).find(operation=>operation.action==='spawn');
  for(const name of customFields) assert.ok(advanced.inputSchema.properties[name],name);
  assert.deepEqual(advanced.inputSchema.properties.productComponents.items.enum,['fixture.selected']);
  const input={action:'spawn',name:'Worker',task:'Read the evidence.',delivery:'async',productComponents:[]};
  assertRuntimeContract('AgentOperation',input);
  assert.deepEqual(decodeSessionControlCall('call:product','agent',input).operation,input);
  const analysis=agentPresets({presets:'[]'})[0];
  assert.deepEqual(analysis.tools,{kernel:['fs.read'],controls:['agent','session'],plugins:false});
});

test('template mode rejects custom execution fields before admitting a child', async t => {
  const f=await fixture(t,async function*({owner,sessionId,request,turn,service}){
    if(sessionId!==owner) {yield answer(request,'Template child done.');return;}
    if(turn===1) yield call(request,'custom:attempt',{action:'spawn',name:'Worker',task:'Read evidence.',delivery:'wait',tools:{kernel:[]}});
    else if(turn===2){
      assert.equal(((await service.snapshot(owner)).agentTasks??[]).length,0);
      assert.match(textOf(request),/agent_full_configuration_required/u);
      yield call(request,'custom:template',{action:'spawn',name:'Worker',task:'Read evidence.',delivery:'wait',preset:'analysis'});
    } else yield answer(request,'Template mode preserved.');
  });
  const result=await f.run();
  assert.equal(result.agentTasks.length,1);
  const events=await readEvents(f.journal,f.owner);
  assert.equal(events.filter(event=>event.type==='session.control.rejected').length,1);
});

test('analysis template can contact its owner with a real selected control surface and stable request prefix', async t => {
  const f=await fixture(t,async function*({owner,sessionId,request,turn}){
    if(sessionId===owner){
      if(turn===1) yield call(request,'owner:discover',{action:'models'});
      else if(turn===2) yield call(request,'owner:spawn',{action:'spawn',preset:'analysis',name:'Researcher',task:'Send your finding, then finish.',delivery:'wait'});
      else if(textOf(request).includes('Research complete.')) yield answer(request,'Integrated evidence.');
      else yield call(request,`owner:wait:${turn}`,{action:'wait'});
    }else{
      assert.deepEqual(request.tools.map(tool=>tool.name).sort(),['agent','fs_read','session']);
      const description=request.tools.find(tool=>tool.name==='agent').description;
      assert.doesNotMatch(description,/spawn|assign|close|delegat|todo/u);
      if(turn===1) yield call(request,'research:send',{action:'send',agentId:owner,text:'RESEARCH_FINDING'});
      else yield answer(request,'Research complete.');
    }
  });
  const result=await f.run();
  const child=result.agentTasks[0].agentSessionId;
  assert.ok((await readEvents(f.journal,f.owner)).some(event=>event.type==='agent.message.received'&&event.payload.text==='RESEARCH_FINDING'));
  const requests=f.requests.get(f.owner);
  for(const request of requests.slice(1)){
    assert.deepEqual(request.tools,requests[0].tools,'contact/task changes leave declarations stable');
    assert.deepEqual(request.messages.filter(message=>message.role==='system'),requests[0].messages.filter(message=>message.role==='system'),'task progress leaves system prefix stable');
  }
  assert.equal(f.requests.get(child).length,2);
});

test('enabled full configuration reaches the child recipe while selecting only requested product guidance', async t => {
  const f=await fixture(t,async function*({owner,sessionId,request,turn}){
    if(sessionId!==owner){
      assert.deepEqual(request.tools.map(tool=>tool.name),['read']);
      assert.match(textOf(request),/SELECTED_PRODUCT_GUIDANCE/u);
      assert.doesNotMatch(textOf(request),/UNSELECTED_PRODUCT_GUIDANCE/u);
      yield answer(request,'Configured child done.');return;
    }
    if(turn===1)yield call(request,'full:models',{action:'models'});
    else if(turn===2){
      const choices=JSON.parse(request.messages.findLast(message=>message.role==='tool').content);
      assert.deepEqual(choices.productComponents.map(item=>item.id),['fixture.selected','fixture.other']);
      yield call(request,'full:spawn',{action:'spawn',preset:'analysis',name:'Configured worker',task:'Complete the configured task.',delivery:'wait',
        profileId:'profile:chosen',reasoningEffort:'high',capabilities:{messaging:false,continuation:false,delegation:false},
        context:{id:'coding'},loop:{controls:{id:'none'},compaction:{id:'none'}},runner:{id:'standard'},
        tools:{kernel:['fs.read'],controls:[],plugins:false},productComponents:['fixture.selected'],
        permissionPolicy:{id:'workspace-only'},workspaceSandbox:{backendId:'platform-default'},permissions:{'agent.permissions.workspaceMutation':'plan'}});
    }else yield answer(request,'Configuration accepted.');
  },true);
  const result=await f.run();
  assert.equal(result.agentTasks?.length,1,JSON.stringify((await readEvents(f.journal,f.owner)).filter(event=>event.type==='session.control.rejected')));
  const child=await f.service.snapshot(result.agentTasks[0].agentSessionId);
  assert.equal(child.recipe.profileId,'profile:chosen');
  assert.equal(child.recipe.reasoningEffort,'high');
  assert.deepEqual(child.recipe.productComponents,['fixture.selected']);
  assert.equal(child.recipe.configuration.context.id,'coding');
  assert.equal(child.recipe.configuration.controls.id,'none');
  assert.equal(child.recipe.configuration.compaction.id,'none');
  assert.equal(child.recipe.permissionPolicy.id,'workspace-only');
  assert.deepEqual(child.agentContext.capabilities,{messaging:false,continuation:false,delegation:false});
});

test('messaging-only declarations and disabled delegation omit unavailable operation guidance', () => {
  for(const capability of [{messaging:'parent',continuation:true,delegation:false},caps]){
    const tool=sessionControlToolDefinitions(capability,false).find(tool=>tool.name==='agent');
    assert.doesNotMatch(tool.description,/spawn|assign|close|todo|session wait|delegat/u);
  }
  const operations=agentOperationDefinitions({messaging:'parent',continuation:true,delegation:false});
  assert.deepEqual(operations.map(item=>item.action),['models','send']);
});


test('template discovery and admission share all allowed model profiles', async t => {
  const preset={id:'configured',name:'Configured template',profileId:'profile:chosen',
    tools:{kernel:['fs.read'],controls:['agent','session'],plugins:false},
    capabilities:{messaging:'parent',continuation:true,delegation:false}};
  const f=await fixture(t,async function*({owner,sessionId,request,turn,service}){
    if(sessionId!==owner){
      assert.equal((await service.snapshot(sessionId)).recipe.profileId,'profile:default');
      yield answer(request,'Allowed profile complete.');return;
    }
    if(turn===1)yield call(request,'profiles:models',{action:'models'});
    else if(turn===2){
      const choices=JSON.parse(request.messages.findLast(message=>message.role==='tool').content);
      const spawn=choices.operations.find(operation=>operation.action==='spawn');
      assert.deepEqual(spawn.inputSchema.properties.profileId.enum,['profile:default','profile:chosen']);
      yield call(request,'profiles:spawn',{action:'spawn',preset:'configured',profileId:'profile:default',
        name:'Allowed model',task:'Use the selected allowed model.',delivery:'wait'});
    }else yield answer(request,'Profile choice integrated.');
  },false,undefined,{presets:JSON.stringify([preset])});
  const result=await f.run();
  assert.equal(result.agentTasks?.length,1,'an advertised profile must be admitted with the chosen template');
  assert.equal((await readEvents(f.journal,f.owner)).filter(event=>event.type==='session.control.rejected').length,0);
});

test('child delegation setting updates discovery, guidance and admission at the next request', async t => {
  const f=await fixture(t,async function*({owner,sessionId,request,turn,service}){
    if(sessionId===owner){
      if(turn===1)yield call(request,'delegation:spawn',{action:'spawn',preset:'analysis',name:'Research owner',
        task:'Update your delegation setting, report evidence, then finish.',delivery:'wait',capabilities:{delegation:true}});
      else if(textOf(request).includes('Delegation check complete.')
        || (await service.snapshot(owner)).agentTasks.some(task=>task.status!=='running'))yield answer(request,'Delegation evidence integrated.');
      else yield call(request,`delegation:wait:${turn}`,{action:'wait'});
      return;
    }
    if(turn===1){
      const settings=(await service.snapshot(sessionId)).subagentSettings;
      const reply=await service.submit({schemaVersion:'achbit.command.v3',type:'session.subagent-settings.set',sessionId,
        commandId:'command:disable-child-delegation',settings:{...settings,allowMemberAnalysis:false}});
      assert.equal(reply.status,'accepted');
      yield call(request,'child:models',{action:'models'});
    }else if(turn===2){
      const choices=JSON.parse(request.messages.findLast(message=>message.role==='tool').content);
      assert.ok(choices.operations.some(operation=>operation.action==='send'));
      assert.ok(!choices.operations.some(operation=>operation.action==='spawn'));
      assert.doesNotMatch(request.tools.find(tool=>tool.name==='agent').description,/delegat/iu);
      yield call(request,'child:blocked-spawn',{action:'spawn',name:'Unavailable child',task:'Read the evidence.',delivery:'async'});
    }else if(turn===3){
      assert.match(textOf(request),/agent_delegation_disabled/u);
      assert.equal(((await service.snapshot(sessionId)).agentTasks??[]).length,0);
      yield call(request,'child:send',{action:'send',agentId:owner,text:'CHILD_SETTING_FINDING'});
    }else yield answer(request,'Delegation check complete.');
  },true);
  const result=await f.run();
  assert.equal(result.agentTasks.length,1);
  const child=await f.service.snapshot(result.agentTasks[0].agentSessionId);
  assert.equal(child.run.status,'completed',JSON.stringify(child.run.error));
  assert.ok((await readEvents(f.journal,f.owner)).some(event=>event.type==='agent.message.received'&&event.payload.text==='CHILD_SETTING_FINDING'));
});
