import test from 'node:test';
import assert from 'node:assert/strict';
import { decodeConversationReadQuery, readConversation } from '../dist/local-agent/conversationRead.js';

const sessionId = 'session:read-pagination';
const encoder = new TextEncoder();

function fixture(items) {
  const events = [{ type: 'session.created', payload: { displayTitle: 'Read pagination', workspaceBindings: [] } }, ...items]
    .map((event, index) => ({ schemaVersion: 'achbit.session-event.v5', eventId: `event:${index + 1}`, sessionId,
      sequence: index + 1, occurredAt: '2026-10-24T00:00:00.000Z', ...event }));
  return { events, journal: { async *read(id) { assert.equal(id, sessionId); yield* events; } } };
}

async function reconstruct(journal, query, select, original) {
  let offset = 0, joined = '', pages = 0;
  do {
    const page = await readConversation(journal, decodeConversationReadQuery({ sessionId, ...query, offset }));
    assert.ok(encoder.encode(JSON.stringify(page)).byteLength <= 48 * 1024);
    const chunk = select(page.items[0]);
    assert.equal(chunk.offset, offset);
    assert.equal(chunk.totalCharacters, original.length);
    assert.equal(chunk.totalBytes, encoder.encode(original).byteLength);
    assert.equal(chunk.content.isWellFormed(), true, 'a page never splits a Unicode surrogate pair');
    assert.equal(chunk.content, original.slice(offset, offset + chunk.content.length));
    joined += chunk.content;
    pages++;
    if (chunk.nextOffset !== null) {
      assert.equal(chunk.truncated, true);
      assert.equal(chunk.nextOffset, offset + chunk.content.length);
      assert.ok(chunk.nextOffset > offset);
    } else assert.equal(chunk.truncated, false);
    offset = chunk.nextOffset;
  } while (offset !== null);
  assert.equal(joined, original, 'all original text remains readable after the first excerpt');
  assert.ok(pages > 1, 'the fixture exercises actual continuation');
}

test('exact message chunks reconstruct long user instructions while list pages retain their excerpts', async () => {
  const content = '原始用户约束🙂 "quoted" \\ path\n'.repeat(1600) + '最后的限制：不要删除文件。';
  const { journal, events } = fixture([
    { type: 'message.committed', payload: { messageId: 'message:old', role: 'user', content: 'Earlier task' } },
    { type: 'message.committed', payload: { messageId: 'message:long', role: 'user', content } },
  ]);
  const originalEvents = structuredClone(events);
  const listing = await readConversation(journal, { sessionId, view: 'messages', limit: 1 });
  assert.equal(listing.items[0].messageId, 'message:long');
  assert.equal(listing.items[0].truncated, true);
  assert.equal(listing.items[0].offset, undefined, 'ordinary list excerpts keep their existing shape');
  const earlier = await readConversation(journal, { sessionId, view: 'messages', before: listing.nextBefore, limit: 1 });
  assert.equal(earlier.items[0].content, 'Earlier task');
  await reconstruct(journal, { view: 'messages', messageId: 'message:long' }, item => item, content);
  assert.deepEqual(events, originalEvents, 'reading does not alter archived user input');
});

test('exact tool record fields each continue beyond their original excerpt without losing failed evidence', async () => {
  const record = { recordId: 'record:long', toolName: 'computer.control', outcome: 'failed',
    input: { action: 'observe', detail: '输入🙂\\\n'.repeat(1600) },
    output: { accessibility: { complete: false, errors: Array.from({ length: 1700 }, (_, index) => ({
      depth: index % 4, message: 'Could not read AXChildren (AX error -25202)',
    })) } },
    error: { code: 'observation_failed', message: '保留原始错误🙂\n'.repeat(500) } };
  const { journal } = fixture([{ type: 'tool.completed', runId: 'run:read', callId: 'call:observe', payload: { record } }]);
  const listing = await readConversation(journal, { sessionId, view: 'tools' });
  assert.equal(listing.items[0].output.truncated, true);
  assert.equal(listing.items[0].output.offset, undefined);
  for (const field of ['input', 'output', 'error']) {
    await reconstruct(journal, { view: 'tools', recordId: record.recordId }, item => {
      assert.equal(item.outcome, 'failed');
      return item[field];
    }, JSON.stringify(record[field]));
  }
});

