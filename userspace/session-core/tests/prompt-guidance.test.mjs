import assert from 'node:assert/strict';
import test from 'node:test';
import { decodeAgentRecipe, inheritAgentRecipe } from '../../protocol/dist/index.js';
import { achbitProductComponents, productDocumentation } from '../dist/local-agent/productInstructions.js';
import { SessionConfigurationRegistry } from '../dist/local-agent/sessionConfiguration.js';
import { requestedPlanToolStage } from '../dist/local-agent/planStage.js';
import { environmentInstruction } from '../dist/local-agent/sessionEnvironment.js';
import { codingToolInstruction, codingToolView } from '../dist/local-agent/codingTools.js';
import { corePromptInstructions, stableCoreInstructions } from '../dist/local-agent/coreInstructions.js';
import { agentOperationDefinitions, sessionControlToolDefinitions } from '../dist/local-agent/sessionControls.js';
import { buildConversationProviderRequest } from '../dist/local-agent/contextComposer.js';
import { providerToolView } from '../dist/local-agent/providerToolCodec.js';
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

test('English review guidance distinguishes file links, preparation and output delivery', () => {
  const registry = new SessionConfigurationRegistry(undefined, achbitProductComponents);
  const core = stableCoreInstructions.map(item => item.text).join('\n');
  assert.match(core, /clickable file links.*line numbers/u);
  assert.doesNotMatch(core, /outputs table|artifact[._]present|plugin[._]activate|process[._]wait/u);
  const selected = registry.productInstructions({ productComponents: ['achbit.delivery'] });
  assert.equal(selected.length, 1);
  assert.match(selected[0].text, /user review as clickable links.*outputs table/u);
  assert.match(selected[0].text, /Writing a file, archiving it and delivering it are separate/u);
  assert.match(selected[0].text, /simple explanations inline/u);
  assert.deepEqual(registry.productInstructions({ productComponents: [] }), []);
  const text = [core, ...registry.productInstructions().map(item => item.text),
    ...sessionControlToolDefinitions(capabilities).map(tool => tool.description)].join('\n');
  assert.doesNotMatch(text, /\bplease\b|\bkindly\b|\bMUST\b|\bIMPORTANT\b|[\u3400-\u9fff]/iu);
});

