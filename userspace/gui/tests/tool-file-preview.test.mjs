import test from 'node:test';
import assert from 'node:assert/strict';
import { Children, createElement, isValidElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { findReactElement, loadGuiModule, loadGuiModules } from './gui-projection-contract.mjs';

// Display names must not become resource identities, including duplicate basenames.
test('file links show basenames while titles and Reader navigation retain exact paths', async t => {
  const [{ FileChanges }, { FileReadPreview }, { ToolActivityGroup }, { ConversationSessionScope }, { ConversationVirtualRow }, { READER_OPEN_EVENT }] = await loadGuiModules(t, [
    '/src/components/local-agent/FileChanges.tsx', '/src/components/local-agent/FileReadPreview.tsx',
    '/src/components/local-agent/ToolActivityDetails.tsx', '/src/components/local-agent/ConversationSessionScope.tsx',
    '/src/components/local-agent/ConversationVirtualRow.tsx', '/src/components/local-agent/readerState.ts',
  ]);
  const previousWindow = globalThis.window;
  globalThis.window = new EventTarget();
  t.after(() => { globalThis.window = previousWindow; });
  const requests = [];
  window.addEventListener(READER_OPEN_EVENT, event => requests.push(event.detail));
  const sessionId = 'session:file-labels';
  const capture = (Component, props, expanded = false) => {
    let tree;
    function Probe() { tree = Component(props); return tree; }
    const html = renderToStaticMarkup(createElement(ConversationSessionScope.Provider, { value: sessionId },
      createElement(ConversationVirtualRow, { rowKey: 'files', eager: true,
        virtualizer: { layout: () => ({ state: new Map([['tool-group:expanded', expanded]]) }) },
        children: () => createElement(Probe),
      })));
    return { html, tree };
  };
  const activity = (path, index, kind = 'modify') => ({
    activityId: `tool:label:${index}`, kind: 'tool', status: 'completed', sequence: index,
    label: kind === 'delete' ? 'fs.delete' : 'fs.edit',
    tool: { operation: kind === 'delete' ? 'fs.delete' : 'fs.edit', resources: [], recordId: `record:label:${index}`,
      fileChanges: [{ workspaceId: `workspace:${index}`, path, kind, before: { exists: true }, after: { exists: kind !== 'delete' } }] },
  });
  const paths = ['src/deep/components/测试 文件.tsx', 'other/components/测试 文件.tsx', 'C:\\project\\deep\\windows-file.ts'];
  const names = ['测试 文件.tsx', '测试 文件.tsx', 'windows-file.ts'];
  const activities = paths.map((path, index) => activity(path, index, index === 2 ? 'delete' : 'modify'));
  for (const compact of [false, true]) {
    const list = capture(FileChanges, { activities, compact }).tree;
    paths.forEach((path, index) => {
      const link = findReactElement(list, node => node.type === 'button' && node.props.title === path);
      assert.equal(Children.toArray(link.props.children)[0].props.children, names[index]);
      link.props.onClick();
      const request = requests.at(-1);
      assert.equal(request.sessionId, sessionId);
      assert.equal(request.target.kind, 'diff');
      assert.equal(request.target.file.path, path);
      assert.equal(request.target.file.changes[0].change.workspaceId, `workspace:${index}`);
    });
  }
  activities.forEach((item, index) => {
    const inline = capture(FileChanges, { activities: [item], inlineDiff: true }).tree;
    const entry = Children.toArray(inline.props.children).find(isValidElement);
    const link = findReactElement(capture(entry.type, entry.props).tree, node => node.type === 'button');
    assert.equal(link.props.title, paths[index]);
    assert.equal(Children.toArray(link.props.children)[0].props.children, names[index]);
    link.props.onClick();
    if (index === 2) assert.equal(requests.at(-1).target.file.path, paths[index]);
    else assert.deepEqual(requests.at(-1), { sessionId, target: { kind: 'workspace', workspaceId: `workspace:${index}`, logicalPath: paths[index] } });
    const group = capture(ToolActivityGroup, { activities: [item], language: 'en-US', onExpand() {}, onOpenWorkspaceResource() {} }, true).tree;
    const toolEntry = findReactElement(group, node => node.props.activity === item);
    const heading = findReactElement(capture(toolEntry.type, toolEntry.props).tree, node => node.type === 'button' && node.props.title === paths[index]);
    assert.match(renderToStaticMarkup(heading), new RegExp(`<span>${names[index]}</span>`));
    heading.props.onClick();
    assert.equal(requests.at(-1).target.kind, index === 2 ? 'diff' : 'workspace');
  });
  const read = findReactElement(capture(FileReadPreview, { sessionId, workspaceId: 'workspace:read', path: paths[0], language: 'en-US' }).tree, node => node.type === 'button');
  assert.equal(read.props.title, paths[0]);
  assert.equal(Children.toArray(read.props.children)[0].props.children, names[0]);
  read.props.onClick();
  assert.deepEqual(requests.at(-1), { sessionId, target: { kind: 'workspace', workspaceId: 'workspace:read', logicalPath: paths[0] } });
});

test('inline diff keeps only nearby changes, correct line numbers and complete counts in a bounded preview', async t => {
  const { calculateChangePreview } = await loadGuiModule(t, '/src/components/local-agent/fileChangeLineCounts.ts');
  const lines = Array.from({ length: 200 }, (_, i) => `line ${i + 1}\n`);
  const after = [...lines]; after[20] = 'changed 21\n'; after[170] = 'changed 171\n';
  const preview = calculateChangePreview(lines.join(''), after.join(''));
  assert.deepEqual(preview.counts, { added: 2, removed: 2 });
  assert.deepEqual(preview.hunks.map(h => [h.oldStart, h.newStart]), [[19, 19], [169, 169]]);
  assert.deepEqual(preview.hunks[0].lines, [' line 19', ' line 20', '-line 21', '+changed 21', ' line 22', ' line 23']);
  assert.equal(preview.truncated, false);
  assert.equal(preview.hunks.flatMap(h => h.lines).some(line => line === ' line 100'), false);
  for (const [before, after, counts] of [[null, lines.join(''), { added: 200, removed: 0 }], [lines.join(''), null, { added: 0, removed: 200 }]]) {
    const large = calculateChangePreview(before, after);
    assert.equal(large.truncated, true);
    assert.equal(large.hunks.flatMap(h => h.lines).length, 80);
    assert.deepEqual(large.counts, counts);
  }
  const longLine = calculateChangePreview(null, 'x'.repeat(50_000));
  assert.equal(longLine.truncated, true);
  assert.ok(longLine.hunks[0].lines[0].length <= 16_000);
  assert.deepEqual(calculateChangePreview(lines.join(''), lines.join('')).hunks, []);
});

test('nested tool disclosures stay anchored through loading and collapse without entering the ordered reading rows', async t => {
  const { useConversationViewport } = await loadGuiModule(t, '/src/components/local-agent/useConversationViewport.ts');
  const { ConversationAnchors } = await loadGuiModule(t, '/src/components/local-agent/conversationAnchors.ts');
  const previousWindow = globalThis.window;
  const frames = new Map(); let sequence = 0;
  globalThis.window = { requestAnimationFrame(fn) { frames.set(++sequence, fn); return sequence; }, cancelAnimationFrame(id) { frames.delete(id); } };
  t.after(() => { globalThis.window = previousWindow; });
  const flush = () => { const pending = [...frames.values()]; frames.clear(); pending.forEach(fn => fn()); };
  let viewport;
  function Probe() {
    viewport = useConversationViewport({ sessionId: 'tools', projection: { sessionId: 'tools' }, loading: false,
      presentationLayoutKey: '', assistantDraftLayoutKey: '', timelineExtentKey: '' });
    return null;
  }
  renderToStaticMarkup(createElement(Probe));
  let height = 60, toggleTop = 600, nodes;
  const body = { scrollTop: 500, scrollHeight: 2400, clientHeight: 500,
    getBoundingClientRect: () => ({ top: 0 }), querySelectorAll: () => nodes };
  const row = { dataset: { conversationAnchor: 'tools-row' }, hidden: false,
    getBoundingClientRect: () => ({ top: 400 - body.scrollTop, bottom: 600 + height - body.scrollTop }) };
  const toggle = { dataset: { conversationDisclosure: 'tool:read' }, hidden: false,
    getBoundingClientRect: () => ({ top: toggleTop - body.scrollTop, bottom: toggleTop + 24 - body.scrollTop }) };
  nodes = [row]; viewport.bodyRef.current = body; viewport.setLatestFollowMode(false);
  nodes = [row, toggle]; // Tool headings mount after the group expands.
  viewport.anchorDisclosure(toggle);
  height += 320; body.scrollHeight += 320;
  viewport.preserveReadingPosition(); flush();
  assert.equal(toggle.getBoundingClientRect().top, 100);
  toggleTop += 30; body.scrollHeight += 30; // Async content above the clicked tool.
  viewport.preserveReadingPosition(); flush();
  assert.equal(toggle.getBoundingClientRect().top, 100);
  viewport.anchorDisclosure(toggle); height -= 320; body.scrollHeight -= 320;
  viewport.preserveReadingPosition(); flush();
  assert.equal(toggle.getBoundingClientRect().top, 100);
  const anchors = new ConversationAnchors().read(body);
  assert.deepEqual(anchors.nodes, [row]);
  assert.equal(anchors.byKey.get('tool:read'), toggle);
  body.scrollTop += 80; viewport.bodyHandlers.onScroll({ target: body, currentTarget: body });
  viewport.preserveReadingPosition(); flush();
  assert.equal(body.scrollTop, 610, 'reader movement replaces the click anchor');
});
