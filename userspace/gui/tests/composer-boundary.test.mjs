import test from 'node:test';
import assert from 'node:assert/strict';
import { loadGuiModule } from './gui-projection-contract.mjs';

function boundaryFixture(t) {
  const previous = globalThis.ResizeObserver, previousMutation = globalThis.MutationObserver, observers = [], mutations = [];
  globalThis.MutationObserver = class {
    constructor(callback) { this.callback = callback; mutations.push(this); }
    observe() {} disconnect() { this.disconnected = true; }
  };
  globalThis.ResizeObserver = class {
    nodes = [];
    constructor(callback) { this.callback = callback; observers.push(this); }
    observe(node) { this.nodes.push(node); }
    unobserve(node) { this.nodes = this.nodes.filter(item => item !== node); }
    disconnect() { this.disconnected = true; }
  };
  t.after(() => { globalThis.ResizeObserver = previous; globalThis.MutationObserver = previousMutation; });
  const properties = new Map();
  let writes = 0;
  const geometry = { viewportBottom: 500, surfaceTop: 540 };
  const viewport = { clientHeight: 500,
    getBoundingClientRect: () => ({ bottom: geometry.viewportBottom }),
    style: {
      getPropertyValue: name => properties.get(name) ?? '',
      setProperty(name, value) { properties.set(name, value); writes++; },
      removeProperty: name => properties.delete(name),
    },
    set scrollTop(_value) { assert.fail('layout measurement does not own scrolling'); },
  };
  const surface = { getBoundingClientRect: () => ({ top: geometry.surfaceTop }) };
  const panel = { querySelector(selector) { assert.equal(selector, ':scope > .local-agent__viewport'); return viewport; } };
  const shell = {
    children: [],
    closest(selector) { assert.equal(selector, '.local-agent'); return panel; },
    querySelector(selector) { if (selector === ':scope > .conversation-change-dock') return null; assert.equal(selector, '.local-agent__composer'); return surface; },
  };
  return { geometry, viewport, surface, shell, observers, mutations, properties,
    get writes() { return writes; }, value: () => properties.get('--conversation-composer-overlap') };
}

test('transcript boundary follows the actual input through accessories, resizing and hidden Reader views', async t => {
  const { observeConversationComposerBoundary } = await loadGuiModule(t, '/src/components/local-agent/conversationComposerBoundary.ts');
  const fixture = boundaryFixture(t);
  const stop = observeConversationComposerBoundary(fixture.shell, fixture.viewport);
  t.after(stop);
  assert.equal(fixture.value(), '40px');
  assert.deepEqual(fixture.observers[0].nodes, [fixture.viewport, fixture.shell, fixture.surface]);
  const update = fixture.observers[0].callback;
  update();
  assert.equal(fixture.writes, 1, 'unchanged geometry does not rewrite layout');
  fixture.geometry.surfaceTop = 576;
  update();
  assert.equal(fixture.value(), '76px', 'accessories may wrap or include a notice, not a fixed dock height');
  Object.assign(fixture.geometry, { viewportBottom: 340, surfaceTop: 416 });
  update();
  assert.equal(fixture.value(), '76px', 'a growing input moves both boundaries without changing their gap');
  fixture.geometry.surfaceTop = 340;
  update();
  assert.equal(fixture.value(), '0px', 'no accessory space requires no overlap');
  fixture.geometry.surfaceTop = 330;
  update();
  assert.equal(fixture.value(), '0px', 'centered or overlapping input never shrinks the transcript');
  fixture.viewport.clientHeight = 0;
  fixture.geometry.surfaceTop = 600;
  update();
  assert.equal(fixture.value(), '0px', 'expanded Reader keeps the hidden conversation inactive');
  fixture.viewport.clientHeight = 340;
  fixture.geometry.surfaceTop = 380.5;
  update();
  assert.equal(fixture.value(), '40.5px', 'fractional layout boundaries retain their alignment');
  stop();
  assert.equal(fixture.observers[0].disconnected, true);
  assert.equal(fixture.properties.size, 0, 'unmount releases its owned CSS geometry');
});

test('a footer notice, populated dock and its open list reserve their real bounds; an empty dock is transparent', async t => {
  const { observeConversationComposerBoundary } = await loadGuiModule(t, '/src/components/local-agent/conversationComposerBoundary.ts');
  const f = boundaryFixture(t);
  let filled = false, visible = false;
  const list = { getBoundingClientRect: () => ({ top: 388, height: visible ? 126 : 0, width: 400 }) };
  const dock = { get childElementCount() { return Number(filled); },
    getBoundingClientRect: () => ({ top: 508, height: 32, width: 640 }),
    querySelector: () => filled ? list : null };
  const notice = { getBoundingClientRect: () => ({ top: 502, height: 38, width: 640 }) };
  f.shell.children.push(dock);
  const original = f.shell.querySelector;
  f.shell.querySelector = selector => selector === ':scope > .conversation-change-dock' ? dock : original(selector);
  const stop = observeConversationComposerBoundary(f.shell, f.viewport); t.after(stop);
  assert.equal(f.value(), '40px');
  f.shell.children.unshift(notice); f.observers[0].callback();
  assert.equal(f.value(), '2px', 'the input is not the reading edge when a notice precedes it');
  f.shell.children.shift(); filled = true; f.mutations[0].callback();
  assert.equal(f.value(), '8px', 'a dock can gain a real control without resizing its slot');
  assert.ok(f.observers[0].nodes.includes(list));
  visible = true; f.observers[0].callback(); assert.equal(f.value(), '-112px', 'a floating list can rise above the footer grid row');
  visible = false; f.observers[0].callback(); assert.equal(f.value(), '8px');
  filled = false; f.mutations[0].callback(); assert.equal(f.value(), '40px');
  assert.ok(!f.observers[0].nodes.includes(list));
  stop(); assert.equal(f.mutations[0].disconnected, true);
});