test('minimal AC is an ordered subset of full ABC from the same prompt producers', () => {
  const definitions = ['fs.read', 'bash', 'fs.edit', 'fs.write'].map(name => ({
    name, description: name, origin: 'coreBuiltin', availability: 'callable', toolBindingRef: `binding:${name}`,
    possibleEffects: [name === 'bash' ? 'process' : name === 'fs.read' ? 'workspaceRead' : 'workspaceMutation'],
    inputSchema: { type: 'object', properties: { path: { type: 'string' }, command: { type: 'string' },
      content: { type: 'string' }, edits: { type: 'array' }, startLine: { type: 'integer' }, maxLines: { type: 'integer' } }, required: [] },
  }));
  const registry = new SessionConfigurationRegistry(undefined, achbitProductComponents);
  const compose = (expanded, components = []) => {
    const runtime = runtimeSnapshot('run:shared-slices', { tools: definitions });
    if (!expanded) runtime.codingTools = true;
    runtime.toolSelection = { controls: [], plugins: false };
    runtime.environment.productDocsPath = '/actual/product/guides';
    runtime.environment.primaryWorkspaceDirectory = { workspaceId: workspaceBinding.workspaceId, path: '/actual/project' };
    runtime.instructions = [...corePromptInstructions(expanded), ...productDocumentation(runtime.environment, expanded),
      environmentInstruction(runtime.environment), ...registry.productInstructions({ productComponents: components }),
      { id: 'achbit.project-instructions', text: 'Project-scoped content.' }];
    // Hold aliases fixed to isolate text slicing from the independent wire presentation.
    runtime.providerToolAliases = definitions.map(tool => ({ canonicalName: tool.name, wireName: `call_${tool.name.replace('.', '_')}` }));
    const result = buildConversationProviderRequest({ runtime, sessionId: 'session:shared-slices', runId: 'run:shared-slices',
      events: [], workspaceBindings: [workspaceBinding], purpose: 'agent', responseConstraint: 'normal', providerRequestId: 'request:shared-slices' });
    return new Map(result.receipt.messages.map((item, index) => [item.contributionId, result.request.messages[index].content]));
  };
  const minimal = compose(false), full = compose(true);
  const inOrder = (base, expanded) => {
    let cursor = 0;
    for (const slice of base) {
      const index = expanded.indexOf(slice, cursor);
      assert.ok(index >= cursor, `shared slice missing or reordered: ${slice}`);
      assert.equal(expanded.indexOf(slice, index + slice.length), -1, `shared slice duplicated: ${slice}`);
      cursor = index + slice.length;
    }
  };
  const preambleId = 'instruction:achbit.coding-agent';
  inOrder(minimal.get(preambleId).split(/(?<=\.)\s+/u), full.get(preambleId));
  assert.notEqual(full.get(preambleId).trim(), minimal.get(preambleId).trim(), 'the full preamble adds guidance to the shared sentences');
  for (const id of ['instruction:achbit.coding-tools', 'instruction:achbit.product-docs']) {
    inOrder(minimal.get(id).split('\n').filter(Boolean), full.get(id));
    assert.notEqual(minimal.get(id), full.get(id));
  }
  for (const id of ['instruction:achbit.coding.project_context', 'instruction:achbit.coding.cwd']) {
    assert.equal(minimal.get(id), full.get(id));
  }
  const body = map => [...map.values()].join('\n\n');
  assert.doesNotMatch(body(minimal), /<response>|Command environment|Follow returned cursors|computer-use\.md|Mermaid|outputs table/u);
  assert.match(body(full), /Follow returned cursors[\s\S]*<response>[\s\S]*Command environment/u);
  for (const map of [minimal, full]) {
    assert.equal((body(map).match(/<tools>/gu) ?? []).length, 1);
    assert.equal((body(map).match(/<docs>/gu) ?? []).length, 1);
    assert.ok(body(map).includes('/actual/product/guides'));
    assert.doesNotMatch(body(map), /- read:|- fs_read:/u);
  }
  const rich = compose(false, ['achbit.rich-replies']);
  assert.match(rich.get('instruction:achbit.rich-replies'), /Mermaid/u);
  // TCR: .task-artifacts/browser-interaction-20261117/TCR.md.
  assert.match(rich.get('instruction:achbit.rich-replies'), /Standalone components can be previewed interactively[\s\S]*Frontend Design/u);
  assert.doesNotMatch(rich.get('instruction:achbit.rich-replies'), /artifact\.prepare|artifact\.present|browser\.open/u,
    'the product slice discovers the capability; workflow details remain on demand');
  assert.deepEqual([...rich].filter(([id]) => id !== 'instruction:achbit.rich-replies'), [...minimal],
    'opting into one component inserts only its slice, without selecting the full prompt');
});

test('shared tool slices follow actual bindings without duplicating dynamic extension guidance', () => {
  const tools = ['fs.read', 'bash', 'process'].map(name => ({ name, origin: 'coreBuiltin', availability: 'callable', toolBindingRef: `binding:${name}` }));
  const aliases = new Map(tools.map(tool => [tool.name, `call_${tool.name}`]));
  const minimal = codingToolInstruction(tools, aliases, false).text;
  assert.match(minimal, /automatically managed[\s\S]*wait deadline/u);
  assert.doesNotMatch(minimal, /Follow returned cursors|Track commands through completion/u);
  const extension = { name: 'extension.inspect', origin: 'extension', availability: 'callable', toolBindingRef: 'binding:extension' };
  aliases.set(extension.name, 'inspect_extension');
  assert.equal(codingToolInstruction([extension], aliases, false), undefined);
  assert.equal(codingToolInstruction([{ ...extension, availability: 'blocked' }], aliases, false), undefined);
  assert.equal(codingToolInstruction([...tools, extension], aliases, false).text, minimal,
    'extension activation leaves the basic-tool system prefix unchanged');
  assert.deepEqual(corePromptInstructions(false).map(item => item.id), ['achbit.coding-agent']);
  assert.deepEqual(productDocumentation({}, false), []);
});

