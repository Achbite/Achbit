import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, relative, resolve, dirname } from 'node:path';
import ts from 'typescript';
import { loadGuiModules, loadGuiModule } from './gui-projection-contract.mjs';

test('the catalog and imports expose the same stable implementations, including existing controls', async t => {
  const [ui, modal, toggle, select, resize, icons] = await loadGuiModules(t, [
    '/src/ui-components/index.ts', '/src/components/shared/ModalDialog.tsx',
    '/src/components/shared/ToggleSwitch.tsx', '/src/components/shared/NativeSelect.tsx',
    '/src/components/shared/ResizeHandle.tsx', '/src/icons/registry.tsx',
  ]);
  assert.ok(Object.isFrozen(ui.UI_COMPONENTS));
  for (const [name, entry] of Object.entries(ui.UI_COMPONENTS)) {
    assert.equal(ui[name], entry.component, `${name} must not get a registration wrapper`);
    assert.ok(entry.purpose);
    if (entry.base) assert.ok(ui.UI_COMPONENTS[entry.base], `${name} has a registered base`);
  }
  assert.equal(ui.ModalDialog, modal.default);
  assert.equal(ui.ToggleSwitch, toggle.default);
  assert.equal(ui.NativeSelect, select.default);
  assert.equal(ui.ResizeHandle, resize.default);
  assert.equal(ui.UiIcon, icons.default);
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

test('CloseButton composes the registered bases and keeps accessible labels and callback ownership', async t => {
  const { CloseButton, IconButton, Button } = await loadGuiModule(t, '/src/ui-components/index.ts');
  const ref = { current: null };
  let closed = 0;
  const onClick = () => { closed++; };
  const props = { ref, onClick, disabled: true, size: 'compact', 'aria-label': 'Close plan', title: 'Cancel the plan',
    'data-ui-owner': 'composer.question', 'data-ui-action': 'composer.question.close', 'data-ui-part': 'close' };
  const icon = CloseButton(props);
  assert.equal(icon.type, IconButton);
  const base = IconButton(icon.props);
  assert.equal(base.type, Button);
  const native = Button(base.props);
  assert.equal(native.type, 'button');
  assert.equal(native.props.ref, ref);
  assert.equal(native.props.disabled, true);
  assert.equal(native.props.onClick, onClick);
  assert.equal(native.props['data-ui-action'], props['data-ui-action']);
  assert.equal(closed, 0, 'composition does not perform business actions');
  const html = renderToStaticMarkup(createElement(CloseButton, props));
  assert.match(html, /^<button\b/);
  assert.equal((html.match(/<button\b/g) ?? []).length, 1);
  assert.match(html, /aria-label="Close plan"/);
  assert.match(html, /title="Cancel the plan"/);
  assert.match(html, /data-ui-component="CloseButton"/);
  assert.match(html, /data-ui-icon="close"/);
  assert.match(html, /disabled=""/);
  assert.match(html, /data-ui-owner="composer.question"/);
  assert.equal(IconButton({ icon: 'plus', 'aria-label': 'New tab' }).props.title, 'New tab');
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
  const [{ UI_REGION_SLOTS, regionSlots }, { withBuiltinRegions }] = await loadGuiModules(t, [
    '/src/ui-plugins/slots.ts', '/src/ui-plugins/builtins.ts',
  ]);
  assert.deepEqual(regionSlots, Object.keys(UI_REGION_SLOTS));
  assert.equal(new Set(regionSlots).size, regionSlots.length);
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

test('feature imports use the catalog rather than private shared-control implementations', async () => {
  const root = fileURLToPath(new URL('../src', import.meta.url));
  const privateControls = new Set(['ModalDialog', 'ToggleSwitch', 'NativeSelect', 'ResizeHandle']);
  const violations = [];
  async function walk(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) { await walk(path); continue; }
      if (!/\.tsx?$/.test(path)) continue;
      const local = relative(root, path).split('\\').join('/');
      if (local.startsWith('ui-components/')) continue;
      const file = ts.createSourceFile(path, await readFile(path, 'utf8'), ts.ScriptTarget.Latest, true);
      for (const node of file.statements) {
        if (!ts.isImportDeclaration(node) || !ts.isStringLiteral(node.moduleSpecifier)) continue;
        const specifier = node.moduleSpecifier.text;
        const target = relative(root, resolve(dirname(path), specifier)).split('\\').join('/').replace(/\.tsx?$/, '');
        if (target.startsWith('ui-components/')) violations.push(`${local}: use the public ui-components entrypoint`);
        if (target.startsWith('components/shared/') && privateControls.has(target.slice('components/shared/'.length))) {
          violations.push(`${local}: ${specifier}`);
        }
      }
    }
  }
  await walk(root);
  assert.deepEqual(violations, []);
});
