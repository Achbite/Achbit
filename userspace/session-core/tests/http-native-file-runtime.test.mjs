import assert from 'node:assert/strict';
import test from 'node:test';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { KERNEL_REPLY_VERSION, LOCAL_AGENT_PROTOCOL_VERSION } from '../../protocol/dist/index.js';
import { buildAgentProviderRequest } from '../dist/local-agent/contextComposer.js';
import { corePromptInstructions } from '../dist/local-agent/coreInstructions.js';
import { createHash } from 'node:crypto';
import { decodeProviderToolInput, encodeProviderMessage, providerMessageCodecsByCallId } from '../dist/local-agent/providerToolCodec.js';
import { prepareApprovalReview } from '../dist/local-agent/approvalReview.js';
import { preparePlanReview } from '../dist/local-agent/planReview.js';
import { emptySessionState } from '../dist/local-agent/reducer.js';
import { prepareContextCompaction } from '../dist/local-agent/compaction.js';
import { achbitProductComponents } from '../dist/local-agent/productInstructions.js';
import { SessionConfigurationRegistry } from '../dist/local-agent/sessionConfiguration.js';
import { HttpRunPreparationPort } from '../dist/local-agent/httpPorts.js';
import { actorWith, createSession, emptyKernel, readEvents, runtimeSnapshot } from './local-agent-fixtures.mjs';
import { InMemoryCommandJournal } from './support/memoryJournal.mjs';
import { assertRuntimeContract } from './support/runtimeContract.mjs';

// Exercise the production HTTP adapter with the same envelope fields emitted by
// Host prepare-run; actor FakePort fixtures cannot detect this decoder mismatch.
async function httpPreparation(t, promptContributions, codingTools = false, environmentInstructions) {
  const seed = runtimeSnapshot('run:http-native');
  let provider = structuredClone(seed.provider);
  let reviewer = structuredClone(seed.provider);
  let projectInstructions, userSystemPrompt, tools = [];
  const requests = [], releases = [];
  const server = createServer(async (request, response) => {
    try {
      assert.equal(request.headers['x-achbit-session-service-token'], 'fixture-http-token');
      let body = '';
      for await (const chunk of request) body += chunk;
      const input = JSON.parse(body);
      let data;
      if (request.url === '/api/local-agent/runtime/prepare-run') {
        requests.push(input);
        data = { schemaVersion: LOCAL_AGENT_PROTOCOL_VERSION, type: 'run.runtime.prepared',
          sessionId: input.sessionId, runId: input.runId, mode: codingTools ? 'minimal' : 'full', provider, approvalReviewer: reviewer,
          ...(projectInstructions === undefined ? {} : { projectInstructions }),
          ...(userSystemPrompt === undefined ? {} : { userSystemPrompt }),
          webSearch: seed.webSearch, extensionGenerationRef: seed.extensionGenerationRef,
          kernelCatalogSnapshotRef: seed.kernelCatalogSnapshotRef, tools, toolPromptProviders: [],
          toolSelection: { kernel: tools.map(tool => tool.name), controls: [], plugins: seed.selectedPlugins.plugins.length > 0 },
          pluginConfig: { extensionGenerationRef: seed.extensionGenerationRef, permissions: seed.permissions, selectedPlugins: [] },
          selectedPlugins: seed.selectedPlugins, environment: seed.environment,
          agentCapabilities: seed.agentCapabilities, agentToolsEnabled: true, subagentSettings: seed.subagentSettings, contextManagement: seed.contextManagement };
      } else if (request.url === '/api/local-agent/runtime/release-run') {
        releases.push(input);
        data = { schemaVersion: KERNEL_REPLY_VERSION, type: 'tool.catalog.released', ...input,
          released: true, alreadyReleased: false };
      } else throw new Error(`unexpected_http_path:${request.url}`);
      response.writeHead(200, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: true, data }));
    } catch (error) {
      response.writeHead(500, { 'content-type': 'application/json' });
      response.end(JSON.stringify({ ok: false, error: String(error) }));
    }
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const port = new HttpRunPreparationPort({ apiBase: `http://127.0.0.1:${server.address().port}`,
    serviceToken: 'fixture-http-token', stableCoreInstructions: corePromptInstructions(false), promptContributions, codingTools, environmentInstructions });
  const request = { sessionId: 'session:http-native', runId: 'run:http-native', profileId: seed.provider.profileId,
    workspaceBindingIds: [] };
  return { port, request, requests, releases,
    useTools(value) { tools = value; },
    useShell(name) { seed.environment.shell = {tool:name, dialect:name, executable:name}; },
    useProjectInstructions(value) { projectInstructions = value; },
    useUserSystemPrompt(value) { userSystemPrompt = value; },
    useGeneration(name) { seed.kernelCatalogSnapshotRef = `catalog:${name}`; seed.extensionGenerationRef = `extension:${name}`; },
    usePlugins(uris) { seed.selectedPlugins.plugins = uris.map(uri => ({ uri,
      pluginArtifactRef: `artifact:${uri}`, pluginInstanceRef: `instance:${uri}`,
      extensionGenerationRef: seed.extensionGenerationRef, capabilityRefs: [] })); },
    useProvider(extra) { provider = { ...seed.provider, ...extra }; },
    useReviewer(extra) { reviewer = { ...seed.provider, ...extra }; } };
}

