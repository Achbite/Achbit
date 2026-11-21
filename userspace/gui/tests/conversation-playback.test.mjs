import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadGuiModules, loadGuiModelStore, installGuiFetch } from './gui-projection-contract.mjs';
import { InMemoryCommandJournal } from '../../session-core/tests/support/memoryJournal.mjs';
import { actorWith, createSession, fakeRunPreparation, emptyKernel, providerEvent, messageCommand, waitForProjection } from '../../session-core/tests/local-agent-fixtures.mjs';

test('returning to a text-only reply starts at the received prefix, both live and committed', async t => {
  const oldSelf = globalThis.self; globalThis.self = {};
  t.after(() => { if (oldSelf === undefined) delete globalThis.self; else globalThis.self = oldSelf; });
  const [{ BufferedMarkdown }] = await loadGuiModules(t, ['/src/components/local-agent/BufferedMarkdown.tsx']);
  for (const streaming of [true, false]) {
    const html = renderToStaticMarkup(createElement(BufferedMarkdown, { text: '已经收到的 **完整文字** 🙂', streamIdentity:'session:a:turn', streaming }));
    assert.match(html, /已经收到的 <strong>完整文字<\/strong> 🙂/);
  }
});

test('a cached active reply is refreshed before reentry, even if the journal revision did not move', async t => {
  const journal = new InMemoryCommandJournal(), id = 'session:reply', second = 'session:other';
  await createSession(journal, id); await createSession(journal, second);
  let releaseProvider;
  const heldProvider = new Promise(r => { releaseProvider = r; });
  const actor = actorWith(journal, id, { async *stream(req) {
    yield providerEvent(req.requestId, 'text.delta', { text: 'Old received reply' }); await heldProvider;
    yield providerEvent(req.requestId, 'completed', {});
  } }, emptyKernel(), fakeRunPreparation().port, 'no-tools');
  t.after(async () => { releaseProvider(); await actor.dispose(); });
  await actor.submit(messageCommand(id, 'command:open', 'A plain reply without tools'));
  const initial = await waitForProjection(actor, p => p.assistantDraft?.blocks.some(b => b.content === 'Old received reply'));
  const otherActor = actorWith(journal, second, { async *stream() {} }, emptyKernel(), fakeRunPreparation().port, 'other');
  t.after(() => otherActor.dispose());
  const other = await otherActor.snapshot(), later = structuredClone(initial);
  later.assistantDraft.blocks[0].content += ' plus everything received while away';
  let reads=0, releaseRead;
  const held = new Promise(r => { releaseRead=r; }); t.after(releaseRead);
  installGuiFetch(t, async url => {
    if (url.pathname.endsWith('/projection')) {
      if (decodeURIComponent(url.pathname.split('/').at(-2)) === second) return Response.json({ok:true,data:other});
      if (++reads>1) await held;
      return Response.json({ok:true,data:reads===1?initial:later});
    }
    if (url.pathname.endsWith('/statuses')) return Response.json({ok:true,data:[]});
    throw new Error(`Unexpected ${url.pathname}`);
  });
  const store=await loadGuiModelStore(t);
  store.setState({catalog:{projects:[],sessions:[{id},{id:second}]},sessionStatuses:{[id]:{revision:initial.revision},[second]:{revision:other.revision}}});
  await store.getState().activateSession(id); assert.equal(store.getState().projection.assistantDraft.blocks[0].content,'Old received reply');
  await store.getState().activateSession(second);
  const opening=store.getState().activateSession(id);
  assert.equal(store.getState().projection,null,'an old live draft is not repainted while waiting');
  releaseRead(); await opening;
  assert.equal(store.getState().projection.assistantDraft.blocks[0].content,later.assistantDraft.blocks[0].content);
});
