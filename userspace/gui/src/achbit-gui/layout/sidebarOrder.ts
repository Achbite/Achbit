import type { ConversationProject, ConversationSessionSummary, UserSettingValue } from '@achbit/protocol';

export const SIDEBAR_ORDER_SETTING = 'gui.sidebarOrder';

export interface SidebarOrder {
  projects: string[];
  sessions: string[];
}

export type SidebarDragItem =
  | { kind: 'project'; id: string }
  | { kind: 'session'; id: string; projectId?: string };
export type SidebarDropEdge = 'before' | 'after';

export function readSidebarOrder(value: UserSettingValue): SidebarOrder {
  if (typeof value !== 'string') throw new Error('gui.sidebarOrder: expected JSON text');
  const order = JSON.parse(value);
  const ids = (value: unknown): value is string[] => Array.isArray(value)
    && value.every((id) => typeof id === 'string' && id.length > 0);
  if (!order || !ids(order.projects) || !ids(order.sessions)) {
    throw new Error('gui.sidebarOrder: expected project and session ID lists');
  }
  return order;
}

export function orderSidebarItems<T extends { id: string }>(items: T[], ids: string[]): T[] {
  const positions = new Map(ids.map((id, index) => [id, index]));
  // New entries stay visible at the top; activity updates cannot move saved entries.
  return [...items].sort((left, right) => (
    (positions.get(left.id) ?? -1) - (positions.get(right.id) ?? -1)
  ));
}

export function canDropSidebarItem(source: SidebarDragItem, target: SidebarDragItem): boolean {
  return source.id !== target.id && source.kind === target.kind
    && (source.kind === 'project' || (target.kind === 'session' && source.projectId === target.projectId));
}

export function moveSidebarItem(
  order: SidebarOrder,
  projects: ConversationProject[],
  sessions: ConversationSessionSummary[],
  source: SidebarDragItem,
  target: SidebarDragItem,
  edge: SidebarDropEdge,
): SidebarOrder | null {
  if (!canDropSidebarItem(source, target)) return null;
  const key = source.kind === 'project' ? 'projects' : 'sessions';
  const items = source.kind === 'project' ? projects : sessions;
  if (source.kind === 'session') {
    const from = sessions.find((session) => session.id === source.id);
    const to = sessions.find((session) => session.id === target.id);
    if (!from || !to || from.projectId !== to.projectId || from.projectId !== source.projectId) return null;
  }
  const ids = orderSidebarItems<{ id: string }>(items, order[key]).map((item) => item.id);
  if (!ids.includes(source.id) || !ids.includes(target.id)) return null;
  const next = ids.filter((id) => id !== source.id);
  next.splice(next.indexOf(target.id) + (edge === 'after' ? 1 : 0), 0, source.id);
  if (next.every((id, index) => id === ids[index])) return null;
  return { ...order, [key]: next };
}