// TCR: T-022-Loop_Audit-20261122/最简Loop工具集/实施/TCR.md
const shape = { type: 'string' }, integer = { type: 'integer' }, access = { type: 'object' };
const binding = { workspaceId: 'project:root', displayName: 'Project' };
const bound = (name, possibleEffect, props, required) => ({ name, toolBindingRef: `binding:${name}`, origin: 'coreBuiltin', availability: 'callable', possibleEffects: [possibleEffect], description: `Bounds for ${name}.`, inputSchema: {type:'object', additionalProperties:false, properties:props, required} });
const four = [bound('fs.read','workspaceRead',{path:shape,startLine:integer,maxLines:{...integer,maximum:5000},maxBytes:{...integer,maximum:1048576},startByte:integer,requestFileAccess:access},['path']), bound('bash','process',{command:shape,timeout:integer,terminal:access,requestHostPermission:shape,requestFileAccess:access,requestNetworkPermission:shape},['command']), bound('fs.edit','workspaceMutation',{path:shape,edits:{type:'array',maxItems:128},requestFileAccess:access},['path','edits']), bound('fs.write','workspaceMutation',{path:shape,content:shape,executable:{type:'boolean'},requestFileAccess:access},['path','content'])];
const hash = text => createHash('sha256').update(text).digest('hex');
const RULE_DIGEST = 'a76fd1919fac7e0043d44a316be682b881bd74676f99a6bc59aed339918a89ce';
for (const minimal of [false,true]) test(`prepared ${minimal?'minimal':'full'} shares the neutral four-tool prefix and preserves Kernel budgets`, async t => {
  const f=await httpPreparation(t,[],minimal);
  const extra=bound('process','process',{action:shape},['action']);
  f.useTools(minimal ? four : [...four,extra]);
  const {runtimeSnapshot:runtime}=await f.port.prepare({...f.request,workspaceBindingIds:[binding.workspaceId]});
  assertRuntimeContract('RunRuntimeSnapshot',runtime);
  const {request,toolCodec}=await buildAgentProviderRequest({...f.request,runtime,events:[],workspaceBindings:[binding],directoryBindings:[binding],providerRequestId:'request:contracts',responseConstraint:'normal'});
  assert.deepEqual(request.tools.map(t=>t.name),['read','bash','edit','write',...(minimal?[]:['process'])]);
  const systems=request.messages.filter(m=>m.role==='system').map(m=>m.content);
  assert.equal(hash(systems[0]),'d2a7862631cc65f606a2cb669722c8fb9eceaa31ce7cd2c585e0726445752caa');
  const rules=systems.find(text=>text.startsWith('<tools>'));
  assert.equal(hash(rules),RULE_DIGEST);
  assert.match(rules,/read to list a known directory or bash to search/);
  assert.doesNotMatch(systems.join('\n'), /instead of (?:cat|sed)|prefer (?:the )?read tool|\bPI_\*|<response>/iu);
  const [read,shell,edit,write]=request.tools.map(tool=>tool.inputSchema.properties);
  assert.equal(read.offset.type,'integer');assert.equal(read.limit.maximum,5000);assert.equal(read.maxBytes.maximum,1048576);
  assert.ok(read.startByte && read.requestFileAccess && edit.requestFileAccess && write.requestFileAccess && write.executable && shell.terminal);
  assert.ok(!('startLine' in read) && !('maxLines' in read));
  const decode=x=>decodeProviderToolInput(toolCodec,'fs.read',x);
  for (const field of ['startLine','maxLines','endLine']) assert.throws(() => decode({path:'a',[field]:2}), err=>err.code==='tool_input_invalid' && err.field===field);
  assert.deepEqual(decode({path:'a',offset:2,limit:3000}),{path:'a',startLine:2,maxLines:3000,workspaceId:binding.workspaceId});
  assert.deepEqual(decode({path:'a',startByte:51200,maxBytes:1048576}),{path:'a',startByte:51200,maxBytes:1048576,workspaceId:binding.workspaceId});
  assert.equal(encodeProviderMessage({role:'assistant',content:'',toolCalls:[{callId:'a',name:'fs.read',input:{path:'a',startLine:2,maxBytes:1048576}}]},toolCodec).toolCalls[0].input.maxBytes,1048576);
});

