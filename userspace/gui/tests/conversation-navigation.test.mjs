import test from 'node:test';
import assert from 'node:assert/strict';
import { loadGuiModule } from './gui-projection-contract.mjs';

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
