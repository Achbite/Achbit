import test from 'node:test';
import assert from 'node:assert/strict';
import { loadGuiModule } from './gui-projection-contract.mjs';

async function fixture(t) {
  const { documentImageLoader } = await loadGuiModule(t, '/src/components/local-agent/documentImages.ts');
  const calls = [], roots = [{ name: 'project', kind: 'directory', resource: { workspaceId: 'work:A', logicalPath: '' } }];
  const host = { resources: {
    async listResourceRoots() { return roots; }, async resolveResourceReference() { return { path: '/work', kind: 'directory' }; },
    async readResourceBlob(...args) { calls.push(args); return new Blob(['image'], {type:'image/png'}); },
  }, async loadImage(...args) { calls.push(args); return { url: 'explicit' }; },
  async readLocalFile() { assert.fail('document text cannot use the native file picker reader'); } };
  const load = target => documentImageLoader(host, 'owner-session', target, 'en-US');
  return { host, calls, load, signal: new AbortController().signal };
}

test('relative images follow the document session, directory, query/fragment and exact resource authority', async t => {
  const {calls,load,signal} = await fixture(t);
  const target = {kind:'workspace',workspaceId:'work:A',logicalPath:'docs/zh/说明.md'};
  const grant = {authorityId:'approved-dir',access:'read',index:2};
  for (const [document, src, reference] of [[target,'figure%20A.png',{workspaceId:'work:A',logicalPath:'docs/zh/figure A.png'}],
    [target,'../assets/fig%23%3F.svg?v=1#symbol',{workspaceId:'work:A',logicalPath:'docs/assets/fig#?.svg'}],
    [{kind:'resource',resource:{fileGrant:grant,logicalPath:'sub/file.md'}},'img.png',{fileGrant:grant,logicalPath:'sub/img.png'}],
    [{kind:'file',path:'/work/docs/file.md'},'a.png',{workspaceId:'work:A',logicalPath:'docs/a.png'}]]) {
    const image=await load(document)('other-current-session',src,signal);
    assert.deepEqual(calls.at(-1),['owner-session',reference,'image',signal]);
    if (src.includes('#symbol')) assert.ok(image.url.endsWith('#symbol'));
    assert.ok(image.url.startsWith('blob:')); image.release();
  }
});

test('absence of a directory grant does not cause raw file reads; explicit image sources keep their loader', async t => {
  const {calls,load,signal} = await fixture(t);
  const root={kind:'workspace',workspaceId:'work:A',logicalPath:'file.md'};
  for(const [document,src] of [[root,'../outside.png'],[root,'%2E%2E/outside.png'],[root,'/outside.png'],[root,'file:///outside.png'],
    [root,'C:/outside.png'],[root,'//share/a.png'],[root,'%5C%5Cshare/a.png'],[root,'bad%xx.png'],[root,'#only'],
    [{kind:'artifact',artifact:{label:'docs/file.md'}},'fig.png'],[{kind:'file',path:'/unbound/file.md'},'fig.png'],
    [{kind:'resource',resource:{change:{recordId:'one',index:0},logicalPath:''}},'fig.png'],
    [{kind:'resource',resource:{fileGrant:{authorityId:'one',access:'read',index:0},logicalPath:''}},'fig.png']]) {
    await assert.rejects(load(document)(null,src,signal),/directory/);
  }
  assert.deepEqual(calls,[]);
  for (const url of ['https://example.test/a.png','workspace://work%3AA/fig.png','artifact://artifact:one']) {
    assert.deepEqual(await load(root)(null,url,signal),{url:'explicit'});
    assert.deepEqual(calls.at(-1),['owner-session',url,signal]);
  }
});

test('a cancelled or denied read does not become a successful image', async t => {
  const {host,load,signal}=await fixture(t);
  const get=load({kind:'workspace',workspaceId:'work:A',logicalPath:'docs/a.md'});
  host.resources.readResourceBlob=async()=>{throw Error('grant expired');};
  await assert.rejects(get(null,'a.png',signal),/grant expired/);
  const aborted=new AbortController();
  host.resources.readResourceBlob=async()=>{aborted.abort();return new Blob([]);};
  await assert.rejects(get(null,'a.png',aborted.signal),{name:'AbortError'});
});
