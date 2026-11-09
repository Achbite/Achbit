import test from 'node:test';
import assert from 'node:assert/strict';
import { readConversation, decodeConversationReadQuery } from '../dist/local-agent/conversationRead.js';
import { InMemoryCommandJournal } from './support/memoryJournal.mjs';
import { createSession, readEvents } from './local-agent-fixtures.mjs';

const sessionId = 'session:bounded-read';
test('history cutoff precedes reducer/revisions and applies to summary, exact messages and images', async () => {
  const journal = new InMemoryCommandJournal();
  await createSession(journal, sessionId);
  const reference = { referenceId: 'image:before', workspaceId: 'workspace:archive', logicalPath: 'before.png',
    kind: 'file', displayName: 'Before', mediaType: 'image/png', byteLength: 12 };
  const guidance = { referenceId: 'guide:before', uri: 'skill://before', label: 'Original guidance',
    toolName: 'skill.read', name: 'before' };
  await journal.append({ type: 'message.committed', sessionId, payload: { role: 'user', messageId: 'message:before', content: 'Original task',
    filesystemReferences: [reference], guidanceReferences: [guidance] } });
  const throughSequence = (await readEvents(journal, sessionId)).at(-1).sequence;
  await journal.append({ type: 'message.committed', sessionId, payload: { role: 'user', messageId: 'message:after', content: 'Do not leak the new request',
    filesystemReferences: [{ ...reference, referenceId: 'image:after', logicalPath: 'after.png' }] } });
  const bounded = await readConversation(journal, { sessionId, throughSequence });
  assert.equal(bounded.revision, throughSequence);
  assert.equal(bounded.summary.lastUserMessage.content, 'Original task');
  assert.equal((await readConversation(journal, { sessionId, before: throughSequence })).summary.lastUserMessage.content, 'Do not leak the new request', 'before is a page cursor, never a snapshot');
  const message = await readConversation(journal, { sessionId, throughSequence, view: 'messages', messageId: 'message:before' });
  assert.deepEqual(message.items[0].filesystemReferences, [reference]);
  assert.deepEqual(message.items[0].guidanceReferences, [guidance]);
  assert.deepEqual((await readConversation(journal, { sessionId, throughSequence, view: 'images' })).items.map(item => item.imageId), ['image:before']);
  await assert.rejects(readConversation(journal, { sessionId, throughSequence, view: 'messages', messageId: 'message:after' }), /message_not_found/);
  await assert.rejects(readConversation(journal, { sessionId, throughSequence, view: 'images', imageIds: ['image:after'] }), /session_image_not_found/);
  await journal.append({ type: 'conversation.revised', sessionId, payload: { commandId: 'command:edit', messageId: 'message:before', fromSequence: 2, throughSequence: 3 } });
  assert.equal((await readConversation(journal, { sessionId, throughSequence })).summary.lastUserMessage.content, 'Original task');
  assert.equal((await readConversation(journal, { sessionId })).summary.lastUserMessage, null);
  for (const cutoff of [0, -1, 1.5, '2']) assert.throws(() => decodeConversationReadQuery({ sessionId, throughSequence: cutoff }), /conversation_read_invalid/);
  await assert.rejects(readConversation(journal, { sessionId, throughSequence: 100 }), /conversation_read_boundary_unavailable/);
});
