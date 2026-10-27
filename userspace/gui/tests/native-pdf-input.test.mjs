import test from 'node:test';
import assert from 'node:assert/strict';
import { Children, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadGuiModule, loadGuiModules, loadGuiModelStore, installGuiFetch, findReactElement } from './gui-projection-contract.mjs';
import { InMemoryCommandJournal } from '../../session-core/tests/support/memoryJournal.mjs';
import { workspaceBinding, actorWith, createSession, fakeRunPreparation, emptyKernel, providerEvent, waitForProjection } from '../../session-core/tests/local-agent-fixtures.mjs';

const flush = () => new Promise(resolve => setImmediate(resolve));
const nativeProfile = { id: 'profile:pdf', connectionId: 'connection:pdf', name: 'PDF model', model: 'fixture-model',
  kind: 'openaiCompatible', providerFlavor: 'openai', enabled: true, contextWindowTokens: 4096, maxOutputTokens: 512,
  fileInputMediaTypes: ['application/pdf'] };
const reference = { referenceId: 'reference:pdf', workspaceId: workspaceBinding.workspaceId, logicalPath: 'report.pdf',
  displayName: 'report.pdf', kind: 'file', mediaType: 'application/pdf', byteLength: 128 };
const attachment = [{ path: '/documents/report.pdf', kind: 'file' }];

function capture(Component, props) {
  let tree;
  function Probe() { tree = Component(props); return tree; }
  const html = renderToStaticMarkup(createElement(Probe));
  return { tree, html };
}

function labeledControl(tree, label) {
  const field = findReactElement(tree, node => node.type === 'label' && Children.toArray(node.props.children).includes(label));
  return findReactElement(field, node => typeof node.props.onChange === 'function');
}

test('native PDF capability saves independently and is unavailable for unsupported protocols', async t => {
  const [{ default: ModelEditor }, { useSettingsStore }] = await loadGuiModules(t, [
    '/src/components/settings-center/model-services/ModelEditor.tsx', '/src/state/settingsStore.ts',
  ]);
  const initial = useSettingsStore.getInitialState(), previous = initial.effectiveSettings;
  initial.effectiveSettings = { ...previous, 'workbench.language': 'en-US' };
  t.after(() => { initial.effectiveSettings = previous; });
  let saved = { ...nativeProfile, fileInputMediaTypes: [] };
  const writes = [];
  installGuiFetch(t, (url, init) => {
    assert.equal(url.pathname, '/api/llm/profiles');
    assert.equal(init.method, 'PATCH');
    saved = JSON.parse(init.body).profile; writes.push(saved);
    return Response.json({ ok: true, data: { profiles: [saved], defaultProfileId: saved.id } });
  });
  const adapter = { id: 'custom', protocols: ['openaiCompatible', 'responses', 'anthropic', 'ollama'], models: [] };
  const render = profile => capture(ModelEditor, { profile, adapter, defaultId: profile.id, async onSaved() {} });
  const editor = render(saved);
  assert.equal(labeledControl(editor.tree, 'PDF input').props.value, 'false');
  assert.equal(labeledControl(editor.tree, 'PDF input').props.disabled, false);
  labeledControl(editor.tree, 'PDF input').props.onChange({ target: { value: 'true' } });
  await flush();
  assert.deepEqual(saved.fileInputMediaTypes, ['application/pdf']);
  assert.equal(saved.model, nativeProfile.model);
  assert.equal(writes.length, 1);
  labeledControl(render(saved).tree, 'API protocol').props.onChange({ target: { value: 'responses' } });
  await flush();
  assert.equal(saved.kind, 'responses');
  assert.deepEqual(saved.fileInputMediaTypes, []);
  for (const kind of ['responses', 'anthropic', 'ollama']) {
    const unsupported = labeledControl(render({ ...saved, kind }).tree, 'PDF input');
    assert.equal(unsupported.props.disabled, true);
    assert.match(unsupported.props.title, /unavailable for this protocol/);
  }
});