test('restricted shared views name only the available lookup routes, including PowerShell', async t => {
  const f = await httpPreparation(t);
  for (const [names, route] of [
    [['fs.read'], 'Use read to list a known directory;'],
    [['bash'], 'Use bash to search (ls or find);'],
    [['powershell'], 'Use powershell to search (Get-ChildItem or Select-String);'],
    [['fs.read', 'powershell'], 'Use read to list a known directory or powershell to search (Get-ChildItem or Select-String);'],
  ]) {
    const shell = names.includes('powershell') ? 'powershell' : 'bash';
    f.useShell(shell);
    f.useTools(names.map(name => name === 'fs.read' ? four[0] : {...four[1], name}));
    const { runtimeSnapshot: runtime } = await f.port.prepare(f.request);
    const { request } = await buildAgentProviderRequest({ ...f.request, runtime, events: [], workspaceBindings:[binding],
      providerRequestId:'p:restricted', responseConstraint:'normal' });
    assert.deepEqual(request.tools.map(tool=>tool.name), names.map(name=>name==='fs.read'?'read':name));
    const guide = request.messages.find(m=>m.content.startsWith('<tools>')).content;
    assert.ok(guide.includes(route));
    if (!names.includes('fs.read')) assert.doesNotMatch(guide, /- read:|Use read to list/);
    if (shell==='powershell') assert.doesNotMatch(guide, /- bash:|ls or find/);
  }
});

