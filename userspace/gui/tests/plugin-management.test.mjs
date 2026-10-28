import assert from 'node:assert/strict';
import test from 'node:test';
import { installGuiFetch, loadGuiModule } from './gui-projection-contract.mjs';
import { waitUntil } from '../../session-core/tests/local-agent-fixtures.mjs';

test('external settings changes serialize their reads and release the stream on disconnect', async t => {
  const { watchUserSettings } = await loadGuiModule(t, '/src/services/pluginManagement.ts');
  let stream, resolveFirst, reads = 0;
  const gate = new Promise(resolve => { resolveFirst = resolve; });
  installGuiFetch(t, (url, init) => {
    assert.equal(url.pathname, '/api/user-settings/events');
    assert.equal(url.searchParams.get('clientId'), 'window-one');
    const body = new ReadableStream({ start(value) { stream = value; } });
    init.signal.addEventListener('abort', () => stream.error(new DOMException('Aborted','AbortError')), {once:true});
    return new Response(body, { headers:{'Content-Type':'text/event-stream'} });
  });
  const controller = new AbortController(); t.after(() => { resolveFirst(); controller.abort(); });
  const stopped = watchUserSettings('window-one',controller.signal,async () => { reads++; if (reads === 1) await gate; }).catch(error => error);
  await waitUntil(() => stream);
  stream.enqueue(new TextEncoder().encode('event: ready\ndata: {}\n\nevent: change\ndata: {}\n\n'));
  await waitUntil(() => reads === 1); resolveFirst();
  await waitUntil(() => reads === 2);
  controller.abort(); assert.equal((await stopped).name,'AbortError');
});

test('saved plugin registration does not hide a real startup failure', async t => {
  const { manageLocalPlugin, reportUiPlugins } = await loadGuiModule(t, '/src/services/pluginManagement.ts');
  const requests = [];
  installGuiFetch(t,(url,init) => {
    requests.push({path:url.pathname, body:JSON.parse(init.body)});
    return Response.json(url.pathname.endsWith('/manage')
      ? {ok:true,data:{application:{status:'failed',error:'service initialization exited: 7'}}}
      : {ok:true,data:{accepted:true}});
  });
  await assert.rejects(manageLocalPlugin('enable','example'),/service initialization exited: 7/);
  await reportUiPlugins('window-one',[
    {path:'builtin:regions',status:'active',error:null},
    {path:'/installed/ui',status:'error',error:'apply failed'},
  ],new AbortController().signal);
  assert.deepEqual(requests[1].body,{clientId:'window-one',plugins:[{path:'/installed/ui',status:'error',error:'apply failed'}]});
});
