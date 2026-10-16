import test from 'node:test';
import assert from 'node:assert/strict';
import { loadGuiModule } from './gui-projection-contract.mjs';

test('long conversation reading and navigation measure logarithmically and share the anchor catalogue', async t => {
  const { ConversationAnchors, firstReadingAnchor } = await loadGuiModule(t, '/src/components/local-agent/conversationAnchors.ts');
  const { activeConversationAnchor } = await loadGuiModule(t, '/src/components/local-agent/conversationNavigationPosition.ts');
  let queries = 0, measurements = 0;
  const nodes = Array.from({ length: 4096 }, (_, i) => ({
    dataset: { conversationAnchor: `row:${i}` }, hidden: false,
    getBoundingClientRect() { measurements++; return { top: i * 100, bottom: (i + 1) * 100 }; },
  }));
  const body = { querySelectorAll() { queries++; return nodes; } };
  const index = new ConversationAnchors();
  const catalogue = index.read(body);
  assert.equal(firstReadingAnchor(catalogue.nodes, 300_010), nodes[3000]);
  const navigation = index.read(body).nodes.map(node => ({
    key: node.dataset.conversationAnchor, get top() { return node.getBoundingClientRect().top; },
  }));
  assert.equal(activeConversationAnchor(navigation, 300_040), 'row:3000');
  assert.equal(queries, 1, 'both consumers use the same catalogue without a second DOM scan');
  assert.ok(measurements <= 26, `4096 anchors took ${measurements} geometry reads`);
  assert.equal(firstReadingAnchor(catalogue.nodes, 409_600), undefined);
});

test('anchor catalogue refreshes after transcript commits and when the scroll body changes', async t => {
  const { ConversationAnchors } = await loadGuiModule(t, '/src/components/local-agent/conversationAnchors.ts');
  const first = { dataset: { conversationAnchor: 'old' }, hidden: false };
  const second = { dataset: { conversationAnchor: 'new' }, hidden: false };
  let rows = [first];
  const body = { querySelectorAll: () => rows };
  const index = new ConversationAnchors();
  assert.deepEqual(index.read(body).nodes, [first]);
  rows = [second, first]; first.hidden = true;
  index.invalidate();
  assert.deepEqual(index.read(body).nodes, [second]);
  assert.equal(index.read(body).byKey.get('old'), first, 'hidden anchors remain addressable for round navigation');
  assert.equal(index.read({ querySelectorAll: () => [] }).byKey.size, 0);
});

test('bottom selects the latest message without forcing its title to the top', async t => {
  const { activeConversationAnchor: active } = await loadGuiModule(t, '/src/components/local-agent/conversationNavigationPosition.ts');
  const anchors = [{ key: 'old', top: -200 }, { key: 'latest', top: 350 }];
  const view = { scrollTop: 400, scrollHeight: 1000, clientHeight: 600, latestKey: 'latest' };
  assert.equal(active(anchors, 40, view), 'latest');
  assert.equal(active(anchors, 40, { ...view, scrollTop: 399 }), 'latest', 'fractional end positions count');
  assert.equal(active(anchors, 40, { ...view, scrollTop: 380 }), 'old', 'reading history still uses the reading line');
  assert.equal(active(anchors, 40, { ...view, scrollHeight: 1100 }), 'old', 'new content below is not treated as already read');
  assert.equal(active(anchors, 40, { ...view, scrollTop: 500, scrollHeight: 1100 }), 'latest');
});

test('short layouts and virtualized latest rows use the catalog end; hidden viewports do not', async t => {
  const { activeConversationAnchor: active } = await loadGuiModule(t, '/src/components/local-agent/conversationNavigationPosition.ts');
  const anchors = [{ key: 'old', top: 80 }];
  assert.equal(active(anchors, 40, { scrollTop: 0, scrollHeight: 500, clientHeight: 500, latestKey: 'latest' }), 'latest');
  assert.equal(active([], 40, { scrollTop: 400, scrollHeight: 1000, clientHeight: 600, latestKey: 'latest' }), 'latest');
  assert.equal(active(anchors, 40, { scrollTop: 0, scrollHeight: 0, clientHeight: 0, latestKey: 'latest' }), 'old');
  assert.equal(active([], 40), undefined);
});
