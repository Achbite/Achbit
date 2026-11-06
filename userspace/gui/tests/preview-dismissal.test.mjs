import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { loadGuiModule, loadGuiModules, findReactElement } from './gui-projection-contract.mjs';

test('preview dismissal belongs to session, run and source rather than target or refresh', async t => {
  const { dismissPreview, isPreviewDismissed, acceptPreview } = await loadGuiModule(t, '/src/services/computerPreview.ts');
  const state = dismissPreview({}, 'session:a', 'run:a', 'browser');
  assert.equal(dismissPreview(state, 'session:a', 'run:a', 'browser'), state);
  assert.equal(isPreviewDismissed(state, 'session:a', 'run:a', 'browser'), true);
  assert.equal(isPreviewDismissed(state, 'session:a', 'run:a', 'desktop'), false);
  assert.equal(isPreviewDismissed(state, 'session:b', 'run:a', 'browser'), false);
  assert.equal(isPreviewDismissed(state, 'session:a', 'run:next', 'browser'), false);
  const error = acceptPreview(null, { state: 'failed', reason: 'original capture error' });
  assert.equal(error.reason, 'original capture error', 'hiding does not rewrite preview facts');
  assert.equal(isPreviewDismissed(state, 'session:a', 'run:a', 'browser'), true);
  const both = dismissPreview(state, 'session:a', 'run:a', 'desktop');
  assert.equal(isPreviewDismissed(both, 'session:a', 'run:a', 'browser'), true, 'closing desktop preserves the browser dismissal');
  assert.equal(isPreviewDismissed(both, 'session:a', 'run:a', 'desktop'), true);
  const otherSession = dismissPreview(both, 'session:b', 'run:b', 'browser');
  assert.equal(isPreviewDismissed(otherSession, 'session:a', 'run:a', 'desktop'), true, 'switching away and back preserves this run dismissal');
  assert.equal(isPreviewDismissed(otherSession, 'session:b', 'run:b', 'browser'), true);
  const next = dismissPreview(otherSession, 'session:a', 'run:next', 'desktop');
  assert.deepEqual(next['session:a'], { runId: 'run:next', sources: ['desktop'] });
  assert.equal(isPreviewDismissed(next, 'session:a', 'run:next', 'browser'), false, 'a new run restores the previously hidden browser');
  assert.equal(isPreviewDismissed(next, 'session:a', 'run:next', 'desktop'), true);
  assert.equal(isPreviewDismissed(next, 'session:b', 'run:b', 'browser'), true, 'a new run does not reset another session');
});

test('close is a sibling control; Escape is scoped to the card and composition is respected', async t => {
  const [{ FloatingComputerPreview }, { CloseButton, IconButton, Button }] = await loadGuiModules(t, [
    '/src/achbit-gui/layout/ComputerTargetPreview.tsx', '/src/ui-components/index.ts',
  ]);
  let dismissed = 0, stopped = 0;
  function Probe() {
    const card = FloatingComputerPreview({ view: { state: 'failed', reason: 'real preview error' },
      sessionId: 's', runId: 'r', language: 'zh-CN', readerLayout: { visible: false, expanded: false },
      concealed: true, index: 0, overlay: { current: null }, raised: false, onRaise() {}, onDismiss() { dismissed++; } });
    const control = findReactElement(card, node => node.type === CloseButton && node.props['data-ui-part'] === 'close');
    const icon = CloseButton(control.props);
    assert.equal(icon.type, IconButton);
    const base = IconButton(icon.props);
    assert.equal(base.type, Button);
    const close = Button(base.props);
    assert.equal(close.type, 'button', 'the registered composition still exposes the native control');
    close.props.onPointerDown({ stopPropagation() { stopped++; } });
    assert.equal(dismissed, 0, 'pointerdown does not close or start dragging');
    close.props.onClick({ preventDefault() {}, stopPropagation() { stopped++; } });
    assert.equal(dismissed, 1);
    card.props.onKeyDown({ key: 'Escape', nativeEvent: { isComposing: true } });
    assert.equal(dismissed, 1);
    card.props.onKeyDown({ key: 'Escape', keyCode: 229, nativeEvent: {} });
    assert.equal(dismissed, 1, 'legacy composition key events must not hide the preview');
    card.props.onKeyDown({ key: 'Enter', nativeEvent: {} });
    assert.equal(dismissed, 1, 'other keys stay available to the focused control');
    card.props.onKeyDown({ key: 'Escape', nativeEvent: {}, preventDefault() {}, stopPropagation() { stopped++; } });
    assert.equal(dismissed, 2);
    assert.equal(card.props.hidden, true);
    return card;
  }
  const html = renderToStaticMarkup(createElement(Probe));
  assert.equal((html.match(/<button\b/g) ?? []).length, 2);
  assert.match(html, /<\/button><button[^>]*data-ui-part="close"/);
  assert.match(html, /real preview error/, 'hidden cards retain the original error rather than dropping it');
  assert.equal(stopped, 3);
});
