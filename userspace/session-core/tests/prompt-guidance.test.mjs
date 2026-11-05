import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeAgentRecipe, inheritAgentRecipe } from '../../protocol/dist/index.js';
import { achbitProductComponents } from '../dist/local-agent/productInstructions.js';
import { SessionConfigurationRegistry } from '../dist/local-agent/sessionConfiguration.js';
import { requestedPlanToolStage } from '../dist/local-agent/planStage.js';
import { environmentInstruction } from '../dist/local-agent/sessionEnvironment.js';
import { codingToolView } from '../dist/local-agent/codingTools.js';
import { stableCoreInstructions } from '../dist/local-agent/coreInstructions.js';
import { agentOperationDefinitions, sessionControlToolDefinitions } from '../dist/local-agent/sessionControls.js';
import { buildConversationProviderRequest } from '../dist/local-agent/contextComposer.js';
import { runtimeSnapshot, workspaceBinding } from './local-agent-fixtures.mjs';

const names = {
  interactionRequest: 'ask_user_wire', planPublish: 'publish_plan_wire',
  todoUpdate: 'update_todo_wire', pluginActivate: 'activate_plugin_wire',
  artifactPresent: 'present_artifact_wire',
};
const capabilities = { messaging: true, delegation: true, continuation: true };

test('stable core stays separate from dynamic control syntax', () => {
  assert.deepEqual(stableCoreInstructions.map(slice => slice.id), ['achbit.coding-agent', 'achbit.reply-format']);
  assert.match(stableCoreInstructions[1].text, /requested response format/u);
  assert.match(stableCoreInstructions[1].text, /^<response>[\s\S]+<\/response>$/u);
  const text = stableCoreInstructions.map(slice => slice.text).join('\n');
  assert.doesNotMatch(text, /plan_publish|interaction_request|workspaceId|mutationManifest|\[DONE:|\[PLAN MODE ACTIVE\]/u,
    'tool syntax, dynamic identities and mode-specific formats do not belong in the stable core');
});

test('Host-installed product slices compose independently from tools, metadata and registration', () => {
  const extra = { id: 'extension.fixture', text: 'Fixture guidance.' };
  const standalone = new SessionConfigurationRegistry();
  const registry = new SessionConfigurationRegistry(undefined, [...achbitProductComponents, extra]);
  const select = recipe => registry.productInstructions(decodeAgentRecipe(recipe));
  const base = { tools: { kernel: ['bash'], controls: [], plugins: false } };
  assert.deepEqual(standalone.productInstructions(), []);
  assert.deepEqual(select(base), []);
  assert.deepEqual(select({ productComponents: [] }), []);
  const full = select({});
  assert.ok(full.some(item => item.id === 'achbit.collaboration' && /Update them/u.test(item.text)));
  const rich = full.filter(item => item.id === 'achbit.rich-replies');
  assert.equal(rich.length, 1);
  assert.match(rich[0].text, /Mermaid[\s\S]+Markdown table/u);
  assert.ok(!full.some(item => item.id === extra.id || item.id === 'achbit.conversation-title'));
  assert.doesNotMatch(stableCoreInstructions[0].text, /Mermaid|opening explanation|Update them/u);
  assert.deepEqual(select({ ...base, productComponents: ['achbit.conversation-title', extra.id] }), [extra]);
  const ids = ['achbit.rich-replies', 'achbit.delivery'];
  const recipe = { ...base, productComponents: ids };
  const slices = select(recipe);
  assert.ok(slices.some(item => item.id === 'achbit.rich-replies' && /Mermaid/u.test(item.text)));
  assert.deepEqual(new Set(slices.map(item => item.id)), new Set(ids));
  assert.deepEqual(select({ productComponents: ids.toReversed() }), slices, 'registry order keeps equivalent selections stable');
  assert.deepEqual(inheritAgentRecipe(recipe, {}).productComponents, ids);
  assert.deepEqual(inheritAgentRecipe(recipe, { productComponents: [] }).productComponents, []);
  assert.throws(() => select({ productComponents: ['uninstalled'] }), /session_product_component_unavailable/u);
  for (const invalid of ['achbit.collaboration', ['achbit.collaboration', 'achbit.collaboration']]) {
    assert.throws(() => select({ productComponents: invalid }), /agent_product_components_invalid/u);
  }
});

test('the selected product component locates product and plugin guides from the prepared environment', () => {
  const registry = new SessionConfigurationRegistry(undefined, achbitProductComponents);
  assert.equal(registry.productEnvironmentInstructions({ tools: { plugins: false } }), undefined);
  assert.equal(registry.productEnvironmentInstructions({ productComponents: [] }), undefined);
  const selected = registry.productEnvironmentInstructions({ productComponents: ['achbit.product-operations'] });
  assert.deepEqual(selected({}), []);
  for (const root of ['/bundle/docs/product', 'C:\\app\\docs\\product']) {
    const [guide] = selected({ productDocsPath: root });
    assert.equal(guide.id, 'achbit.product-docs');
    assert.ok(guide.text.includes(JSON.stringify(root)));
    assert.match(guide.text, /^<docs>[\s\S]*operations\.md[\s\S]*\.\.\/plugins\/README\.md[\s\S]*<\/docs>$/u);
    assert.deepEqual(registry.productEnvironmentInstructions()({ productDocsPath: root }), [guide]);
  }
});

test('product Shell paths require an installed slice and an actual product operations selection', () => {
  const registry = new SessionConfigurationRegistry(undefined, achbitProductComponents);
  assert.deepEqual(registry.productToolGuidance({tools:{plugins:false}}), []);
  const [contribute] = registry.productToolGuidance({productComponents:['achbit.product-operations']});
  const shell = {name:'bash',origin:'coreBuiltin'};
  const runtime = runtimeSnapshot('run:shell');
  Object.assign(runtime.environment, {productDocsPath:'/product/docs',hostDataDirectory:'/host/data',
    commandPaths:{git:'/tools/git'},runtimeExecutables:{kernel:'/kernel',cli:'/host/cli'}});
  const input = {runtime,runId:'run:shell',tools:[shell],events:[]};
  const read = (name,extra={}) => ({runId:input.runId,callId:'call:product',type:'tool.completed',payload:{record:{
    toolName:'skill.read',preparedEffect:{origin:'coreBuiltin'},outcome:'completed',input:{name},...extra}}});
  assert.deepEqual(contribute(input), []);
  for (const event of [read('achbit-documents'),read('achbit-product',{outcome:'failed'}),
    read('achbit-product',{preparedEffect:{origin:'extension'}}),{...read('achbit-product'),runId:'older'}]) {
    assert.deepEqual(contribute({...input,events:[event]}), []);
  }
  const observed = {...input,events:[read('achbit-product')]};
  const [fact] = contribute(observed);
  assert.equal(fact.toolName,'bash');
  assert.equal(fact.contributionId,'tool-result:call:product');
  for (const text of ['/product/docs','/host/cli','/host/data','/tools/git','--host-data-dir']) assert.ok(fact.text.includes(text));
  assert.deepEqual(contribute({...observed,tools:[]}), []);
  for (const recipe of [{permissionPolicy:{id:'workspace-only'},workspaceSandbox:{backendId:'platform'}},
    {permissionPolicy:{id:'local-standard'},workspaceSandbox:{backendId:'platform',requireIsolatedProcesses:true}}]) {
    const environment = {...runtime.environment,agentComposition:{...recipe,
      policyConstraints:{allowHostExecution:false,allowExternalTools:false},sandboxCoverage:'workspaceShell'}};
    const before=structuredClone(environment);
    const restricted=contribute({...observed,runtime:{...runtime,environment}})[0];
    assert.ok(restricted.text.includes('/product/docs'));
    assert.doesNotMatch(restricted.text,/achbitCli|\/host\/data|--host-data-dir/u);
    assert.deepEqual(environment,before);
  }
  const selected={...runtime,selectedPlugins:{catalogRevision:'r',plugins:[{uri:'plugin://achbit-iteration@builtin'}]}};
  const started = snapshot => ({type:'run.started',runId:input.runId,
    payload:{inputMessageId:'input',runtimeSnapshot:snapshot}});
  const selectedMessage = {type:'message.committed',payload:{role:'user',messageId:'input'}};
  const messageFact = {...fact,contributionId:'message:input'};
  assert.deepEqual(contribute({...input,runtime:selected,events:[selectedMessage,started(selected)]}),[messageFact]);
  const activation = {type:'session.plugins.activated',runId:input.runId,callId:'call:activate',
    payload:{pluginUris:['plugin://achbit-product@builtin']}};
  assert.deepEqual(contribute({...input,events:[activation]}),[{...fact,contributionId:'plugin-activation:call:activate'}]);
  const tag = {type:'message.committed',payload:{role:'user',messageId:'input',guidanceReferences:[
    {toolName:'skill.read',name:'achbit-product'}]}};
  assert.deepEqual(contribute({...input,events:[tag,started(runtime)]}),[messageFact]);
  assert.deepEqual(contribute({...input,events:[tag,{...started(runtime),runId:'past'}]}),[]);
});

test('agent operation discovery respects delegation and coordinator boundaries', () => {
  const agent = sessionControlToolDefinitions(capabilities).find(tool => tool.name === 'agent');
  assert.ok(agent);
  const definitions = agentOperationDefinitions(capabilities, { fullConfiguration: true });
  const disabled = agentOperationDefinitions(capabilities, { canSpawn: false });
  assert.equal(disabled.some(operation => ['spawn', 'assign'].includes(operation.action)), false);
  assert.ok(disabled.some(operation => operation.action === 'send'));
  assert.ok(definitions.some(operation => operation.action === 'assign'));
  const member = agentOperationDefinitions(capabilities, { coordinator: false });
  assert.equal(member.some(operation => ['assign', 'close'].includes(operation.action)), false);
  const memberSpawn = member.find(operation => operation.action === 'spawn').inputSchema.properties;
  assert.ok(memberSpawn.preset);
  for (const field of ['permissions', 'permissionPolicy', 'runner', 'workspaceSandbox', 'loop', 'context', 'capabilities']) assert.equal(memberSpawn[field], undefined, field);
});

test('messaging-only agents can send without receiving a spawn operation', () => {
  const restricted = { messaging: 'parent', delegation: false, continuation: false };
  const operations = agentOperationDefinitions(restricted);
  assert.equal(operations.some(operation => operation.action === 'spawn'), false);
  assert.ok(operations.some(operation => operation.action === 'send'));
});

test('runtime guidance follows selected control aliases and permission modes', () => {
  const aliases = { 'interaction.request': names.interactionRequest, 'plan.publish': names.planPublish,
    'todo.update': names.todoUpdate, 'plugin.activate': names.pluginActivate, 'artifact.present': names.artifactPresent };
  const tool = (name, effects) => ({ name, toolBindingRef: 'binding:' + name, origin: 'coreBuiltin', availability: 'callable',
    description: name, possibleEffects: effects, inputSchema: {type:'object', properties:{path:{type:'string'}}, required:['path']} });
  const request = (controls, mode, engineering = 'delegate', tools = [tool('fs.write',['workspaceMutation']),tool('plugin.search',['localRead'])]) => {
    const runtime = runtimeSnapshot('run:policy', {tools,
      permissions:{ 'agent.permissions.workspaceMutation':mode, 'agent.permissions.engineeringDecisions':engineering }});
    runtime.toolSelection = { controls };
    runtime.providerToolAliases = [...runtime.providerToolAliases.filter(alias => tools.some(tool => tool.name === alias.canonicalName)),
      ...controls.map(name => ({canonicalName:name,wireName:aliases[name]}))];
    return buildConversationProviderRequest({runtime,sessionId:'session:policy',runId:'run:policy',providerRequestId:'req',
      purpose:'agent',responseConstraint:'normal',workspaceBindings:[workspaceBinding],events:[]}).request;
  };
  const all = request(Object.keys(aliases), 'plan');
  for (const alias of Object.values(names)) assert.ok(all.tools.some(tool => tool.name === alias));
  const body = all.messages.map(item => item.content).join('\n');
  assert.ok(body.includes(names.planPublish) && body.includes(names.interactionRequest));
  for (const alias of [names.todoUpdate,names.pluginActivate,names.artifactPresent]) assert.ok(!body.includes(alias));
  assert.match(all.tools.find(tool => tool.name === names.interactionRequest).description, /Submit alone/u);
  const review = request(['plan.publish','interaction.request'], 'review');
  assert.ok(review.messages.some(item => item.content.includes(names.planPublish) && item.content.includes(names.interactionRequest)));
  const noPlan = request(['plan.publish','interaction.request'], 'allow');
  assert.ok(!noPlan.tools.some(tool => tool.name === names.planPublish));
  assert.ok(noPlan.messages.some(item => item.content.includes(names.interactionRequest)));
  assert.ok(!noPlan.messages.some(item => item.content.includes(names.planPublish)));
  for (const tools of [undefined, [tool('fs.read',['workspaceRead'])]]) {
    const ask = request(['interaction.request'], 'allow', 'ask', tools);
    const delegated = request(['interaction.request'], 'allow', 'delegate', tools);
    for (const view of [ask, delegated]) {
      assert.ok(view.messages.some(item => item.content.includes(names.interactionRequest) && item.content.includes('missing requirements')));
      assert.ok(!view.tools.some(tool => tool.name === names.planPublish));
    }
    assert.ok(ask.messages.some(item => /let the user choose/u.test(item.content)));
    assert.ok(delegated.messages.some(item => /Engineering decisions are delegated/u.test(item.content)));
  }
  const bare = request([], 'allow');
  assert.ok(!bare.messages.some(item => Object.values(names).some(name => item.content.includes(name))));

});

test('the tool stage owns Plan guidance and only callable basic operations are named', () => {
  const tools = [['fs.read', 'workspaceRead'], ['powershell', 'process'], ['fs.edit', 'workspaceMutation'],
    ['fs.write', 'workspaceMutation']].map(([name, effect]) => ({
    name, toolBindingRef: 'binding:' + name, origin: 'coreBuiltin', availability: 'callable',
    possibleEffects: [effect], description: name, inputSchema: { type: 'object', properties: {}, required: [] },
  }));
  const runtime = runtimeSnapshot('run:slices', { tools });
  runtime.toolSelection = { controls: ['plan.publish'], plugins: false };
  runtime.permissions['agent.permissions.workspaceMutation'] = 'allow';
  runtime.providerToolAliases.find(alias => alias.canonicalName === 'fs.read').wireName = 'inspect_file';
  const compose = state => {
    const result = buildConversationProviderRequest({ purpose: 'agent', sessionId: 'session:slices',
      runId: 'run:slices', runtime, events: [], workspaceBindings: [workspaceBinding],
      providerRequestId: 'request:slices', responseConstraint: 'normal', toolStage: requestedPlanToolStage(runtime, state) });
    return new Map(result.receipt.messages.map((item, i) => [item.contributionId, result.request.messages[i].content]));
  };
  const ordinary = compose({});
  assert.equal(ordinary.has('session:tool-stage'), false);
  assert.match(ordinary.get('instruction:achbit.coding-tools'), /inspect_file:.*contents/u);
  assert.match(ordinary.get('instruction:achbit.coding-tools'), /powershell:/u);
  const [descriptions, rules] = ordinary.get('instruction:achbit.coding-tools').split('\n\n');
  assert.match(descriptions, /^<tools>[\s\S]*inspect_file:[\s\S]*powershell:[\s\S]*fs_edit:[\s\S]*fs_write:[\s\S]*<\/tools>$/u);
  assert.doesNotMatch(descriptions, /edits\[\]\.oldText/u);
  assert.match(rules, /^<rules>[\s\S]*Use inspect_file[\s\S]*edits\[\]\.oldText[\s\S]*<\/rules>$/u);
  assert.doesNotMatch(ordinary.get('instruction:achbit.coding-tools'), /bash:|fs_read:/u);
  runtime.planMode = 'manual';
  runtime.permissions['agent.permissions.workspaceMutation'] = 'plan';
  const before = compose({});
  assert.match(before.get('session:tool-stage'), /after confirmation[\s\S]*writablePaths: \[\]/u);
  assert.doesNotMatch(before.get('instruction:achbit.coding-tools'), /powershell:|fs_edit:|fs_write:/u);
  const after = compose({activePlanRef: {planId: 'plan:one', runId: 'run:slices', revision: 1}});
  assert.match(after.get('session:tool-stage'), /Plan is confirmed/u);
  assert.match(after.get('instruction:achbit.coding-tools'), /fs_edit:/u);
  assert.match(after.get('instruction:achbit.coding-tools'), /edits\[\]\.oldText/u);
  assert.doesNotMatch(before.get('instruction:achbit.coding-tools'), /oldText|complete rewrites/u);
  delete runtime.planMode;
  assert.equal(compose({}).has('session:tool-stage'), false);
});

test('coding tool projection retains Kernel-owned operation and scope descriptions', () => {
  for (const name of ['fs.read', 'fs.edit', 'bash', 'powershell']) {
    const description = `Observed ${name} operation, file bindings and execution scope.`;
    const tool = { name, origin: 'coreBuiltin', description, inputSchema: {
      type: 'object', properties: { path: {type:'string'}, edits: {type:'array'},
        command: {type:'string'}, timeout: {type:'integer'}, requestFileAccess: {type:'object'} },
    } };
    const [projected] = codingToolView([tool]);
    assert.equal(projected.description, description);
    if (name === 'bash' || name === 'powershell') {
      assert.deepEqual(projected.inputSchema.properties.requestFileAccess, tool.inputSchema.properties.requestFileAccess);
    }
    assert.deepEqual(codingToolView([{...tool, origin:'extension'}]), [{...tool, origin:'extension'}]);
  }
});

test('coding environment reports the target shell and target path using frozen Kernel facts', () => {
  const base = runtimeSnapshot('run:platform').environment;
  for (const platform of [
    {os:'windows', tool:'powershell', dialect:'windowsPowerShell', cwd:'C:\\src'},
    {os:'windows', tool:'powershell', dialect:'powershell7', cwd:'C:\\src'},
    {os:'windows', tool:'bash', dialect:'bash', cwd:'D:\\src'},
    {os:'linux', tool:'bash', dialect:'bash', cwd:'/srv/src'},
    {os:'macos', tool:'bash', dialect:'bash', cwd:'/Users/me/src'},
  ]) {
    const env = {...base, os:platform.os, arch:'x86_64', shell:{tool:platform.tool, dialect:platform.dialect,
      executable:'detected-shell'}, developerCommands:['git','rg']};
    const text = environmentInstruction(env,[platform.tool],{cwd:platform.cwd}).text;
    assert.ok(text.includes(platform.dialect+' on '+platform.os+' (x86_64)'));
    assert.ok(text.includes(JSON.stringify(platform.cwd)));
    assert.ok(text.includes(`<cwd>\n${JSON.stringify(platform.cwd)}\n</cwd>`));
    assert.match(text,/Detected commands on PATH: git, rg/u);
    assert.match(text,/executable discovery; runtime dependencies, sandbox access and service readiness/u);
    assert.doesNotMatch(environmentInstruction(env,['fs.read'],{cwd:platform.cwd}).text,/Shell:|Detected commands/u);
  }
  const wsl = {...base, os:'linux', arch:'x86_64', shell:{tool:'bash',dialect:'bash',executable:'/bin/bash'},
    executionTarget:{kind:'wsl',distribution:'Debian',worker:'/opt/achbit/kernel'}};
  const wslText = environmentInstruction(wsl,['bash'],{}).text;
  assert.match(wslText,/bash on linux \(WSL, Debian\)/u);
  assert.match(wslText,/paths relative to the selected workspace/u);
  assert.doesNotMatch(wslText,/Working directory \(primary\)|C:\\/u);
  assert.doesNotMatch(environmentInstruction({...wsl,shellAvailable:false},['bash'],{}).text,/Shell:|Detected commands/u);
});