test('delivery and workflow tool descriptions retain their contracts without adding operations', () => {
  const tools = new Map(sessionControlToolDefinitions(capabilities).map(tool => [tool.name, tool]));
  assert.deepEqual([...tools.keys()].sort(), [
    'session', 'agent', 'artifact.present', 'plugin.activate', 'interaction.request', 'plan.publish', 'todo.update',
  ].sort());
  const delivery = tools.get('artifact.present');
  assert.match(delivery.description, /outputs table[\s\S]*clickable Markdown links/u);
  assert.match(delivery.description, /Writing or archiving a file alone does not deliver/u);
  assert.match(delivery.description, /Re-prepare changed files.*reuse deliveryId/u);
  assert.match(delivery.description, /does not load pixels/u);
  assert.deepEqual(delivery.inputSchema.required, ['items']);
  assert.deepEqual(delivery.inputSchema.properties.items.items.required, ['artifactId', 'label']);
  assert.match(tools.get('interaction.request').description, /clickable options[\s\S]*silence is not a choice/u);
  assert.match(tools.get('plan.publish').description, /confirmation, execution permission and engineering decisions remain separate/u);
  assert.match(tools.get('plugin.activate').description, /installation, enablement, task activation and execution permission are separate/u);
  assert.match(tools.get('session').description, /statement about later work does not schedule/u);
  assert.match(tools.get('agent').description, /tightly coupled work local[\s\S]*verify final results/u);
  for (const name of ['artifact.present', 'plugin.activate', 'interaction.request', 'plan.publish', 'session']) {
    assert.match(tools.get(name).description, /Submit alone/u);
  }
});

test('minimal and full requests keep selected delivery guidance and actual aliases separate', () => {
  const definitions = ['fs.read', 'bash', 'fs.edit', 'fs.write', 'plugin.search'].map(name => ({
    name, description: name, origin: 'coreBuiltin', availability: 'callable', toolBindingRef: `binding:${name}`,
    possibleEffects: [name === 'bash' ? 'process' : name === 'fs.read' ? 'workspaceRead'
      : name === 'plugin.search' ? 'localRead' : 'workspaceMutation'],
    inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: [] },
  }));
  const registry = new SessionConfigurationRegistry(undefined, achbitProductComponents);
  const compose = full => {
    const tools = full ? definitions : definitions.filter(tool => tool.name !== 'plugin.search');
    const runtime = runtimeSnapshot('run:delivery-guidance', { tools, permissions: {
      'agent.permissions.workspaceMutation': 'allow', 'agent.permissions.engineeringDecisions': 'delegate',
    } });
    runtime.toolSelection = { controls: full ? ['artifact.present', 'plugin.activate'] : [] };
    runtime.instructions = [...stableCoreInstructions, ...registry.productInstructions(full ? {} : { productComponents: [] })];
    runtime.providerToolAliases.find(alias => alias.canonicalName === 'artifact.present').wireName = 'deliver_review';
    return buildConversationProviderRequest({ runtime, sessionId: 'session:delivery-guidance', runId: 'run:delivery-guidance',
      purpose: 'agent', providerRequestId: 'request:delivery-guidance', events: [], workspaceBindings: [workspaceBinding] }).request;
  };
  const minimal = compose(false), full = compose(true);
  assert.equal(minimal.tools.some(tool => tool.name === 'deliver_review'), false);
  assert.equal(full.tools.some(tool => tool.name === 'deliver_review'), true);
  assert.doesNotMatch(minimal.messages.map(message => message.content).join('\n'), /outputs table|register an output/u);
  assert.match(full.messages.map(message => message.content).join('\n'), /review as clickable links.*outputs table/u);
  assert.match(full.tools.find(tool => tool.name === 'deliver_review').description, /returned references as clickable Markdown links/u);
  assert.equal(full.tools.some(tool => tool.name === 'artifact.present'), false);
  for (const name of ['deliver_review', 'plugin_activate']) {
    assert.match(full.tools.find(tool => tool.name === name).description, /only tool call in (?:this|the) response/iu);
    assert.match(full.tools.find(tool => tool.name === name).description, /outside (?:any|a) parallel batch/iu);
  }
  assert.doesNotMatch(minimal.messages.map(message => message.content).join('\n'), /only tool call in (?:this|the) response/iu);
});