test('new runs reserve core names, but a same-run refresh and recorded old calls keep their original interface', async t => {
  const f = await httpPreparation(t, [], false);
  const plugin = { ...bound('read','localRead',{q:shape},['q']), origin:'extension', pluginUri:'plugin://search@local' };
  f.useTools([...four,plugin]);
  const oldAliases = [{canonicalName:'fs.read',wireName:'fs_read'},{canonicalName:'read',wireName:'read'}];
  const prepare = async partial => (await f.port.prepare({...f.request,...partial})).runtimeSnapshot;
  const existingPresentation = {instructions:[...corePromptInstructions(true),{id:'achbit.legacy-selection',text:'Previously selected prose.'}]};
  const old = await prepare({existingPresentation,previousProviderToolAliases:oldAliases});
  assert.ok(old.instructions.some(part=>part.text==='Previously selected prose.'));
  const fresh = await prepare({workspaceBindingIds:[binding.workspaceId],previousProviderToolAliases:old.providerToolAliases});
  f.useUserSystemPrompt('applies to the next run only');
  const refreshed = await prepare({existingPresentation:{coreToolInterface:'shared',instructions:fresh.instructions},previousProviderToolAliases:fresh.providerToolAliases});
  assert.deepEqual(refreshed.instructions,fresh.instructions);assert.ok(!fresh.instructions.some(part=>part.text==='Previously selected prose.'));
  assert.equal(old.coreToolInterface,undefined);assert.equal(fresh.coreToolInterface,'shared');
  assert.ok(f.requests.every(req=>!('existingPresentation' in req) && !('previousProviderToolAliases' in req)));
  const wire=(r,name)=>r.providerToolAliases.find(a=>a.canonicalName===name).wireName;
  assert.equal(wire(old,'fs.read'),'fs_read');assert.equal(wire(fresh,'fs.read'),'read');
  assert.notEqual(wire(fresh,'read'),'read');assert.deepEqual(refreshed.providerToolAliases,fresh.providerToolAliases);
  const input = {path:'a',startLine:2,maxBytes:1048576};
  const events=[{type:'run.started',runId:'old',payload:{runtimeSnapshot:old}},{type:'context.composed',runId:'old',payload:{kernelCatalogSnapshotRef:old.kernelCatalogSnapshotRef,providerRequestId:'p:old',workspaceBindings:[]}}, {type:'tool.requested',runId:'old',callId:'old-call',payload:{}}];
  const history=providerMessageCodecsByCallId(events);
  const {toolCodec}=await buildAgentProviderRequest({...f.request,runtime:fresh,events:[],workspaceBindings:[binding],providerRequestId:'p:new',responseConstraint:'normal'});
  const replay=encodeProviderMessage({role:'assistant',content:'',toolCalls:[{callId:'old-call',name:'fs.read',input}]},toolCodec,history).toolCalls[0];
  assert.equal(replay.name,'fs_read');assert.deepEqual(replay.input,input);assert.equal(toolCodec.canonicalByWire.get('fs_read'),undefined);
});

test('explicit response and environment selections reuse only their own original text', async t => {
  const registry = new SessionConfigurationRegistry(undefined, achbitProductComponents);
  for (const productComponents of [[], ['achbit.reply-format'], ['achbit.session-environment']]) {
    const recipe = { productComponents };
    const f = await httpPreparation(t, registry.productInstructions(recipe), false, registry.productEnvironmentInstructions(recipe));
    f.useTools(four);
    const { runtimeSnapshot: runtime } = await f.port.prepare(f.request);
    const { request } = await buildAgentProviderRequest({ ...f.request, runtime, events: [], workspaceBindings: [binding],
      providerRequestId: 'p:optional', responseConstraint:'normal' });
    const systems = request.messages.filter(m => m.role === 'system').map(m => m.content);
    assert.equal(systems.filter(s => s === corePromptInstructions(true)[1].text).length, Number(productComponents.includes('achbit.reply-format')));
    assert.equal(systems.filter(s => s.startsWith('Command environment:')).length, Number(productComponents.includes('achbit.session-environment')));
    assert.equal(hash(systems.find(s => s.startsWith('<tools>'))), RULE_DIGEST);
  }
});

test('HTTP preparation admits enabled inherited plugins while requiring every new explicit selection', async t => {
  const fixture = await httpPreparation(t);
  const selected = uri => ({ selectionId: uri, uri, label: uri });
  const explicit = 'plugin://explicit@local', retained = 'plugin://retained@local';
  const request = { ...fixture.request, pluginSelections: [selected(explicit)],
    inheritedPluginSelections: [selected(retained)] };
  for (const available of [[explicit, retained], [explicit]]) {
    fixture.usePlugins(available);
    const prepared = await fixture.port.prepare(request);
    assert.deepEqual(prepared.runtimeSnapshot.selectedPlugins.plugins.map(plugin => plugin.uri), available);
    assert.deepEqual(fixture.requests.at(-1).inheritedPluginSelections, request.inheritedPluginSelections);
  }
  for (const unavailable of [[retained], [explicit, 'plugin://unrequested@local']]) {
    fixture.usePlugins(unavailable);
    await assert.rejects(fixture.port.prepare(request), /selected_plugin_snapshot_identity_mismatch/);
  }
});

