import test from 'node:test';
import assert from 'node:assert/strict';
import { createElement as h, Fragment } from 'react';
import { renderToStaticMarkup as render } from 'react-dom/server';
import { loadGuiModules } from './gui-projection-contract.mjs';

async function components(t) {
  const prior = globalThis.self;
  globalThis.self = {};
  t.after(() => { if (prior === undefined) delete globalThis.self; else globalThis.self = prior; });
  return (await loadGuiModules(t, ['/src/components/local-agent/BufferedMarkdown.tsx']))[0];
}

test('punctuation ends the CJK label without stealing the next emphasis; source literals stay literal', async t => {
  const { MarkdownContent, ReadingMarkdown } = await components(t);
  const source = '### 公共视觉规范\n\n- **字体与对比度：**页面标题，从 **4.27:1** 到 **5.50:1**。\n- **阴影与层级：**普通分组。\n- **按钮与容器：**选中。布局根据**实际窗格宽度**换行。\n\n使用**「推荐」**设置；*注意：*正文。\n\n`**代码：**` 和 \\*\\*字面量\\*\\*；ASCII **Label:**next。\n\n```text\n**保留：**正文\n```';
  for (const html of [true, false].map(streaming => render(h(MarkdownContent, { streaming }, source))).concat(render(h(ReadingMarkdown, { text: source })))) {
    assert.match(html, /<h3>公共视觉规范<\/h3>/);
    assert.match(html, /<li><strong>字体与对比度：<\/strong>页面标题，从 <strong>4.27:1<\/strong> 到 <strong>5.50:1<\/strong>/);
    assert.match(html, /<li><strong>阴影与层级：<\/strong>普通分组/);
    assert.match(html, /<li><strong>按钮与容器：<\/strong>选中。布局根据<strong>实际窗格宽度<\/strong>换行/);
    assert.match(html, /使用<strong>「推荐」<\/strong>设置；<em>注意：<\/em>正文/);
    assert.match(html, /<code>\*\*代码：\*\*<\/code> 和 \*\*字面量\*\*；ASCII \*\*Label:\*\*next/);
    assert.match(html, /<code(?: [^>]*)?>\*\*保留：\*\*正文/);
  }
});

test('a compact field keeps paragraph boundaries and image alternatives but mounts no links or images', async t => {
  const { MarkdownInline } = await components(t);
  const html = render(h(MarkdownInline, null, '第一段\n\n第二段含 [![图示说明](fig.png)](more) 和 **重点**。'));
  assert.match(html, /第一段\s+第二段含 图示说明 和 <strong>重点<\/strong>。/);
  assert.doesNotMatch(html, /<(?:a|img|button|p)\b/);
});

test('identical cached documents have distinct footnotes, matching return links and label IDs per mount', async t => {
  const { MarkdownContent, ReadingMarkdown } = await components(t);
  const src = '首处[^same]、再次引用[^same]。\n\n[^same]: 注释。';
  const html = render(h(Fragment, null, h(MarkdownContent, null, src), h(MarkdownContent, null, src), h(ReadingMarkdown, {text:src})));
  const ids = [...html.matchAll(/\bid="([^"]+)"/g)].map(m => m[1]);
  assert.equal(new Set(ids).size, ids.length);
  const copies = html.split('<div class="conversation-markdown">').slice(1);
  assert.equal(copies.length, 3);
  assert.doesNotMatch(copies[2], /<a\b/, 'opening-page content has no live links');
  for (const block of copies.slice(0, 2)) {
    const targets = [...block.matchAll(/(?:href="#|aria-describedby=")([^"]+)"/g)].map(m=>m[1]);
    assert.equal(targets.length, 6, 'each call and return is linked; each call has an accessible description');
    for (const id of targets) assert.ok(block.includes(`id="${id}"`), id);
  }
});