test('file and managed execution guidance follows the available capabilities', () => {
  const tools = ['fs.read', 'bash', 'process'].map(name => ({ name, origin: 'coreBuiltin', availability: 'callable' }));
  const aliases = new Map([['fs.read', 'inspect_file'], ['bash', 'run_shell'], ['process', 'manage_command']]);
  const ordinary = codingToolInstruction(tools.filter(tool => tool.name !== 'process'), aliases).text;
  assert.match(ordinary, /Follow returned cursors or full-output paths/u);
  assert.match(ordinary, /Preserve the target exit status/u);
  assert.doesNotMatch(ordinary, /wait deadline|automatically managed/u);
  const managed = codingToolInstruction(tools, aliases).text;
  assert.match(managed, /wait deadline leaves the command running/u);
  assert.match(managed, /resources this task is authorized to manage/u);
  assert.match(managed, /inspect_file:.*contents[\s\S]*run_shell:/u);
  assert.equal(codingToolInstruction([], aliases), undefined);
});

test('the shell routes uncovered capabilities through the actual callable discovery alias', () => {
  const builtin = name => ({ name, origin: 'coreBuiltin', availability: 'callable' });
  for (const shell of ['bash', 'powershell']) {
    for (const expanded of [false, true]) {
      const search = builtin('plugin.search');
      const aliases = new Map([[shell, 'run_command'], ['fs.read', 'read_file'], [search.name, 'lookup_available']]);
      const text = tools => codingToolInstruction([builtin('fs.read'), ...tools], aliases, expanded).text;
      assert.match(text([builtin(shell), search]), /lookup_available/u);
      assert.doesNotMatch(text([builtin(shell), { ...search, availability: 'blocked' }]), /lookup_available/u);
      assert.doesNotMatch(text([builtin(shell)]), /lookup_available/u);
      assert.doesNotMatch(text([search]), /lookup_available/u);
    }
  }
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

test('product Shell paths require a successful read of the installed operations guide and respect Host access', () => {
  const registry = new SessionConfigurationRegistry(undefined, achbitProductComponents);
  assert.deepEqual(registry.productToolGuidance({tools:{plugins:false}}), []);
  const [contribute] = registry.productToolGuidance({productComponents:['achbit.product-operations']});
  const shell = {name:'bash',origin:'coreBuiltin'};
  const runtime = runtimeSnapshot('run:shell');
  Object.assign(runtime.environment, {productDocsPath:'/product/docs',hostDataDirectory:'/host/data',
    commandPaths:{git:'/tools/git'},runtimeExecutables:{kernel:'/kernel',cli:'/host/cli'}});
  const input = {runtime,runId:'run:shell',tools:[shell],events:[]};
  const read = (path,extra={}) => ({runId:input.runId,callId:'call:product',type:'tool.completed',payload:{record:{
    toolName:'fs.read',preparedEffect:{origin:'coreBuiltin'},outcome:'completed',input:{path},...extra}}});
  const guide = '/product/docs/operations.md';
  assert.deepEqual(contribute(input), []);
  for (const event of [read('/fixture/operations.md'),read(guide,{outcome:'failed'}),read(guide,{toolName:'skill.read'}),
    read(guide,{preparedEffect:{origin:'extension'}}),{...read(guide),runId:'older'}]) {
    assert.deepEqual(contribute({...input,events:[event]}), []);
  }
  const observed = {...input,events:[read(guide)]};
  const [fact] = contribute(observed);
  assert.equal(fact.toolName,'bash');
  assert.equal(fact.contributionId,'tool-result:call:product');
  for (const text of ['/product/docs','/host/cli','/host/data','/tools/git','--host-data-dir']) assert.ok(fact.text.includes(text));
  assert.match(fact.text, /requestHostPermission/);
  assert.match(fact.text, /read-only commands such as plugins status/);
  assert.deepEqual(contribute({...observed,tools:[]}), []);
  for (const recipe of [{permissionPolicy:{id:'workspace-only'},workspaceSandbox:{backendId:'platform'}},
    {permissionPolicy:{id:'local-standard'},workspaceSandbox:{backendId:'platform',requireIsolatedProcesses:true}}]) {
    const environment = {...runtime.environment,agentComposition:{...recipe,
      policyConstraints:{allowHostExecution:false,allowExternalTools:false},sandboxCoverage:'workspaceShell'}};
    const before=structuredClone(environment);
    const restricted=contribute({...observed,runtime:{...runtime,environment}})[0];
    assert.ok(restricted.text.includes('/product/docs'));
    assert.doesNotMatch(restricted.text,/achbitCli|\/host\/data|--host-data-dir/u);
    assert.match(restricted.text, /Host execution is disabled.*CLI is unavailable/);
    assert.deepEqual(environment,before);
  }
  const windows = {...runtime,environment:{...runtime.environment,os:'windows',productDocsPath:'C:\\App\\docs\\product'}};
  assert.equal(contribute({...input,runtime:windows,events:[read('C:/App/docs/product/operations.md')]}).length,1);
  const old = {type:'message.committed',runId:input.runId,payload:{role:'user',messageId:'input',
    guidanceReferences:[{toolName:'skill.read',name:'achbit-product'}]}};
  const activation = {type:'session.plugins.activated',runId:input.runId,callId:'call:old',
    payload:{pluginUris:['plugin://achbit-iteration@builtin']}};
  assert.deepEqual(contribute({...input,events:[old,activation]}),[]);
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
  assert.match(ordinary.get('instruction:achbit.workspace-autonomy'), /Distinguish missing dependencies from denied access/u);
  assert.match(ordinary.get('instruction:achbit.workspace-autonomy'), /Do not widen access or retry a denied operation without authorization/u);
  assert.match(ordinary.get('instruction:achbit.coding-tools'), /inspect_file:.*contents/u);
  assert.match(ordinary.get('instruction:achbit.coding-tools'), /powershell:/u);
  const [descriptions, rules] = ordinary.get('instruction:achbit.coding-tools').split('\n\n');
  assert.match(descriptions, /^<tools>[\s\S]*inspect_file:[\s\S]*powershell:[\s\S]*fs_edit:[\s\S]*fs_write:[\s\S]*<\/tools>$/u);
  assert.doesNotMatch(descriptions, /edits\[\]\.oldText/u);
  assert.match(rules, /^<rules>[\s\S]*Use inspect_file[\s\S]*edits\[\]\.oldText[\s\S]*<\/rules>$/u);
  assert.match(rules, /paths observed in listings[\s\S]*after its producing command has completed/u);
  assert.match(rules, /keep ownership of test processes until they exit/u);
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

test('both tool presentations share one operation description and inherit Kernel schema constraints', () => {
  for (const name of ['fs.read', 'fs.edit', 'bash', 'powershell']) {
    const description = `Observed ${name} operation, file bindings and execution scope.`;
    const tool = { name, origin: 'coreBuiltin', description, inputSchema: {
      type: 'object', properties: { path: {type:'string'}, edits: {type:'array'},
        command: {type:'string'}, timeout: {type:'integer'}, requestFileAccess: {type:'object'} },
    } };
    const [projected] = codingToolView([tool]);
    assert.equal(projected.description.split(description).length, 2, 'captured operation and scope occur exactly once');
    assert.equal(codingToolView([tool], false)[0].description, description);
    if (name !== 'fs.read') assert.equal(projected.description, description, 'no second operation description is appended');
    else assert.match(projected.description, /50 KiB.*offset\/limit/u);
    if (name === 'bash' || name === 'powershell') {
      assert.deepEqual(projected.inputSchema.properties.requestFileAccess, tool.inputSchema.properties.requestFileAccess);
    }
    assert.deepEqual(codingToolView([{...tool, origin:'extension'}]), [{...tool, origin:'extension'}]);
  }
});

test('tool presentation removes forbidden Host requests but retains separately requestable scopes in both contexts', () => {
  const shell = { name: 'bash', origin: 'coreBuiltin', description: 'Run Bash in the workspace sandbox.', availability: 'callable',
    inputSchema: {type:'object',additionalProperties:false,required:['command'],properties:{command:{type:'string',maxLength:16384,
      description:'Use TMPDIR for temporary files; preserve the command exit status.'},timeout:{type:'integer',minimum:1,maximum:4294967295},
      requestHostPermission:{type:'string'},requestNetworkPermission:{type:'string'},requestFileAccess:{type:'object'},terminal:{type:'object'}}} };
  for (const codingTools of [false,true]) {
    const runtime=runtimeSnapshot('run:tool-view',{tools:[shell]});
    runtime.codingTools=codingTools;
    runtime.permissions['agent.permissions.shellAccess']='full';
    runtime.environment.os='macos'; runtime.environment.arch='arm64';
    runtime.environment.agentComposition={permissionPolicy:{id:'workspace-only'},policyConstraints:{allowHostExecution:false,allowExternalTools:false},
      workspaceSandbox:{backendId:'sandbox-exec',requireIsolatedProcesses:true},sandboxCoverage:'workspaceShell'};
    const original=structuredClone(shell);
    const [restricted]=providerToolView([shell],runtime,[workspaceBinding],[workspaceBinding]);
    assert.equal(restricted.inputSchema.properties.requestHostPermission,undefined);
    assert.deepEqual(restricted.inputSchema.properties.requestNetworkPermission,shell.inputSchema.properties.requestNetworkPermission);
    assert.deepEqual(restricted.inputSchema.properties.requestFileAccess,shell.inputSchema.properties.requestFileAccess);
    assert.deepEqual(restricted.inputSchema.properties.timeout,shell.inputSchema.properties.timeout);
    assert.deepEqual(restricted.inputSchema.required,['command']);
    assert.equal(restricted.inputSchema.additionalProperties,false);
    assert.match(restricted.description,/workspace sandbox[\s\S]*bash on macos \(arm64\)/u);
    assert.match(restricted.inputSchema.properties.command.description,/TMPDIR/u);
    assert.doesNotMatch(restricted.description,/as the host user/u);
    assert.deepEqual(shell,original,'presentation does not change the captured executor binding');
    delete runtime.environment.agentComposition;
    runtime.permissions['agent.permissions.shellAccess']='workspace';
    assert.ok(providerToolView([shell],runtime,[workspaceBinding],[workspaceBinding])[0].inputSchema.properties.requestHostPermission,
      'an ungranted but requestable Host scope remains available');
    const extension={...shell,origin:'extension'};
    assert.deepEqual(providerToolView([extension],runtime,[workspaceBinding],[workspaceBinding]),[extension]);
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