test('actor recovery checks original and active HTTP bindings separately without rolling back a lookup', async t => {
  const uri = 'plugin://guidance@project', selection = { selectionId: 'select:guidance', uri, label: 'Guidance' };
  for (const failure of [undefined, 'unexpected-initial', 'wrong-active-instance', 'missing-active']) {
    const f = await httpPreparation(t);
    const { sessionId, runId } = f.request;
    const journal = new InMemoryCommandJournal();
    await createSession(journal, sessionId);
    f.useGeneration('first');
    const { runtimeSnapshot: first } = await f.port.prepare(f.request);
    f.useGeneration('second'); f.usePlugins([uri]);
    const { runtimeSnapshot: second } = await f.port.prepare({ ...f.request, pluginSelections: [selection] });
    const { kernelCatalogSnapshotRef, extensionGenerationRef, selectedPlugins, instructions, tools, providerToolAliases, toolPromptContributions } = second;
    const toolView = { kernelCatalogSnapshotRef, extensionGenerationRef, selectedPlugins, instructions, tools, providerToolAliases, toolPromptContributions };
    if (failure === 'wrong-active-instance') toolView.selectedPlugins.plugins[0].pluginInstanceRef = 'instance:other';
    await journal.appendBatch([
      { type:'message.committed', sessionId, payload:{messageId:'message:task',role:'user',content:'Read the guide.'} },
      { type:'run.started', sessionId, runId, payload:{inputMessageId:'message:task',workspaceBindings:[],runtimeSnapshot:first} },
      { type:'run.tools.prepared', sessionId, runId, payload:{toolView} },
      { type:'run.waiting', sessionId, runId, payload:{reason:'approval',detail:'Waiting for the user.'} },
    ]);
    const before = await readEvents(journal, sessionId);
    const port = {
      async prepare(input) {
        assert.equal(input.restoreEnvironment, true);
        const active = input.restoreToolViewRef !== undefined;
        if (active) assert.equal(input.restoreToolViewRef, kernelCatalogSnapshotRef);
        f.useGeneration(active ? 'second' : 'first');
        f.usePlugins((active && failure !== 'missing-active' || !active && failure === 'unexpected-initial') ? [uri] : []);
        return f.port.prepare(input);
      }, release: input => f.port.release(input),
    };
    const actor = actorWith(journal, sessionId, { async *stream() { assert.fail('waiting recovery must not issue a Provider request'); } }, emptyKernel(), port, 'recover-skills');
    t.after(() => actor.dispose());
    await actor.recover();
    const lookups = f.requests.filter(r => r.restoreEnvironment);
    assert.deepEqual(lookups.map(r => r.pluginSelections.map(s => s.uri)), failure === 'unexpected-initial' ? [[]] : [[], [uri]]);
    const after = await readEvents(journal, sessionId);
    if (!failure) {
      assert.equal((await actor.snapshot()).run.status, 'waiting');
      assert.deepEqual(after, before); assert.deepEqual(f.releases, []);
    } else {
      assert.equal(after.at(-1).type, 'run.settled');
      assert.equal(after.at(-1).payload.error.code, failure === 'wrong-active-instance' ? 'run_runtime_recovery_identity_mismatch' : 'selected_plugin_snapshot_identity_mismatch');
      assert.deepEqual(f.releases.map(r => r.kernelCatalogSnapshotRef), [first.kernelCatalogSnapshotRef], 'only run finalization owns the release');
    }
  }
});

