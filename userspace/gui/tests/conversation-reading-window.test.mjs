import test from 'node:test';
import assert from 'node:assert/strict';
import React, { createElement as h } from 'react';
import { renderToStaticMarkup as html } from 'react-dom/server';
import { loadGuiModules } from './gui-projection-contract.mjs';
const dir = '/src/components/local-agent/';
const rounds = Array.from({length:512}, (_, i) => ({key:`r${i}`,runId:`r${i}`,rows:[{key:`q${i}`},{key:`a${i}`}] }));
const load = async (t, ...names) => loadGuiModules(t, names.map(name => dir + name));

test('the long transcript first mounts its own complete tail or saved middle rows; the indexed rail is bounded', async t => {
  const [{ConversationReadingWindow}, {ConversationLayoutCache, ConversationVirtualizer}, {ConversationNavigation}] = await load(t,'ConversationReadingWindow.tsx','conversationVirtualizer.ts','ConversationNavigation.tsx');
  const cache = new ConversationLayoutCache(), virtualizer = new ConversationVirtualizer(cache.session('A'), () => {});
  for (const [key, wanted, absent] of [[undefined,511,255], ['a255',255,511]]) {
    const viewport = {bodyRef:{current:null},transcriptRef:{current:null},openingAnchor:key,mountReadingPage:{current:null}};
    const mounted = html(h(ConversationReadingWindow,{rounds,viewport,virtualizer,dimensions:cache.pages(rounds),environment:'renderer:1',
      renderRound:(r,eager)=>h('p',{key:r.key},...r.rows.map(x=>h('span',{key:x.key,'data-key':x.key},eager.has(x.key)?`complete ${x.key}`:'not rendered')))}));
    assert.ok((mounted.match(/data-key=/g)??[]).length <= 36);
    assert.match(mounted,new RegExp(`complete a${wanted}<`));assert.doesNotMatch(mounted,new RegExp(`data-key="a${absent}"`));
    assert.match(mounted,/data-reading-gap/);
  }
  const entries=rounds.map((r,i)=>({key:r.rows[0].key,rowIndex:2*i,label:`Question ${i+1}`}));
  const rail=html(h(ConversationNavigation,{sessionId:'A', entries,viewport:{bodyRef:{current:null},followingLatest:true},language:'en-US',onNavigate(){}}));
  assert.equal((rail.match(/<button/g)??[]).length,40);assert.match(rail,/Go to message 512: Question 512/);
});

test('range lookup accounts for measured pages; a changed renderer/width drops estimates, not document facts',async t=>{
  const [{readingPages,ReadingGeometry},{PageMeasurements}]=await load(t,'conversationReadingPages.ts','conversationVirtualizer.ts');
  const idx=readingPages(rounds),dim=new PageMeasurements();assert.equal(readingPages(rounds),idx);assert.equal(idx.byAnchor.get('r301:disclosure'),idx.byAnchor.get('a301'));
  const n=idx.byAnchor.get('q300'),geom=new ReadingGeometry(idx,dim.heights);const start=geom.offsets[n];
  assert.equal(geom.pageAt(start+1),n);assert.equal(geom.measure(n,300),true);assert.equal(geom.pageAt(start+301),n+1);
  assert.equal(dim.validate('A:760:font1:renderer1'),false);dim.record(idx.pages[n].key,300);assert.equal(dim.validate('A:760:font1:renderer1'),true);
  assert.equal(dim.validate('A:360:font2:renderer2'),false);assert.equal(dim.heights.size,0);geom.reset(dim.heights);assert.equal(geom.pageAt(start+301),n);
  assert.equal(geom.range(start,500).first<=n,true);assert.equal(geom.measure(n,NaN),false);
});

test('switching mounted pages to gaps preserves the measured scroll extent; shrinking or resetting releases it', async t => {
  const [{ readingPages, ReadingGeometry }] = await load(t, 'conversationReadingPages.ts');
  const index = readingPages(rounds), geometry = new ReadingGeometry(index, new Map());
  const n = index.byAnchor.get('q256');
  const initial = geometry.extent, estimate = geometry.offsets[n + 1] - geometry.offsets[n];
  geometry.measure(n, 20_542.25);
  const enlarged = initial - estimate + 20_542.25;
  for (const [first, last] of [[n - 1, n + 1], [n, n], [0, 1]]) {
    const before = geometry.offsets[first], after = geometry.extent - geometry.offsets[last + 1];
    assert.equal(before + (geometry.offsets[last + 1] - before) + after, enlarged);
  }
  geometry.measure(n, 320);
  assert.equal(geometry.extent, initial - estimate + 320, 'removing long content leaves no extra tail');
  geometry.reset(new Map());
  assert.equal(geometry.extent, initial, 'a new layout does not reserve the previous environment’s height');
});

test('first reveal waits for only its own visible image slot; raw images, offscreen loading and terminal errors do not block',async t=>{
  const [{firstConversationFrameReady:ready}]=await load(t,'firstConversationFrame.ts');
  let top=32,state='loading';const image={loading:'lazy'};
  const box=(t,b)=>({top:t,bottom:b,width:400,height:b-t});const body={getBoundingClientRect:()=>box(0,400)};
  const slot={dataset:{readingImage:'loading'},querySelector:()=>image,getBoundingClientRect:()=>box(top,top+100)};
  const row={dataset:{virtualRendered:'true'},getBoundingClientRect:()=>box(0,1200),querySelectorAll:sel=>sel.includes('data-reading-image')&&state==='loading'?[slot]:[]};
  assert.equal(ready(body,[row]),false);assert.equal(image.loading,'eager');top=427;image.loading='lazy';assert.equal(ready(body,[row]),true);assert.equal(image.loading,'lazy');
  top=32;for(const value of ['ready','error']){state=value;assert.equal(ready(body,[row]),true);}
});
