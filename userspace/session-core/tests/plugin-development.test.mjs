import assert from 'node:assert/strict';
import test from 'node:test';
import { createProviderToolAliases } from '../dist/local-agent/providerToolCodec.js';
import { sessionControlToolDefinitions } from '../dist/index.js';
import { InMemoryCommandJournal } from './support/memoryJournal.mjs';
import { actorWith, fakeRunPreparation, emptyKernel, completedExecutionReply, providerEvent,
  createSession, messageCommand, readEvents, waitForProjection, workspaceBinding } from './local-agent-fixtures.mjs';

test('adding a colliding plugin preserves existing wire names and reserves removed names', () => {
  const first = createProviderToolAliases(['foo.bar', 'plugin.activate']);
  const next = createProviderToolAliases(['foo.bar', 'foo_bar', 'plugin.activate'], first);
  assert.deepEqual(next.slice(0, first.length), first);
  assert.notEqual(next.find(alias => alias.canonicalName === 'foo_bar').wireName, 'foo_bar');
  assert.deepEqual(createProviderToolAliases(['foo_bar', 'plugin.activate'], next), next);
});

test('one run discovers an installation, activates, updates and withdraws it while retaining the request prefix', async t => {
  const journal = new InMemoryCommandJournal(), sessionId = 'session:plugin-development';
  await createSession(journal, sessionId, [workspaceBinding]);
  const uri = 'plugin://text-helper@local';
  const core = [
    { toolBindingRef:'binding:shell', name:'bash', description:'Run a command.', inputSchema:{ type:'object', properties:{command:{type:'string'}},required:['command'],additionalProperties:false }, possibleEffects:['process'], availability:'callable', origin:'coreBuiltin' },
    { toolBindingRef:'binding:search', name:'plugin.search', description:'Discover plugins.', inputSchema:{type:'object',properties:{}}, possibleEffects:['localRead'], availability:'callable', origin:'coreBuiltin' },
  ];
  const guidance = [{ contributionRef:'guide:shell', preparedToolBindingRef:'binding:shell', canonicalToolName:'bash', origin:'coreBuiltin', promptSnippet:'Run commands.', usageGuidelines:[] }];
  const preparation = fakeRunPreparation({ tools:core, toolPromptContributions:guidance, contextWindowTokens:32768 });
  let revision = 0, enabled = false;
  const port = { ...preparation.port, async prepare(request) {
    const prepared = await preparation.port.prepare({ ...request,
      pluginSelections: enabled ? request.pluginSelections : [] });
    const runtime = prepared.runtimeSnapshot;
    runtime.kernelCatalogSnapshotRef = `catalog:${revision}:${runtime.selectedPlugins.plugins.length}`;
    if (runtime.selectedPlugins.plugins.some(plugin => plugin.uri === uri)) {
      const name = 'text.count', binding = `binding:text:${revision}`;
      runtime.tools.push({ toolBindingRef:binding, name, description:`Count using revision ${revision}.`,
        inputSchema:{ type:'object',properties:{} }, possibleEffects:['localRead'], availability:'callable', origin:'extension', pluginUri:uri });
      runtime.toolPromptContributions.push({ contributionRef:'guide:text', preparedToolBindingRef:binding,
        canonicalToolName:name, origin:'extension', pluginUri:uri, promptSnippet:`Text guide ${revision}.`, usageGuidelines:[] });
    }
    runtime.providerToolAliases = createProviderToolAliases([...runtime.tools.map(tool => tool.name),
      ...sessionControlToolDefinitions().map(tool => tool.name)], request.previousProviderToolAliases);
    return prepared;
  } };
  const requests = [];
  const steps = [ ['bash',{command:'install'}], ['plugin_search',{}], ['plugin_activate',{pluginUris:[uri]}],
    ['text_count',{}], ['bash',{command:'update'}], ['text_count',{}], ['bash',{command:'disable'}] ];
  const provider = { async *stream(request) {
    const index = requests.length;
    assert.ok(index <= steps.length, 'bounded scenario');
    if (requests.length) {
      assert.deepEqual(request.messages.slice(0, requests.at(-1).messages.length), requests.at(-1).messages,
        'new plugin facts append after the already-sent messages');
      assert.deepEqual(request.messages.filter(message => message.role === 'system'), requests[0].messages.filter(message => message.role === 'system'));
      assert.equal(request.providerRuntimeRef, requests[0].providerRuntimeRef);
    }
    requests.push(structuredClone(request));
    if (index === 3) {
      assert.deepEqual(request.tools.slice(0, requests[0].tools.length), requests[0].tools);
      assert.match(request.messages.at(-1).content, /Text guide 1/);
    }
    if (index === 5) assert.match(request.tools.find(tool => tool.name === 'text_count').description, /revision 2/);
    if (index === 7) {
      assert.ok(!request.tools.some(tool => tool.name === 'text_count'));
      assert.match(request.messages.at(-1).content, /"removed":\["text_count"\]/);
      yield providerEvent(request.requestId,'text.delta',{text:'Installed, used, updated and disabled.'});
    } else yield providerEvent(request.requestId,'tool.call',{ callId:`native:${index}`, name:steps[index][0], input:steps[index][0] === 'bash' ? {workspace:'primary',...steps[index][1]} : steps[index][1] });
    yield providerEvent(request.requestId,'completed',{});
  } };
  const kernel = emptyKernel({ async execute(request) {
    let result;
    if (request.toolName === 'bash') {
      revision++; enabled = request.input.command !== 'disable'; result = { changed:true };
    } else if (request.toolName === 'plugin.search') {
      assert.equal(revision,1); result = { plugins:[{uri}] };
    } else { assert.equal(request.toolName,'text.count'); result = { revision }; }
    const reply = completedExecutionReply(request,{ content:JSON.stringify(result) });
    if (request.toolName === 'text.count') {
      reply.record.preparedEffect.origin = 'extension';
      reply.record.preparedEffect.pluginInstanceRef = `instance:${uri}`;
    }
    return reply;
  } });
  const actor = actorWith(journal,sessionId,provider,kernel,port,'plugin-development');
  t.after(() => actor.dispose());
  await actor.submit(messageCommand(sessionId,'command:start','Develop and use a plugin in this task.'));
  const state = await waitForProjection(actor,state => ['completed','failed'].includes(state.run?.status));
  const events = await readEvents(journal,sessionId);
  assert.equal(state.run.status,'completed',JSON.stringify(events.filter(event => event.type === 'run.finishing')));
  assert.equal(requests.length,8);
  assert.equal(events.filter(event => event.type === 'run.started').length,1);
  const changes = events.filter(event => event.type === 'run.tools.prepared');
  assert.equal(changes.length,4, 'only installation, selection, update and disable replace views');
  assert.equal(preparation.released.length,1);
});