test('HTTP preparation preserves stable token calibration keys for the provider and reviewer', async t => {
  const fixture = await httpPreparation(t);
  fixture.useProvider({ inputTokenCalibrationKey: 'input-token-calibration:main' });
  fixture.useReviewer({ inputTokenCalibrationKey: 'input-token-calibration:reviewer' });
  const prepared = await fixture.port.prepare(fixture.request);
  const restored = JSON.parse(JSON.stringify(prepared.runtimeSnapshot));
  assert.equal(restored.provider.inputTokenCalibrationKey, 'input-token-calibration:main');
  assert.equal(restored.approvalReviewer.inputTokenCalibrationKey, 'input-token-calibration:reviewer');
  assertRuntimeContract('ProviderRuntimeSnapshot', restored.provider);
  assertRuntimeContract('ProviderRuntimeSnapshot', restored.approvalReviewer);
  assert.equal(fixture.releases.length, 0);
  for (const invalid of [null, '', 'invalid key', 'invalid\n', 42]) {
    assert.throws(() => assertRuntimeContract('ProviderRuntimeSnapshot', { ...restored.provider, inputTokenCalibrationKey: invalid }));
    fixture.useProvider({ inputTokenCalibrationKey: invalid });
    await assert.rejects(fixture.port.prepare(fixture.request), /provider_runtime_snapshot_invalid/);
  }
  assert.equal(fixture.releases.length, 5, 'invalid calibration metadata must release the prepared runtime');
});

test('real HTTP run preparation accepts omitted, empty and PDF file capabilities for provider and reviewer', async t => {
  const fixture = await httpPreparation(t);
  for (const capability of [undefined, [], ['application/pdf']]) {
    const extra = capability === undefined ? {} : { fileInputMediaTypes: capability };
    fixture.useProvider(extra); fixture.useReviewer(extra);
    const prepared = await fixture.port.prepare(fixture.request);
    assert.deepEqual(prepared.runtimeSnapshot.provider.fileInputMediaTypes, capability ?? []);
    assert.deepEqual(prepared.runtimeSnapshot.approvalReviewer.fileInputMediaTypes, capability ?? []);
    assertRuntimeContract('ProviderRuntimeSnapshot', prepared.runtimeSnapshot.provider);
    assertRuntimeContract('ProviderRuntimeSnapshot', prepared.runtimeSnapshot.approvalReviewer);
  }
  assert.equal(fixture.requests.length, 3);
  assert.equal(fixture.releases.length, 0, 'valid capabilities must not trigger preparation rollback');
});

test('prepared product instructions survive snapshot replay and share the agent/summary prefix independently of tools', async t => {
  const registry = new SessionConfigurationRegistry(undefined, achbitProductComponents);
  for (const ids of [[], ['achbit.rich-replies']]) {
    const parts = registry.productInstructions({ productComponents: ids, tools: { plugins: false } });
    const fixture = await httpPreparation(t, parts);
    const { runtimeSnapshot } = await fixture.port.prepare(fixture.request);
    const runtime = JSON.parse(JSON.stringify(runtimeSnapshot));
    assert.deepEqual(runtime.instructions.filter(item => item.id === 'achbit.rich-replies'), parts);
    const input = { ...fixture.request, workspaceBindings: [], runtime, events: [], providerRequestId: 'request:main', responseConstraint: 'normal' };
    const main = await buildAgentProviderRequest(input);
    const summary = prepareContextCompaction({ ...input, requestEvent: {
      payload: { coveredThroughSequence: 0, providerRequestId: 'request:summary' },
    } });
    const rich = main.request.messages.some(message => message.content.includes('Mermaid'));
    assert.equal(rich, ids.length > 0);
    assert.deepEqual(main.request.tools, []);
    assert.deepEqual(summary.request.tools, main.request.tools);
    assert.deepEqual(summary.request.messages.slice(0, -1), main.request.messages);
    assert.equal(summary.request.responseConstraint, 'answerOnly');
  }
});