test('record fields expose actual Unicode boundaries and exhausted fields do not invent content', async () => {
  const input = { text: 'a🙂b' }, output = { text: 'x'.repeat(20000) };
  const inputText = JSON.stringify(input), split = inputText.indexOf('🙂') + 1;
  const { journal } = fixture([{ type: 'tool.completed', payload: { record: {
    recordId: 'record:unicode', toolName: 'fs.read', outcome: 'completed', input, output,
  } } }]);
  const page = await readConversation(journal, { sessionId, view: 'tools', recordId: 'record:unicode', offset: split });
  assert.equal(page.items[0].input.offset, split - 1);
  assert.equal(page.items[0].input.content, inputText.slice(split - 1));
  assert.equal(page.items[0].input.content.isWellFormed(), true);
  const later = await readConversation(journal, { sessionId, view: 'tools', recordId: 'record:unicode', offset: 15000 });
  assert.equal(later.items[0].input.offset, inputText.length);
  assert.equal(later.items[0].input.content, '');
  assert.equal(later.items[0].input.nextOffset, null);
  assert.equal(later.items[0].error, null);
  assert.equal(later.items[0].output.offset, 15000);
  assert.ok(later.items[0].output.content.length > 0);
});

test('message and tool cursors require a valid exact selector and missing records remain errors', async () => {
  for (const query of [
    { view: 'messages', offset: 0 }, { view: 'tools', offset: 0 },
    { view: 'messages', messageId: 12 }, { view: 'tools', messageId: 'message:x' },
    { view: 'messages', messageId: 'message:x', offset: -1 },
    { view: 'messages', messageId: 'message:x', offset: 0.5 },
    { view: 'context', providerRequestId: 'request:x', offset: 0 },
  ]) assert.throws(() => decodeConversationReadQuery({ sessionId, ...query }), /conversation_read_invalid/);
  for (const query of [
    { view: 'messages', messageId: 'message:x', offset: 0 },
    { view: 'tools', recordId: 'record:x', offset: 0 },
    { view: 'reasoning', providerRequestId: 'request:x', offset: 0 },
  ]) assert.deepEqual(decodeConversationReadQuery({ sessionId, ...query }), { sessionId, ...query });
  const { journal } = fixture([]);
  await assert.rejects(readConversation(journal, { sessionId, view: 'messages', messageId: 'message:missing' }), /message_not_found/);
  await assert.rejects(readConversation(journal, { sessionId, view: 'tools', recordId: 'record:missing' }), /tool_record_not_found/);
});

test('one oversized context detail cannot bypass the page budget and small exact review inputs stay intact', async () => {
  const smallInput = { instructions: 'Review this operation.', content: '{"operation":"read"}' };
  const largeInput = { instructions: 'Review this operation.', content: '归档材料🙂 "quoted" \\'.repeat(15000) };
  const { journal } = fixture([smallInput, largeInput].map((reviewInput, index) => ({ type: 'context.composed', runId: 'run:read', payload: {
    providerRequestId: `request:${index}`, purpose: 'approvalReview', responseConstraint: 'answerOnly',
    dynamicInstructionBytes: 0, messages: [], tools: [], workspaceBindings: [], partitions: [], reviewInput,
  } })));
  const small = await readConversation(journal, { sessionId, view: 'context', providerRequestId: 'request:0' });
  assert.deepEqual(small.items[0].reviewInput, smallInput);
  assert.equal(small.items[0].detailTruncated, undefined);
  const large = await readConversation(journal, { sessionId, view: 'context', providerRequestId: 'request:1' });
  assert.ok(encoder.encode(JSON.stringify(large)).byteLength <= 48 * 1024);
  assert.equal(large.items[0].providerRequestId, 'request:1');
  assert.equal(large.items[0].detailTruncated, true);
  assert.equal(large.items[0].data.truncated, true);
  assert.equal(large.items[0].data.content.isWellFormed(), true);
  assert.equal(large.items[0].reviewInput, undefined, 'a prefix is never exposed as the complete original review input');
  const listing = await readConversation(journal, { sessionId, view: 'context' });
  assert.ok(listing.items.every(item => item.reviewInput === undefined));
  assert.ok(encoder.encode(JSON.stringify(listing)).byteLength <= 48 * 1024);
});
