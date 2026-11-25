import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { reviewSource, sourceFiles } from '../scripts/ui-review.mjs';
import { loadGuiModules, loadGuiModule } from './gui-projection-contract.mjs';

test('the catalog and imports expose the same stable implementations, including existing controls', async t => {
  const [ui, modal, toggle, select, resize, icons, shellIcons] = await loadGuiModules(t, [
    '/src/ui-components/index.ts', '/src/ui-components/ModalDialog.tsx',
    '/src/ui-components/ToggleSwitch.tsx', '/src/ui-components/NativeSelect.tsx',
    '/src/ui-components/ResizeHandle.tsx', '/src/icons/registry.tsx', '/src/components/shared/AchbitShellIcon.tsx',
  ]);
  assert.ok(Object.isFrozen(ui.UI_COMPONENTS));
  for (const [name, component] of Object.entries(ui)) {
    if (typeof component === 'function' && /^[A-Z]/.test(name)) {
      assert.equal(ui.UI_COMPONENTS[name]?.component, component, `public control ${name} must be registered`);
    }
  }
  for (const [name, entry] of Object.entries(ui.UI_COMPONENTS)) {
    assert.equal(ui[name], entry.component, `${name} must not get a registration wrapper`);
    assert.ok(entry.purpose);
    assert.ok(entry.family, `${name} has a component family`);
    if (entry.base) assert.ok(ui.UI_COMPONENTS[entry.base], `${name} has a registered base`);
  }
  assert.equal(ui.ModalDialog, modal.default);
  assert.equal(ui.ToggleSwitch, toggle.default);
  assert.equal(ui.NativeSelect, select.default);
  assert.equal(ui.ResizeHandle, resize.default);
  assert.equal(ui.UiIcon, icons.default);
  assert.equal(shellIcons.default, ui.UiIcon);
  assert.equal(ui.UI_ICON_ROLES, icons.UI_ICON_ROLES);
  assert.deepEqual(ui.UI_ICON_NAMES, Object.keys(icons.UI_ICON_GLYPHS));
});

test('Button preserves refs, native submission, events and owner identity without adding a wrapper', async t => {
  const { Button } = await loadGuiModule(t, '/src/ui-components/index.ts');
  const ref = { current: null };
  const events = [];
  const onClick = event => events.push(event);
  const button = Button({ ref, onClick, children: 'Continue', 'data-ui-owner': 'example.panel', 'data-ui-part': 'continue' });
  assert.equal(button.type, 'button');
  assert.equal(button.props.type, 'button');
  assert.equal(button.props.ref, ref);
  assert.equal(button.props.onClick, onClick);
  assert.equal(button.props.children, 'Continue');
  const event = { marker: 'original event' };
  button.props.onClick(event);
  assert.deepEqual(events, [event]);
  assert.equal(button.props['data-ui-owner'], 'example.panel');
  assert.equal(button.props['data-ui-part'], 'continue');
  assert.equal(Button({ type: 'submit', form: 'save', name: 'action', value: 'save' }).props.type, 'submit');
  const disabled = renderToStaticMarkup(createElement(Button, { disabled: true, type: 'submit', form: 'save' }, 'Save'));
  assert.match(disabled, /disabled=""/);
  assert.match(disabled, /type="submit"/);
  assert.match(disabled, /form="save"/);
});

test('CloseButton exposes one native action with its accessible name, icon and owner', async t => {
  const { CloseButton, IconButton } = await loadGuiModule(t, '/src/ui-components/index.ts');
  const ref = { current: null };
  let closed = 0;
  const onClick = () => { closed++; };
  const props = { ref, onClick, disabled: true, size: 'compact', 'aria-label': 'Close plan', title: 'Cancel the plan',
    'data-ui-owner': 'composer.question', 'data-ui-action': 'composer.question.close', 'data-ui-part': 'close' };
  const html = renderToStaticMarkup(createElement(CloseButton, props));
  assert.match(html, /^<button\b/);
  assert.equal((html.match(/<button\b/g) ?? []).length, 1);
  assert.match(html, /aria-label="Close plan"/);
  assert.match(html, /title="Cancel the plan"/);
  assert.match(html, /data-ui-component="CloseButton"/);
  assert.match(html, /data-ui-icon="close"/);
  assert.match(html, /disabled=""/);
  assert.match(html, /data-ui-owner="composer.question"/);
  assert.match(html, /data-ui-action="composer.question.close"/);
  assert.match(html, /data-ui-part="close"/);
  assert.equal(closed, 0, 'rendering a control does not invoke its action');
  assert.equal(IconButton({ icon: 'plus', 'aria-label': 'New tab' }).props.title, 'New tab');
});

