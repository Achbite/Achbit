import type { JsonObject, PreparedToolDescriptor, SessionEvent } from '@achbit/protocol';
import { eventImages } from './visualContext.js';

export const SESSION_DIAGNOSTICS_URI = 'plugin://session-diagnostics@builtin';

export interface SessionReadScope {
  currentId: string;
  history: string[];
  currentViews: string[];
  childWorkdirs: string[];
}

/** Only user messages name historical targets. Tool output, summaries and assistant text do not. */
export function sessionReadScope(currentId: string, events: readonly SessionEvent[]): SessionReadScope {
  const named = new Set<string>();
  let images = false;
  const children = new Set<string>();
  for (const event of events) {
    if (event.type === 'message.committed' && event.payload.role === 'user') {
      // The normal Session identifier is session:<id>. An explicit sessionId="..." also
      // names caller-assigned identifiers supported by the public Session API.
      for (const match of event.payload.content.matchAll(/(?<![\w:./-])(session:[\w:@./-]+)|\bsessionId\s*=\s*"([^"\r\n]+)"/gu)) {
        const id = match[2] ?? match[1]!.replace(/[.:]+$/u, '');
        if (id.length <= 128 && id !== 'session') named.add(id);
      }
    }
    if (!images) images = eventImages(event).length > 0;
    if (event.type === 'agent.task.created' && event.payload.createsAgent) children.add(event.payload.agentSessionId);
  }
  const namedCurrent = named.delete(currentId);
  return { currentId, history: [...named], childWorkdirs: [...children].filter(id => !named.has(id)), currentViews: [
    ...(images ? ['images'] : []), ...(children.size || namedCurrent ? ['resources'] : []),
  ] };
}

export function sessionReadAllowed(scope: SessionReadScope, input: JsonObject): boolean {
  return typeof input.sessionId === 'string' && (scope.history.includes(input.sessionId)
    || input.view === 'resources' && scope.childWorkdirs.includes(input.sessionId)
    || input.sessionId === scope.currentId && scope.currentViews.includes(String(input.view ?? 'summary')));
}

export function sessionReadTool(tool: PreparedToolDescriptor, scope: SessionReadScope): PreparedToolDescriptor[] {
  const { currentId, currentViews, history, childWorkdirs } = scope;
  const targets = [...history, ...childWorkdirs, ...(currentViews.length ? [currentId] : [])];
  if (!targets.length) return [];
  const schema = structuredClone(tool.inputSchema);
  const properties = schema.properties as JsonObject;
  properties.sessionId = { type: 'string', enum: targets };
  const groups: JsonObject[] = [];
  if (history.length) groups.push({ properties: { sessionId: { enum: history } } });
  if (childWorkdirs.length) groups.push({ properties: { sessionId: { enum: childWorkdirs }, view: { const: 'resources' } }, required: ['view'] });
  if (currentViews.length) groups.push({ properties: { sessionId: { const: currentId }, view: { enum: currentViews } }, required: ['view'] });
  if (groups.length > 1) schema.oneOf = groups;
  if (history.length) return [{ ...tool, inputSchema: schema }];

  const views = [...new Set([...currentViews, ...(childWorkdirs.length ? ['resources'] : [])])];
  const fields = new Set(['sessionId', 'view', 'before', 'limit']);
  if (views.includes('images')) fields.add('imageIds');
  if (views.includes('resources')) for (const field of ['resource', 'startLine', 'startByte']) fields.add(field);
  schema.required = ['sessionId', 'view'];
  schema.properties = { ...Object.fromEntries(Object.entries(properties).filter(([name]) => fields.has(name))),
    view: { type: 'string', enum: views } };
  return [{ ...tool, description: 'Read the selected session resources or archived image references.', inputSchema: schema }];
}
