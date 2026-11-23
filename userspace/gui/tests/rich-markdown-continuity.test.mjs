import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h } from 'react';
import { renderToStaticMarkup as render } from 'react-dom/server';
import { loadGuiModules } from './gui-projection-contract.mjs';

const component = name => '/src/components/local-agent/' + name + '.tsx';
async function modules(t, ...names) {
  const previous = globalThis.self;
  globalThis.self = {};
  t.after(() => { if (previous === undefined) delete globalThis.self; else globalThis.self = previous; });
  return loadGuiModules(t, names.map(component));
}

test('draft math waits for a closing fence; closed and final invalid math keep their diagnostics', async t => {
  const [{ MarkdownContent }] = await modules(t, 'BufferedMarkdown');
  const md = (source, streaming) => render(h(MarkdownContent, { streaming }, source));
  const tail = '$$\\begin{aligned}\na &= b';
  const prefix = 'Typed $x^2$.\n\n';
  const draft = md(prefix + tail, true);
  assert.match(draft, /<annotation[^>]*>x\^2<\/annotation>/);
  assert.doesNotMatch(draft, /katex-error|ParseError/);
  assert.match(md(prefix + tail + '\n\\end{aligned}$$', true), /class="katex-display"/);
  const broken = '$$\n\\notACommand{x}';
  assert.match(md(broken + '\n$$', true), /katex-error/);
  assert.match(md(broken, false), /katex-error/);
  assert.match(md('```tex\n$$\nplain\n```', true), /<code>\$\$/);
});

test('a decision field reads each formula once without nested controls or changing ordinary code', async t => {
  const [{ MarkdownInline }] = await modules(t, 'BufferedMarkdown');
  const html = render(h(MarkdownInline, null, 'Math **$x^{2}$** and $y_1$, `cost $z$` [more](https://example.test)'));
  assert.equal(html, '<span class="conversation-markdown-inline">Math <strong>x^{2}</strong> and y_1, <code>cost $z$</code> more</span>');
});

test('display math actions use the original block and nested node offsets across streaming, commit and remount', async t => {
  const [{ MarkdownContent }, { RichContentScope }] = await modules(t, 'BufferedMarkdown', 'RichContentIdentity');
  const scope = { sessionId: 'session:math', rowKey: 'stream:math', contentKey: 'body' };
  const block = '$$\nx^2\n$$', fence = '```math\nx^2\n```';
  const nested = [block, fence].join('\n\n').split('\n').map(line => '> ' + line).join('\n');
  const source = [block, fence, nested, 'Inline $x^2$.'].join('\n\n');
  const targets = (streaming, value = scope) => {
    const html = render(h(RichContentScope.Provider, { value }, h(MarkdownContent, { streaming }, source)));
    assert.equal((html.match(/class="katex-display"/g) ?? []).length, 4);
    return [...html.matchAll(/<button\b[^>]*>/g)].filter(([tag]) => tag.includes('data-ui-action="conversation.math.save"'))
      .map(([tag]) => JSON.parse(/data-ui-target="([^"]+)"/.exec(tag)[1].replaceAll('&quot;', '"')));
  };
  const nestedStart = source.indexOf('> $$');
  const expected = [[0, 0], [source.indexOf(fence), 0], [nestedStart, 2], [nestedStart, source.indexOf('```math', nestedStart) - nestedStart]]
    .map(([blockKey, nodeOffset]) => ({ ...scope, blockKey: String(blockKey), nodeOffset: String(nodeOffset) }));
  assert.deepEqual(targets(true), expected);
  assert.deepEqual(targets(false), expected);
  assert.deepEqual(targets(false, null), [], 'unscoped content cannot claim actions belonging to a session');
});

test('oversize Mermaid has a terminal explanation, no image and no enabled diagram export; source remains available', async t => {
  const [{ MermaidContent }, { RichContentScope }] = await modules(t, 'MermaidContent', 'RichContentIdentity');
  const source = 'flowchart LR\nA[Start] --> B[End]\n' + ' '.repeat(50000);
  const scope = { sessionId: 'session:diagram', rowKey: 'stream:diagram', contentKey: 'body' };
  const html = render(h(RichContentScope.Provider, { value: scope }, h(MermaidContent, { source })));
  assert.match(html, /原图未渲染|original diagram was not rendered/i);
  assert.doesNotMatch(html, /data-conversation-pending|<img\b/);
  const buttons = [...html.matchAll(/<button\b[^>]*>/g)].map(([tag]) => tag);
  assert.match(buttons.find(tag => tag.includes('conversation.diagram.save')) ?? '', / disabled=""/);
  assert.doesNotMatch(buttons.find(tag => tag.includes('conversation.diagram.source')) ?? 'disabled=""', / disabled=/);
});