test('DisclosureSummary preserves native semantics, refs and owner events with a decorative registered glyph', async t => {
  const { DisclosureSummary } = await loadGuiModule(t, '/src/ui-components/index.ts');
  const ref = { current: null };
  const events = [];
  const onClick = event => events.push(event);
  const onKeyDown = () => {};
  const label = createElement('strong', { id: 'disclosure-label' }, '操作参数 / Parameters');
  const summary = DisclosureSummary({ ref, children: label, onClick, onKeyDown, title: 'Parameters',
    'aria-describedby': 'disclosure-help', 'data-ui-owner': 'conversation.computer', 'data-ui-action': 'parameters' });
  assert.equal(summary.type, 'summary');
  assert.equal(summary.props.ref, ref);
  assert.equal(summary.props.onClick, onClick);
  assert.equal(summary.props.onKeyDown, onKeyDown);
  assert.equal(summary.props.children[0], label);
  assert.equal(summary.props['aria-describedby'], 'disclosure-help');
  assert.equal(summary.props['data-ui-owner'], 'conversation.computer');
  assert.equal(summary.props['data-ui-action'], 'parameters');
  assert.equal(summary.props['aria-expanded'], undefined, 'the parent details owns native expansion');
  assert.deepEqual(events, []);
  const event = { original: true };
  summary.props.onClick(event);
  assert.deepEqual(events, [event]);
  const html = renderToStaticMarkup(createElement('details', { open: true }, summary, createElement('pre', null, '{}')));
  assert.match(html, /^<details open=""><summary\b/);
  assert.match(html, /操作参数 \/ Parameters/);
  assert.equal((html.match(/<summary\b/g) ?? []).length, 1);
  assert.doesNotMatch(html, /<button\b/);
  assert.match(html, /data-ui-icon="chevronRight"/);
  assert.match(html, /<svg[^>]*aria-hidden="true"/);
  const leading = renderToStaticMarkup(createElement(DisclosureSummary, { chevronPosition: 'leading' }, '字体组合'));
  assert.match(leading, /data-chevron-position="leading"/);
  assert.equal((leading.match(/data-ui-icon="chevronRight"/g) ?? []).length, 1);
});

test('PanelHeader preserves caller headings and action nodes in one semantic header', async t => {
  const { PanelHeader, CloseButton } = await loadGuiModule(t, '/src/ui-components/index.ts');
  const heading = createElement('h2', { id: 'panel-title' }, 'Panel');
  const close = createElement(CloseButton, { 'aria-label': 'Close panel' });
  const children = [heading, close];
  const header = PanelHeader({ children, 'data-ui-owner': 'example.panel', className: 'feature-placement' });
  assert.equal(header.type, 'header');
  assert.equal(header.props.children, children);
  assert.equal(header.props['data-ui-owner'], 'example.panel');
  const html = renderToStaticMarkup(header);
  assert.match(html, /^<header\b/);
  assert.match(html, /<h2 id="panel-title">Panel<\/h2>/);
  assert.equal((html.match(/<button\b/g) ?? []).length, 1);
});

test('region declarations drive built-ins while external selection replaces only its own slots', async t => {
  const [{ UI_REGION_SLOTS, regionSlots, isSettingsContributionSlot }, { withBuiltinRegions }] = await loadGuiModules(t, [
    '/src/ui-plugins/slots.ts', '/src/ui-plugins/builtins.ts',
  ]);
  assert.deepEqual(regionSlots, Object.keys(UI_REGION_SLOTS));
  assert.equal(new Set(regionSlots).size, regionSlots.length);
  assert.equal(isSettingsContributionSlot('settings.navigation'), false, 'navigation has one region owner');
  for (const slot of ['settings.models.overview', 'settings.connection.detail', 'settings.usage.panel'])
    assert.equal(isSettingsContributionSlot(slot), true, 'installed settings contributions may coexist');
  const builtin = withBuiltinRegions([], false);
  assert.equal(builtin.length, 1);
  assert.deepEqual(builtin[0].manifest.slots, regionSlots);
  const file = { path: 'fixture:navigation', enabled: true,
    manifest: { id: 'fixture.navigation', name: 'Navigation', entry: 'index.js', slots: ['navigation'] }, source: '', error: null };
  const selected = withBuiltinRegions([file], false);
  assert.equal(selected[1], file);
  assert.deepEqual(selected[0].manifest.slots, regionSlots.filter(slot => slot !== 'navigation'));
  assert.deepEqual(withBuiltinRegions([{ ...file, enabled: false }], false)[0].manifest.slots, regionSlots);
  const usage = withBuiltinRegions([]).find(file => file.path === 'builtin:usage');
  assert.deepEqual(usage.manifest.slots, ['usage.widget']);
});

test('feature imports and re-exports use the catalog rather than private shared-control implementations', async () => {
  const gui = fileURLToPath(new URL('..', import.meta.url));
  const violations = [];
  for (const dir of ['src', 'tests/manual']) {
    for (const file of await sourceFiles(resolve(gui, dir))) {
      if (!/\.[cm]?[jt]sx?$/.test(file)) continue;
      const source = await readFile(file, 'utf8');
      for (const row of reviewSource(file, source, [[1, source.split('\n').length]])) {
        if (row.kind === 'error') violations.push({ file, ...row });
      }
    }
  }
  assert.deepEqual(violations, []);
});


test('incremental review identifies individual controls and styles without rejecting a specialized interaction', () => {
  const file = fileURLToPath(new URL('../src/components/Example.tsx', import.meta.url));
  const source = [
    'const previous = <button>existing</button>;',
    'const menu = <summary aria-haspopup="menu">Actions</summary>;',
    "const load = () => import('../ui-components/Button');",
    "export { Button } from '../ui-components';",
    "export { IconButton } from '../ui-components/index.ts';",
  ].join('\n');
  const hits = reviewSource(file, source, [[2, 5]]);
  assert.deepEqual(hits.map(h => [h.line, h.kind]), [[2, 'control'], [3, 'error']]);
  assert.match(hits[0].detail, /DisclosureSummary/);
  const css = '.old { padding: 4px; }\n.menu {\n  gap: 8px;\n}';
  assert.deepEqual(reviewSource(file + '.css', css, [[3, 3]]), [{ line: 3, kind: 'style', detail: '.menu' }]);
  assert.equal(reviewSource(file + '.html', '<main><summary>Details</summary></main>', [[1, 1]])[0].kind, 'control');
});
