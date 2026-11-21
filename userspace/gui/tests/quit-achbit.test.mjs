import assert from 'node:assert/strict';
import test from 'node:test';
import { Children, createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { findReactElement, loadGuiModules } from './gui-projection-contract.mjs';

const sectionsPath = '/src/components/settings-center/sections/CategorizedSettingsSections.tsx';
const actionPath = '/src/components/settings-center/QuitAchbitAction.tsx';
const runtimePath = '/src/services/runtimeAdapter.ts';
function shell(t, { remote = false, preview = false, native = true, bound = true } = {}) {
  const old = globalThis.window, calls = [];
  globalThis.window = { location: new URL('achbit-gui://localhost/index.html'),
    ...(bound && { __ACHBIT_HOST_BOOT__: { schemaVersion: 'achbit.host-ui-bootstrap', host: '127.0.0.1', port: '32123',
      uiToken: `acui_${'a'.repeat(64)}`, windowChrome: 'custom', remote } }),
    __ACHBIT_BROWSER_PREVIEW__: preview,
    ...(native && { __TAURI__: { core: { invoke: async (...args) => { calls.push(args); return { status: 'exiting' }; } } } }),
  };
  t.after(() => { if (old === undefined) delete globalThis.window; else globalThis.window = old; });
  return calls;
}

function capture(fn) {
  let tree;
  function Probe() { tree = fn(); return null; }
  renderToStaticMarkup(createElement(Probe));
  return tree;
}

test('About exposes a one-shot local quit action; opening or finding it sends nothing', async t => {
  const calls = shell(t);
  const [{ GuiSettingsSection, settingsSearchDefinitions }] = await loadGuiModules(t, [sectionsPath]);
  const about = renderToStaticMarkup(createElement(GuiSettingsSection, { category: 'about', apiStatus: 'connected' }));
  assert.match(about, /退出 Achbit|Quit Achbit/, 'the local desktop About page has a quit action');
  for (const [locale, title] of [['zh-CN', '退出 Achbit'], ['en-US', 'Quit Achbit']]) {
    const entries = settingsSearchDefinitions(locale, 'macos').filter(entry => entry.title === title);
    assert.equal(entries.length, 1); assert.equal(entries[0].category, 'about');
  }
  assert.deepEqual(calls, [], 'showing or searching About must not query or stop the Host');
});

test('remote windows, browser previews and unbound native contexts cannot target a local Host', async t => {
  for (const [name, options] of [['SSH', { remote: true }], ['preview', { preview: true }],
    ['ordinary browser', { native: false, bound: false }], ['secondary WebView', { bound: false }]]) {
    await t.test(name, async sub => {
      const calls = shell(sub, options);
      const [{ GuiSettingsSection, settingsSearchDefinitions }, runtime] = await loadGuiModules(sub, [sectionsPath, runtimePath]);
      assert.equal(runtime.canQuitAchbit(), false);
      assert.doesNotMatch(renderToStaticMarkup(createElement(GuiSettingsSection, { category: 'about', apiStatus: 'connected' })), /退出 Achbit|Quit Achbit/);
      assert.equal(settingsSearchDefinitions('en-US', 'macos').some(entry => entry.title === 'Quit Achbit'), false);
      await assert.rejects(runtime.quitAchbit(null, false), /local_quit_unavailable/);
      assert.deepEqual(calls, []);
    });
  }
});

const byAction = (view, name) => findReactElement(view, node => node.props['data-ui-action'] === `settings.quit.${name}`);
test('About quit layout: Quit immediately follows Reload, with its scope only in an accessible tooltip', async t => {
  const calls = shell(t);
  const [{ GuiSettingsSection }, { QuitAchbitControls }, { useSettingsStore }, { t: label }] = await loadGuiModules(t,
    [sectionsPath, actionPath, '/src/state/settingsStore.ts', '/src/i18n.ts']);
  const settings = useSettingsStore.getInitialState(), saved = settings.effectiveSettings;
  t.after(() => { settings.effectiveSettings = saved; });
  for (const [language, reload] of [['zh-CN', '重新加载界面'], ['en-US', 'Reload interface']]) {
    settings.effectiveSettings = { ...saved, 'workbench.language': language };
    const view = capture(() => GuiSettingsSection({ category: 'about', apiStatus: 'connected' }));
    const row = findReactElement(view, e => Children.toArray(e.props.children).some(child => child.props?.children === reload));
    const buttons = [...renderToStaticMarkup(row).matchAll(/<button\b[^>]*>([^<]*)<\/button>/g)].map(match => match[1]);
    assert.equal(buttons[buttons.indexOf(reload) + 1], label(language, 'settings.quit.action'), 'both actions share the same row in this order');
    const controls = capture(() => QuitAchbitControls({ language, state: { busy: false, prompt: null, error: null }, action: {} }));
    const button = byAction(controls, 'open');
    const tooltip = findReactElement(controls, e => e.props.role === 'tooltip');
    assert.equal(button.props['aria-describedby'], tooltip.props.id);
    assert.equal(tooltip.props.popover, 'manual', 'closed native help takes no space');
    assert.equal(tooltip.props.children, label(language, 'settings.quit.scope'));
    assert.equal(renderToStaticMarkup(controls).split(tooltip.props.children).length - 1, 1, 'no permanent duplicate of the scope sentence');
  }
  assert.deepEqual(calls, []);
});

test('About quit help: hover and keyboard focus show and dismiss help without issuing a command', async t => {
  const calls = shell(t);
  const [{ QuitAchbitControls, createQuitAction }] = await loadGuiModules(t, [actionPath]);
  const action = createQuitAction(() => assert.fail('help is not a quit action'));
  const target = { contains: () => false, getBoundingClientRect: () => ({ left: 12, top: 8, bottom: 32 }) };
  const open = [];
  function Probe() {
    const view = QuitAchbitControls({ language: 'en-US', state: { busy: false, prompt: null, error: null }, action });
    const button = byAction(view, 'open').props;
    open.push(button['data-escape-layer'] === 'open');
    if (open.length === 1) button.onMouseEnter({ currentTarget: target, clientX: 14, clientY: 18 });
    if (open.length === 2) button.onMouseLeave();
    if (open.length === 3) button.onFocus({ currentTarget: target, target });
    if (open.length === 4) button.onBlur({ currentTarget: target, relatedTarget: null });
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  assert.deepEqual(open, [false, true, false, true, false]);
  assert.deepEqual(calls, []);
});

const flush = () => new Promise(resolve => setImmediate(resolve));
const request = (confirmHostId = null, hasUnsavedChanges = false) => ['achbit_quit', { confirmHostId, hasUnsavedChanges }];

test('an idle local desktop click exits once without prompting or reissuing an accepted exit', async t => {
  const calls = shell(t);
  const [{ default: QuitAchbitAction }] = await loadGuiModules(t, [actionPath]);
  const action = capture(() => QuitAchbitAction({ language: 'en-US' }));
  const entry = byAction(capture(() => action.type(action.props)), 'open');
  assert.deepEqual(calls, []);
  entry.props.onClick(); entry.props.onClick(); await flush(); entry.props.onClick();
  assert.deepEqual(calls, [request()]);
});

test('quit confirmation defaults to cancel, preserves unsaved warnings and confirms only the original Host', async t => {
  const calls = shell(t);
  const [{ createQuitAction, QuitAchbitControls }, guards, { ModalDialog }] = await loadGuiModules(t,
    [actionPath, '/src/services/interfaceReload.ts', '/src/ui-components/index.ts']);
  const clear = guards.registerInterfaceReloadGuard(() => ({ label: 'Remote profile', busy: false })); t.after(clear);
  let state, finishExit;
  const flow = createQuitAction(next => { state = next; });
  window.__TAURI__.core.invoke = async (...args) => {
    calls.push(args);
    return args[1].confirmHostId === null ? { status: 'confirmationRequired', hostId: 'host:first', active: true }
      : new Promise(resolve => { finishExit = resolve; });
  };
  const controls = (language = 'en-US') => capture(() => QuitAchbitControls({ language, state, action: flow }));
  await flow.submit(null);
  const initial = controls(), modal = findReactElement(initial, node => node.type === ModalDialog);
  const text = renderToStaticMarkup(modal.props.children);
  assert.match(text, /shared Host on this computer/); assert.match(text, /all clients/);
  assert.match(text, /Unfinished tasks will stop/); assert.match(text, /Remote profile/);
  assert.equal(byAction(initial, 'cancel').props.autoFocus, true);
  assert.notEqual(byAction(initial, 'confirm').props.autoFocus, true);
  const chinese = renderToStaticMarkup(findReactElement(controls('zh-CN'), node => node.type === ModalDialog).props.children);
  assert.match(chinese, /本机共享/); assert.match(chinese, /尚未保存/);
  byAction(initial, 'cancel').props.onClick();
  byAction(initial, 'confirm').props.onClick(); // A control from the dismissed dialog has no consent.
  assert.deepEqual(calls, [request(null, true)]);
  await flow.submit(null); findReactElement(controls(), node => node.type === ModalDialog).props.onClose();
  assert.deepEqual(calls, [request(null, true), request(null, true)], 'Escape or backdrop never confirms');
  await flow.submit(null);
  const live = controls(); clear(); // Read current guards when the user actually confirms.
  byAction(live, 'confirm').props.onClick(); byAction(live, 'confirm').props.onClick(); byAction(live, 'cancel').props.onClick();
  assert.equal(state.busy, true); assert.equal(byAction(controls(), 'cancel').props.disabled, true);
  assert.deepEqual(calls.slice(2), [request(null, true), request('host:first', false)]);
  finishExit({ status: 'exiting' }); await flush();
  assert.equal(state.prompt, null); assert.equal(state.busy, true);
});

test('a quit failure remains visible and retry starts with no previous Host confirmation', async t => {
  const calls = shell(t);
  const [{ createQuitAction, QuitAchbitControls }, runtime] = await loadGuiModules(t, [actionPath, runtimePath]);
  const problem = new Error('quit_target_changed: original native error');
  window.__TAURI__.core.invoke = async () => { throw problem; };
  await assert.rejects(runtime.quitAchbit(null, false), error => error === problem);
  let state;
  const flow = createQuitAction(next => { state = next; });
  window.__TAURI__.core.invoke = async (...args) => {
    calls.push(args);
    if (args[1].confirmHostId !== null) throw problem;
    return calls.length === 1 ? { status: 'confirmationRequired', hostId: 'host:previous', active: true } : { status: 'exiting' };
  };
  await flow.submit(null); await flow.submit(state.prompt);
  const view = capture(() => QuitAchbitControls({ language: 'en-US', state, action: flow }));
  assert.equal(findReactElement(view, node => node.props.role === 'alert').props.children, problem.message);
  assert.equal(byAction(view, 'open').props.disabled, false);
  byAction(view, 'open').props.onClick(); await flush();
  assert.deepEqual(calls, [request(), request('host:previous'), request()]);
});
