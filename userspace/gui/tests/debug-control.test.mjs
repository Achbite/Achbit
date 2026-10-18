import test from 'node:test';
import assert from 'node:assert/strict';
import { loadGuiModule, loadGuiModules } from './gui-projection-contract.mjs';

test('direct component action uses mounted owner, awaits it, and records its actual result', async t => {
  const { createDebugUiRegistry } = await loadGuiModule(t, '/src/debug/registry.ts');
  const registry = createDebugUiRegistry();
  let release;
  const owner = new Promise(resolve => { release = resolve; });
  let submitted = 0;
  const remove = registry.register('composer', { slot: 'composer.actions', pluginId: 'builtin:regions', read: () => ({ draft: 'hello' }), actions: () => ({ submitDraft: async () => { submitted++; return await owner; } }) });
  let finished = false;
  const result = registry.call('composer', 'submitDraft', []).then(value => { finished = true; return value; });
  await Promise.resolve();
  assert.equal(finished, false);
  assert.equal(submitted, 1);
  release({ accepted: true });
  assert.deepEqual(await result, { result: { accepted: true }, completion: 'handler-resolved', businessCompletion: 'not-asserted' });
  const rows = registry.measurements();
  assert.equal(rows.records[0].event, 'submitDraft');
  assert.ok(rows.records[0].durationMs >= 0);
  assert.equal(registry.measurements().records.length, 0);
  remove();
  await assert.rejects(registry.call('composer', 'submitDraft', []), /not_mounted/);
});

test('component schema rejects arbitrary methods and bad inputs; original owner failures remain failures', async t => {
  const { createDebugUiRegistry } = await loadGuiModule(t, '/src/debug/registry.ts');
  const registry = createDebugUiRegistry();
  let calls = 0;
  registry.register('editor', { slot: 'composer.layout', pluginId: null, read: () => null, actions: () => ({
    updateDraft: value => { calls++; if (value === 'invalid') throw new Error('owner refused input'); },
    exec: () => { calls++; },
  }) });
  await assert.rejects(registry.call('editor', 'exec', []), /invalid_arguments/);
  await assert.rejects(registry.call('editor', 'updateDraft', [123]), /invalid_arguments/);
  assert.equal(calls, 0);
  await assert.rejects(registry.call('editor', 'updateDraft', ['invalid']), /owner refused input/);
  assert.equal(registry.measurements().records[0].outcome, 'failed');
  const result = await registry.call('editor', 'updateDraft', ['text']);
  assert.equal(result.completion, 'handler-returned');
  assert.equal(result.businessCompletion, 'not-asserted');
});

test('ordinary run timing displays recorded response duration and omits unrecorded duration', async t => {
  const { RunTiming } = await loadGuiModule(t, '/src/components/local-agent/RunTiming.tsx');
  const text = value => Array.isArray(value) ? value.map(text).join(' ') : value && typeof value === 'object' ? text(value.props?.children) : String(value ?? '');
  assert.equal(RunTiming({ timing: undefined, language: 'en-US' }), null);
  assert.equal(RunTiming({ timing: { firstResponseAt: '2' }, language: 'en-US' }), null);
  const timing = { runId: 'run', clockDomain: 'session', acceptedAt: '1', startedAt: '1', firstResponseAt: '2', firstResponseKind: 'tool', firstResponseMs: 125, settledAt: '3', totalMs: 2500, responseElapsedMs: 2375, coverage: 'complete' };
  const rendered = text(RunTiming({ timing, language: 'en-US' }));
  assert.match(rendered, /Time 2.4s/);
  assert.doesNotMatch(rendered, /2500|Total time|First text/);
});

test('run duration accompanies the existing process toggle without adding a footer or changing message anchors', async t => {
  const previousSelf = globalThis.self;
  globalThis.self = {};
  t.after(() => { if (previousSelf === undefined) delete globalThis.self; else globalThis.self = previousSelf; });
  const [{ ConversationTranscript }, { ConversationLayoutCache }] = await loadGuiModules(t, [
    '/src/components/local-agent/ConversationTranscript.tsx', '/src/components/local-agent/conversationVirtualizer.ts',
  ]);
  const { createElement } = await import('react');
  const { renderToStaticMarkup } = await import('react-dom/server');
  const messages = ['user', 'assistant', 'assistant'].map((role, index) => ({ type: 'message', sequence: index === 0 ? 0 : index + 1, streamId: `stream:${index}`,
    value: { messageId: `message:${index}`, runId: 'run:timing', role, content: `Content ${index}`, filesystemReferences: [] } }));
  const narrative = { type: 'narrative', sequence: 1, streamId: 'stream:process', value: { narrativeId: 'narrative:process', runId: 'run:timing', content: 'Working', filesystemReferences: [] } };
  const items = [messages[0], narrative, ...messages.slice(1)];
  const html = renderToStaticMarkup(createElement(ConversationTranscript, {
    layoutCache: new ConversationLayoutCache(), language: 'zh-CN', loading: false, displaySettledRunIds: new Set(['run:timing']), onDisplayed() {},
    projection: { sessionId: 'session:timing', run: null, plans: [], activities: [], fileChangeRounds: [], artifacts: [],
      runTimings: [{ runId: 'run:timing', clockDomain: 'session', acceptedAt: '1', firstResponseAt: '2', firstResponseKind: 'text', responseElapsedMs: 689000, coverage: 'complete' }] },
    hasConversationContent: true, draftItems: [], conversationItems: items,
    presentation: { content: id => id },
    viewport: { bodyRef: { current: null }, transcriptRef: { current: null }, messageEndRef: { current: null }, followingLatest: true, setLatestFollowMode() {}, preserveReadingPosition() {}, scrollToAnchor() {} },
    openWorkspaceResource() {}, setUiActionError() {},
  }));
  assert.equal((html.match(/class="conversation-run-timing"/g) ?? []).length, 1);
  assert.match(html, /用时 11m 29s/);
  assert.match(html, /class="conversation-process-toggle"/);
  assert.match(html, /<\/button><span class="conversation-run-timing">用时 11m 29s<\/span>/);
  assert.ok(html.indexOf('conversation-run-timing') < html.indexOf('local-agent__message--assistant'));
  assert.deepEqual([...html.matchAll(/data-conversation-anchor="([^"]+)"/g)].map(match => match[1]), ['stream:0', 'run:timing:disclosure', 'stream:process', 'stream:1', 'stream:2']);
  assert.doesNotMatch(html, /:file-changes/);
  assert.doesNotMatch(html, /<details/);
});
