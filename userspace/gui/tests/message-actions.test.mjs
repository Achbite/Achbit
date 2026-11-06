import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { findReactElement, loadGuiModule } from './gui-projection-contract.mjs';

const createdAt = '1793901582836';
const expectedDate = new Date(Number(createdAt));
const message = role => ({ messageId: `message:${role}`, role, content: '保留正文', createdAt,
  filesystemReferences: [], pluginSelections: [], feedback: null, sequence: 1,
  ...(role === 'assistant' ? { runId: 'run:reply', providerRequestId: 'request:reply' } : {}) });

async function setup(t, role, overrides = {}) {
  const { MessageActions } = await loadGuiModule(t, '/src/components/local-agent/MessageActions.tsx');
  const calls = [];
  const props = { message: message(role), language: 'zh-CN', copied: false, busy: false, canEdit: true,
    onCopy: () => calls.push('copy'), onEdit: () => calls.push('edit'), onFeedback: value => calls.push(value), ...overrides };
  let tree;
  function Probe() { tree = MessageActions(props); return null; }
  renderToStaticMarkup(createElement(Probe));
  return { tree, html: renderToStaticMarkup(tree), calls, props };
}

test('user message time precedes actions and preserves copy, edit and original journal time', async t => {
  const { tree, html, calls } = await setup(t, 'user');
  const time = findReactElement(tree, node => node.type === 'time');
  assert.equal(time.props.dateTime, expectedDate.toISOString());
  assert.equal(time.props.children, expectedDate.toLocaleTimeString('zh-CN', { hour: 'numeric', minute: '2-digit', hourCycle: 'h23' }));
  assert.equal(time.props.title, expectedDate.toLocaleString('zh-CN'));
  assert.ok(html.indexOf('<time ') < html.indexOf('<button '));
  findReactElement(tree, node => node.props['data-ui-action'] === 'conversation.message-actions.copy').props.onClick();
  findReactElement(tree, node => node.props['data-ui-action'] === 'conversation.message-actions.edit').props.onClick();
  assert.deepEqual(calls, ['copy', 'edit']);
});

test('assistant message time follows feedback controls with original feedback semantics', async t => {
  const { tree, html, calls } = await setup(t, 'assistant', { language: 'en-US', copied: true,
    message: { ...message('assistant'), createdAt: expectedDate.toISOString(), feedback: 'up' } });
  assert.ok(html.indexOf('<time ') > html.lastIndexOf('</button>'));
  const feedback = value => findReactElement(tree, node => node.props['data-ui-action'] === 'conversation.message-actions.feedback'
    && JSON.parse(node.props['data-ui-target']).feedback === value);
  assert.equal(feedback('up').props['aria-pressed'], true);
  feedback('up').props.onClick();
  feedback('down').props.onClick();
  assert.deepEqual(calls, [null, 'down']);
  assert.equal(findReactElement(tree, node => node.type === 'time').props.dateTime, expectedDate.toISOString());
  assert.ok(html.includes('Copied'));
});

test('message actions retain edit restrictions and never invent a missing timestamp', async t => {
  for (const value of [undefined, 'not-a-date']) {
    const { html, tree } = await setup(t, 'user', { canEdit: false, message: { ...message('user'), createdAt: value } });
    assert.doesNotMatch(html, /<time\b|Invalid Date/);
    assert.equal(findReactElement(tree, node => node.props['data-ui-action'] === 'conversation.message-actions.edit').props.disabled, true);
  }
  const { html } = await setup(t, 'user', { message: { ...message('user'), replyToInteraction: { interactionId: 'question:1', prompt: '确认' } } });
  assert.doesNotMatch(html, /data-ui-action="conversation.message-actions.edit"/);
});