test('HTTP file capability errors remain strict and release the acquired run runtime', async t => {
  const fixture = await httpPreparation(t);
  for (const invalid of [
    { fileInputMediaTypes: 'application/pdf' },
    { fileInputMediaTypes: null },
    { fileInputMediaTypes: ['application/pdf', 'application/pdf'] },
    { fileInputMediaTypes: ['text/plain'] },
    { apiSurface: 'responses', fileInputMediaTypes: ['application/pdf'] },
  ]) {
    fixture.useProvider(invalid);
    await assert.rejects(fixture.port.prepare(fixture.request), /provider_runtime_snapshot_invalid/);
  }
  fixture.useProvider({ fileInputMediaTypes: [] });
  fixture.useReviewer({ fileInputMediaTypes: ['text/plain'] });
  await assert.rejects(fixture.port.prepare(fixture.request), /provider_runtime_snapshot_invalid/);
  assert.equal(fixture.releases.length, 6);
  assert.ok(fixture.releases.every(release => release.sessionId === fixture.request.sessionId
    && release.runId === fixture.request.runId && release.kernelCatalogSnapshotRef));
});

test('project instruction sources enter system context and replay unchanged until a new prepared snapshot changes them', async t => {
  const fixture = await httpPreparation(t);
  const initial = (await fixture.port.prepare(fixture.request)).runtimeSnapshot;
  for (const sources of [[], [{ path: '/project/AGENTS.md', text: '  \n' }]]) {
    fixture.useProjectInstructions(sources);
    assert.deepEqual((await fixture.port.prepare(fixture.request)).runtimeSnapshot.instructions, initial.instructions);
  }
  const sources = [{ path: '/project/AGENTS.md', text: 'Keep the project contract.\n' },
    { path: '/project/nested/AGENTS.md', text: 'Use the nested conventions.\n' }];
  fixture.useProjectInstructions(sources);
  const request = { ...fixture.request, workspaceBindingIds: ['workspace:project'] };
  const first = (await fixture.port.prepare(request)).runtimeSnapshot;
  const replay = JSON.parse(JSON.stringify(first));
  const contribution = replay.instructions.filter(item => item.id === 'achbit.project-instructions');
  assert.equal(contribution.length, 1);
  for (const source of sources) {
    assert.ok(contribution[0].text.includes(source.path));
    assert.ok(contribution[0].text.includes(source.text));
  }
  assert.deepEqual(fixture.requests.at(-1).workspaceBindingIds, request.workspaceBindingIds);
  assert.deepEqual(first.environment, initial.environment);
  assert.deepEqual(first.tools, initial.tools);
  const compose = async (runtime, runId = request.runId) => (await buildAgentProviderRequest({ ...request, runId, workspaceBindings: [],
    runtime, events: [], providerRequestId: 'request:project-instructions', responseConstraint: 'normal' })).request;
  const firstRequest = await compose(replay);
  assert.equal(firstRequest.messages.filter(message => message.role === 'system'
    && message.content.includes('Keep the project contract.')).length, 1);
  assert.ok(firstRequest.messages.filter(message => message.role !== 'system')
    .every(message => !message.content.includes('Keep the project contract.')));
  const same = (await fixture.port.prepare({ ...request, runId: 'run:same-project' })).runtimeSnapshot;
  assert.deepEqual((await compose(same, 'run:same-project')).messages, firstRequest.messages, 'new run identities do not alter the system prefix');
  fixture.useProjectInstructions([{ ...sources[0], text: 'The updated project contract.\n' }]);
  const changed = (await fixture.port.prepare({ ...request, runId: 'run:changed-project' })).runtimeSnapshot;
  assert.ok((await compose(changed, 'run:changed-project')).messages.some(message => message.role === 'system'
    && message.content.includes('The updated project contract.')));
  assert.deepEqual((await compose(replay)).messages, firstRequest.messages, 'recorded snapshots do not reread current sources');
  assert.deepEqual(replay.instructions, first.instructions);
});

