import test from 'node:test';
import assert from 'node:assert/strict';
import React, { createElement as h } from 'react';
import { renderToStaticMarkup as html } from 'react-dom/server';
import { loadGuiModules } from './gui-projection-contract.mjs';
const dir = '/src/components/local-agent/';
const rounds = Array.from({length:512}, (_, i) => ({key:`r${i}`,runId:`r${i}`,rows:[{key:`q${i}`},{key:`a${i}`}] }));
const load = async (t, ...names) => loadGuiModules(t, names.map(name => dir + name));

test('the indexed rail keeps its distant and current entries addressable in long local history', async t=>{
  const [{ConversationNavigation}]=await load(t,'ConversationNavigation.tsx');
  const entries=rounds.map((r,i)=>({key:r.rows[0].key,rowIndex:2*i,label:`Question ${i+1}`}));
  const rail=html(h(ConversationNavigation,{sessionId:'A', entries,viewport:{bodyRef:{current:null},followingLatest:true},language:'en-US',onNavigate(){}}));
  assert.equal((rail.match(/<button/g)??[]).length,40);assert.match(rail,/Go to message 512: Question 512/);
});

test('the frame acceptance helper waits for only its own visible image slot; raw images, offscreen loading and terminal errors do not block',async t=>{
  const [{firstConversationFrameReady:ready}]=await loadGuiModules(t,['/tests/support/firstConversationFrame.ts']);
  let top=32,state='loading';const image={loading:'lazy'};
  const box=(t,b)=>({top:t,bottom:b,width:400,height:b-t});const body={getBoundingClientRect:()=>box(0,400)};
  const slot={dataset:{readingImage:'loading'},querySelector:()=>image,getBoundingClientRect:()=>box(top,top+100)};
  const row={dataset:{virtualRendered:'true'},getBoundingClientRect:()=>box(0,1200),querySelectorAll:sel=>sel.includes('data-reading-image')&&state==='loading'?[slot]:[]};
  assert.equal(ready(body,[row]),false);assert.equal(image.loading,'eager');top=427;image.loading='lazy';assert.equal(ready(body,[row]),true);assert.equal(image.loading,'lazy');
  top=32;for(const value of ['ready','error']){state=value;assert.equal(ready(body,[row]),true);}
});


test('the frame acceptance helper allows a local waiting image to share the viewport with real glyphs, but not borrow a neighbor for an explicit image-only target',async t=>{
  const [{firstConversationFrameReady:ready}]=await loadGuiModules(t,['/tests/support/firstConversationFrame.ts']);
  const before=globalThis.getComputedStyle;
  globalThis.getComputedStyle=()=>({display:'block',visibility:'visible',opacity:'1',overflowX:'visible',overflowY:'visible'});
  t.after(()=>{if(before===undefined)delete globalThis.getComputedStyle;else globalThis.getComputedStyle=before;});
  const rect=(top,bottom)=>({top,bottom,height:bottom-top,left:0,right:320,width:320});
  const body={getBoundingClientRect:()=>rect(0,400)}, image={loading:'lazy'};
  const slot={dataset:{readingImage:'loading'},getBoundingClientRect:()=>rect(8,180),querySelector:()=>image};
  let glyphTop=200;
  const word={nodeType:3,data:'Cell',nextSibling:null};
  const range={setStart(){},setEnd(){},getBoundingClientRect:()=>rect(glyphTop,glyphTop+16),getClientRects:()=>[rect(glyphTop,glyphTop+16)]};
  const surface={matches:()=>false,getBoundingClientRect:()=>rect(0,900),firstChild:word};
  const row=(first,parts,roots)=>({dataset:{virtualRendered:'true'},ownerDocument:{createRange:()=>range},contains:()=>false,
    getBoundingClientRect:()=>first?rect(0,190):rect(190,390),querySelectorAll:s=>s.includes('data-reading-image')?parts:roots});
  const only=row(true,[slot],[]), neighbor=row(false,[],[surface]);
  assert.equal(ready(body,[only,neighbor]),true,'formally rendered neighbor may make the general viewport readable');
  assert.equal(image.loading,'lazy','do not promote an optional thumb when formal text is already visible');
  assert.equal(ready(body,[only,neighbor],only),false,'an explicitly restored image-only message still requires the actual image');
  assert.equal(image.loading,'eager','promote the visible image when the explicit target needs it');
  const mixed=row(true,[slot],[surface]);
  assert.equal(ready(body,[mixed],mixed),true,'visible formatted text in the target is sufficient while decoding');
  glyphTop=480;assert.equal(ready(body,[mixed],mixed),false,'the target box can overlap without its glyphs actually being in view');
  glyphTop=32;const unfinished={dataset:{},getBoundingClientRect:()=>rect(0,60)};
  assert.equal(ready(body,[row(true,[slot,unfinished],[surface])]),false,'pending formal Markdown still blocks, unlike an image');
});

test('image reads prioritise currently visible slots and discard waiting work when a slot leaves', async t => {
  const [{ whenPreviewVisible }] = await load(t, 'visibleImageReads.ts');
  let notify;
  const observed = new Set();
  const original = globalThis.IntersectionObserver;
  globalThis.IntersectionObserver = class {
    constructor(callback) { notify = callback; }
    observe(node) { observed.add(node); }
    unobserve(node) { observed.delete(node); }
    disconnect() { observed.clear(); }
  };
  t.after(() => {
    if (original === undefined) delete globalThis.IntersectionObserver;
    else globalThis.IntersectionObserver = original;
  });

  const slots = Array.from({ length: 7 }, () => ({}));
  const reads = [];
  const gate = Promise.withResolvers();
  const stop = slots.map((slot, index) => whenPreviewVisible(slot, async () => {
    reads.push(index);
    await gate.promise;
  }));
  t.after(() => { gate.resolve(); stop.forEach(release => release()); });
  const visible = target => ({ target, isIntersecting: true });
  assert.deepEqual(reads, []);
  notify(slots.slice(0, 6).map(visible));
  assert.deepEqual(reads, [0, 1, 2, 3]);
  notify([{ target: slots[4], isIntersecting: false }]);
  stop[5]();
  gate.resolve();
  await new Promise(setImmediate);
  assert.deepEqual(reads, [0, 1, 2, 3], 'neither the offscreen nor the unmounted slot consumes a read');
  notify([visible(slots[4]), visible(slots[6]), visible(slots[0])]);
  await new Promise(setImmediate);
  assert.deepEqual(reads, [0, 1, 2, 3, 4, 6]);
  assert.equal(observed.size, 0);
});
