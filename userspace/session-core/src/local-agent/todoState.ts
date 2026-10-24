import type { NewSessionEvent, TodoItem, TodoListProjection, SessionEvent } from '@achbit/protocol';

export function todoUpdateFact(
  sessionId: string, runId: string, previous: TodoListProjection | null,
  items: readonly TodoItem[], call?: { callId: string; providerCallId: string },
): NewSessionEvent {
  return {
    type: 'todo.updated', sessionId, runId,
    ...(call ? { callId: call.callId } : {}),
    payload: {
      ...(call ? { providerCallId: call.providerCallId } : {}),
      revision: (previous?.revision ?? 0) + 1,
      items: items.map(item => ({ ...item })),
    },
  };
}

export function advanceTodoList(
  todoList: TodoListProjection | null,
  event: SessionEvent,
): TodoListProjection | null {
  if (event.type !== 'todo.updated') return todoList;
  if (event.payload.revision !== (todoList?.revision ?? 0) + 1) throw new Error('todo_revision_invalid');
  if (event.payload.items.some(item => !item.text.trim()
    || !['pending', 'inProgress', 'completed', 'blocked'].includes(item.status))) throw new Error('todo_item_invalid');
  return {
    runId: event.runId,
    revision: event.payload.revision,
    items: event.payload.items.map(item => ({ ...item })),
    sequence: event.sequence,
    updatedAt: event.occurredAt,
  };
}