for (const mode of ['full', 'minimal']) test(`HTTP user system prompt enters only the ${mode} working prefix once`, async t => {
  const fixture = await httpPreparation(t, [], mode === 'minimal');
  const { sessionId, runId } = fixture.request;
  const id = 'achbit.user-system-prompt', marker = 'global-only-marker', text = `  ${marker}\n按原文保留。\n`;
  fixture.useProjectInstructions([{ path: '/project/AGENTS.md', text: 'project-only-marker' }]);
  const prepare = async () => JSON.parse(JSON.stringify((await fixture.port.prepare(fixture.request)).runtimeSnapshot));
  const compose = runtime => buildAgentProviderRequest({ sessionId, runId, runtime, events: [], workspaceBindings: [],
    responseConstraint: 'normal', providerRequestId: 'request:user-prompt' });
  const baseline = await prepare();
  const empty = await compose(baseline);
  fixture.useUserSystemPrompt(text);
  const saved = await prepare();
  assertRuntimeContract('RunRuntimeSnapshot', saved);
  assert.equal(saved.mode, mode);
  assert.deepEqual(saved.instructions.filter(item => item.id === id), [{ id, text }]);
  const { request, receipt } = await compose(saved);
  assertRuntimeContract('ProviderRequest', request);
  const position = receipt.messages.findIndex(item => item.contributionId === `instruction:${id}`);
  assert.ok(position > 0 && position < request.messages.findIndex(message => message.content.includes('project-only-marker')));
  assert.deepEqual(request.messages[position], { role: 'system', content: text });
  assert.deepEqual(request.messages.toSpliced(position, 1), empty.request.messages, 'no other instruction replaced or duplicated');
  assert.deepEqual(request.tools, empty.request.tools);
  assert.deepEqual(saved.permissions, baseline.permissions);
  // Decision packets are built independently; the preference is not a user message or approval.
  const snapshot = { events: [], state: { ...emptySessionState(sessionId), run: { runId, workspaceBindings: [] } } };
  const approval = { runId, callId: 'call:review', preview: { effects: ['process'], logicalTargets: ['.'],
    operation: { toolName: 'bash', arguments: { command: 'pwd' } } } };
  const plan = { runId, planId: 'plan:review', revision: 1, title: 'Review', steps: [], mutationManifest: [], workspaceRequests: [] };
  for (const review of [prepareApprovalReview(snapshot, saved, approval, 'request:execution'), preparePlanReview(snapshot, saved, plan, 'request:plan')]) {
    assert.ok(review.request.messages.every(message => !message.content.includes(marker)));
  }
  for (const value of ['', ' \n']) {
    fixture.useUserSystemPrompt(value);
    assert.deepEqual((await compose(await prepare())).request.messages, empty.request.messages);
  }
  assert.deepEqual((await compose(saved)).request.messages, request.messages, 'replaying a captured snapshot does not consult live settings');
});

test('invalid HTTP user system prompt preserves the decoder error and releases the acquired runtime', async t => {
  const fixture = await httpPreparation(t);
  for (const invalid of [null, 42, '界'.repeat(21_846)]) {
    fixture.useUserSystemPrompt(invalid);
    await assert.rejects(fixture.port.prepare(fixture.request), /run_runtime_user_system_prompt_invalid/);
  }
  assert.equal(fixture.releases.length, 3);
});

test('invalid project instruction wire entries reject and release the prepared runtime', async t => {
  const fixture = await httpPreparation(t);
  const invalid = [null, {}, [{ path: '/project/AGENTS.md' }], [{ path: '', text: 'Instructions' }],
    [{ path: '/project/AGENTS.md', text: 5 }], [{ path: '/project/AGENTS.md', text: 'Instructions', count: 1 }]];
  for (const sources of invalid) {
    fixture.useProjectInstructions(sources);
    await assert.rejects(fixture.port.prepare(fixture.request), /run_runtime_project_instructions_invalid/);
  }
  assert.equal(fixture.releases.length, invalid.length, 'invalid sources use the existing preparation rollback');
});