test('queued PDF admission uses the running Provider capability while new turns use the selected profile', async t => {
  const { supportsNativeFileInput } = await loadGuiModule(t, '/src/services/modelFileInput.ts');
  const withoutNative = { ...nativeProfile, fileInputMediaTypes: [] };
  for (const status of ['running', 'waiting']) {
    assert.equal(supportsNativeFileInput('application/pdf', withoutNative, { status, fileInputMediaTypes: ['application/pdf'] }), true);
    assert.equal(supportsNativeFileInput('application/pdf', nativeProfile, { status, fileInputMediaTypes: [] }), false);
    assert.equal(supportsNativeFileInput('application/pdf', nativeProfile, { status }), false, 'an absent frozen capability is not inferred from edited settings');
  }
  assert.equal(supportsNativeFileInput('application/pdf', nativeProfile, { status: 'completed', fileInputMediaTypes: [] }), true);
  assert.equal(supportsNativeFileInput('application/pdf', withoutNative, { status: 'completed', fileInputMediaTypes: ['application/pdf'] }), false);
  assert.equal(supportsNativeFileInput('application/pdf', { ...nativeProfile, kind: 'responses' }), false);
  assert.equal(supportsNativeFileInput('application/pdf', { ...nativeProfile, fileInputMediaTypes: undefined }), false);
});

for (const failed of [false, true]) test(`GUI PDF input needs no PDF tool and preserves the native Provider outcome (${failed ? 'failed' : 'completed'})`, async t => {
  const journal = new InMemoryCommandJournal(), sessionId = `session:native-pdf-${failed}`;
  await createSession(journal, sessionId, [workspaceBinding]);
  const preparation = fakeRunPreparation();
  const port = { ...preparation.port, async prepare(request) {
    const result = await preparation.port.prepare(request);
    result.runtimeSnapshot.provider.fileInputMediaTypes = ['application/pdf'];
    return result;
  } };
  const requests = [], commands = [];
  const actor = actorWith(journal, sessionId, { async *stream(request) {
    requests.push(request);
    if (failed) {
      yield providerEvent(request.requestId, 'failed', { code: 'native_pdf_upload_failed', message: 'Original PDF upload failure' });
    } else {
      yield providerEvent(request.requestId, 'text.delta', { text: 'PDF received.' });
      yield providerEvent(request.requestId, 'completed', {});
    }
  } }, emptyKernel(), port, `native-pdf-${failed}`);
  t.after(() => actor.dispose());
  const plugins = { revision: 'plugins:no-pdf', plugins: [] };
  installGuiFetch(t, async (url, init) => {
    if (url.pathname.endsWith('/filesystem-references/resolve')) return Response.json({ ok: true, data: [reference] });
    if (url.pathname.endsWith('/commands')) {
      const command = JSON.parse(init.body); commands.push(command);
      return Response.json({ ok: true, data: await actor.submit(command) });
    }
    if (url.pathname.endsWith('/projection')) return Response.json({ ok: true, data: await actor.snapshot() });
    if (url.pathname.endsWith('/catalog')) return Response.json({ ok: true, data: { projects: [], sessions: [] } });
    if (url.pathname.endsWith('/plugins')) return Response.json({ ok: true, data: plugins });
    throw new Error(`unexpected_gui_request:${url.pathname}`);
  });
  const store = await loadGuiModelStore(t);
  store.setState({ sessionId, projection: await actor.snapshot(), selectedProfileId: nativeProfile.id,
    profiles: [nativeProfile], pluginCatalog: plugins });
  await store.getState().sendMessage('Read the attached PDF.', attachment);
  const settled = await waitForProjection(actor, value => value.run?.status === (failed ? 'failed' : 'completed'));
  assert.equal(commands.length, 1);
  assert.equal(commands[0].pluginSelections, undefined);
  assert.deepEqual(commands[0].filesystemReferences, [reference]);
  assert.deepEqual(settled.messages[0].filesystemReferences, [reference]);
  assert.equal(requests.length, 1, 'failure does not switch to a PDF reader or retry');
  assert.deepEqual(requests[0].messages.flatMap(message => message.files ?? []), [{
    workspaceId: reference.workspaceId, logicalPath: reference.logicalPath, mediaType: reference.mediaType, displayName: reference.displayName,
  }]);
  if (failed) assert.match(settled.terminalError.message, /Original PDF upload failure/);
  store.setState({ projection: settled, profiles: [{ ...nativeProfile, fileInputMediaTypes: [] }] });
  await assert.rejects(store.getState().sendMessage('Read it with an unsupported profile.', attachment), /plugin_selection_unavailable:application\/pdf/);
  assert.equal(commands.length, 1, 'profiles without native support retain the existing plugin gate');
});