test('a deferred UI region binds the explicit conversation viewport before its shell is attached', async t => {
  const { observeConversationComposerBoundary } = await loadGuiModule(t, '/src/components/local-agent/conversationComposerBoundary.ts');
  const fixture = boundaryFixture(t);
  fixture.shell.closest = () => null; // UiRegion's portal host is not attached during the ref commit.
  fixture.geometry.surfaceTop = 0;
  const stop = observeConversationComposerBoundary(fixture.shell, fixture.viewport);
  t.after(stop);
  assert.equal(fixture.value(), '0px', 'the owner must install measurement even before the portal has geometry');
  assert.deepEqual(fixture.observers[0].nodes, [fixture.viewport, fixture.shell, fixture.surface]);
  fixture.geometry.surfaceTop = 560;
  fixture.observers[0].callback();
  assert.equal(fixture.value(), '60px', 'later region layout stays observed');
  stop();
  assert.equal(fixture.observers[0].disconnected, true);
  assert.equal(fixture.properties.size, 0);
});

test('a blocking Shell reserves its card instead of extending history beneath it', async t => {
  const { observeConversationComposerBoundary } = await loadGuiModule(t, '/src/components/local-agent/conversationComposerBoundary.ts');
  const fixture = boundaryFixture(t);
  const card = { getBoundingClientRect: () => ({ top: 508 }) };
  const shell = { ...fixture.shell, querySelector: selector => selector === '.local-agent__shell-wait' ? card : fixture.shell.querySelector(selector) };
  const stop = observeConversationComposerBoundary(shell, fixture.viewport, true);
  t.after(stop);
  assert.equal(fixture.value(), '8px');
  assert.deepEqual(fixture.observers[0].nodes, [fixture.viewport, shell, card]);
  fixture.geometry.surfaceTop += 120;
  fixture.observers[0].callback();
  assert.equal(fixture.value(), '8px', 'opening output must not move history over the waiting command');
});

test('the first connected resize measures the composer', async t => {
  const { observeConversationComposerBoundary } = await loadGuiModule(t, '/src/components/local-agent/conversationComposerBoundary.ts');
  const f = boundaryFixture(t); f.surface.isConnected = false; f.geometry.surfaceTop = 0;
  const close = observeConversationComposerBoundary(f.shell, f.viewport); t.after(close);
  f.observers[0].callback();
  f.surface.isConnected = true; f.geometry.surfaceTop = 540;
  f.observers[0].callback(); assert.equal(f.value(), '40px');
  const writes = f.writes; f.observers[0].callback(); assert.equal(f.writes, writes);
});

test('a detached input never publishes a false zero height; its true draft size is in the first connected reading boundary', async t => {
  const {resizeComposerTextarea, observeConversationComposerBoundary}=await loadGuiModule(t,'/src/components/local-agent/conversationComposerBoundary.ts');
  const f=boundaryFixture(t);let reads=0, height=88;
  const input={style:{height:''},isConnected:false,clientWidth:0,clientHeight:72,get scrollHeight(){reads++;return this.isConnected?height:0;}};
  resizeComposerTextarea(input);assert.equal(input.style.height,'auto');assert.equal(reads,0);
  f.surface.isConnected=false;f.surface.querySelector=s=>{assert.equal(s,':scope > textarea');return input;};
  const stop=observeConversationComposerBoundary(f.shell,f.viewport);t.after(stop);
  f.observers[0].callback();assert.equal(reads,0);
  input.isConnected=f.surface.isConnected=true;input.clientWidth=780;
  f.observers[0].callback();assert.equal(input.style.height,'88px');assert.equal(reads,1);
  f.observers[0].callback();assert.equal(reads,1,'ordinary boundary observations do not reflow the draft every time');
  height=173;resizeComposerTextarea(input);assert.equal(input.style.height,'173px','subsequent content and width changes retain autosize');
  height=72;resizeComposerTextarea(input);assert.equal(input.style.height,'auto','short drafts keep their native rows without a fixed-height round trip');
});

test('a standalone composer without a transcript installs no observer', async t => {
  const { observeConversationComposerBoundary } = await loadGuiModule(t, '/src/components/local-agent/conversationComposerBoundary.ts');
  const fixture = boundaryFixture(t);
  observeConversationComposerBoundary(fixture.shell, null)();
  observeConversationComposerBoundary({ ...fixture.shell, querySelector: () => null }, fixture.viewport)();
  assert.equal(fixture.observers.length, 0);
});
