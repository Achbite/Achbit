import { EventSourceParserStream } from 'eventsource-parser/stream';
import { createResourceSubscriptions } from './resourceSubscriptions';
import { getHostConnectionHeaders, getKernelApiBase } from './hostTarget';
import { request, type ConversationResourceReadResult } from './localAgentApi';

export type ResourceReference = ({ workspaceId: string } | { fileGrant: { authorityId: string; access: 'read' | 'write'; index: number } } | { change: { recordId: string; index: number } }) & { logicalPath: string };
export interface ResourceEntry {
  name: string;
  resource: ResourceReference;
  kind: 'directory' | 'file' | 'unavailable';
  category?: 'project' | 'reference' | 'attachment' | 'session' | 'resource' | 'agent';
  error?: string;
}
const endpoint = (sessionId: string, action: string) => `${getKernelApiBase()}/conversation/sessions/${encodeURIComponent(sessionId)}/resources/${action}`;
export const resourceKey = (resource: ResourceReference) => JSON.stringify('workspaceId' in resource
  ? [resource.workspaceId, resource.logicalPath]
  : 'change' in resource ? ['change', resource.change.recordId, resource.change.index]
  : [resource.fileGrant.authorityId, resource.fileGrant.access, resource.fileGrant.index, resource.logicalPath]);

export const listResourceRoots = (sessionId: string, signal?: AbortSignal) => request<ResourceEntry[]>(endpoint(sessionId, 'roots'), { signal });
export const listResourceDirectory = (sessionId: string, resource: ResourceReference, signal?: AbortSignal) => request<ResourceEntry[]>(endpoint(sessionId, 'list'), { method: 'POST', body: JSON.stringify(resource), signal });
export const resolveResourceReference = (sessionId: string, resource: ResourceReference) => request<{ path: string; kind: 'file' | 'directory' }>(endpoint(sessionId, 'read'), { method: 'POST', body: JSON.stringify({ ...resource, format: 'path' }) });

export async function readResourceReference(sessionId: string, resource: ResourceReference, signal?: AbortSignal, startByte?: number, startLine?: number): Promise<ConversationResourceReadResult> {
  const value = await request<ConversationResourceReadResult>(endpoint(sessionId, 'read'), { method: 'POST', signal, body: JSON.stringify({ ...resource, startByte, startLine }) });
  if (typeof value.content !== 'string' || typeof value.logicalPath !== 'string' || !Number.isSafeInteger(value.sizeBytes)
    || !Number.isSafeInteger(value.startLine) || !Number.isSafeInteger(value.endLine)) throw new Error('conversation_resource_response_invalid');
  return value;
}

export async function readResourceBlob(sessionId: string, resource: ResourceReference, format: 'image' | 'document', signal?: AbortSignal): Promise<Blob> {
  const response = await fetch(endpoint(sessionId, 'read'), { method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', ...getHostConnectionHeaders() }, body: JSON.stringify({ ...resource, format }) });
  const mediaType = response.headers.get('content-type')?.split(';', 1)[0].trim() ?? '';
  const validMediaType = format === 'image' ? mediaType.startsWith('image/') : ['application/pdf', 'text/html', 'text/markdown'].includes(mediaType);
  if (!response.ok || !validMediaType) {
    const detail = await response.text();
    let message = detail;
    try {
      const error = JSON.parse(detail) as { message?: string; error?: string };
      message = error.message ?? error.error ?? detail;
    } catch { /* Preserve non-JSON transport errors. */ }
    throw new Error(message || `resource_read_failed:HTTP ${response.status}`);
  }
  return response.blob();
}

/** Logical subscriptions share one physical Session stream; abort releases only this caller. */
export const watchResources = createResourceSubscriptions(resourceKey, watchResourceStream);

async function watchResourceStream(sessionId: string, resources: ResourceReference[], signal: AbortSignal,
  ready: (indices?: number[]) => void, changed: (indices: number[]) => void,
  unavailable: (indices: number[], error: unknown) => void): Promise<void> {
  const response = await fetch(endpoint(sessionId, 'watch'), { method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', ...getHostConnectionHeaders() }, body: JSON.stringify({ resources }) });
  if (!response.ok || !response.headers.get('content-type')?.startsWith('text/event-stream') || !response.body) {
    const error = await response.json() as { message?: string; error?: string };
    throw new Error(error.message ?? error.error ?? `resource_watch_failed:HTTP ${response.status}`);
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).pipeThrough(new EventSourceParserStream()).getReader();
  try {
    while (!signal.aborted) {
      const result = await reader.read();
      if (result.done) throw new Error('resource_watch_closed');
      const event = result.value;
      if (event.event && ['ready', 'change', 'resourceError'].includes(event.event)) {
        const data = JSON.parse(event.data) as { indices: number[]; error?: { message?: string; error?: string } };
        const { indices } = data;
        if (!Array.isArray(indices) || indices.some(index => !Number.isSafeInteger(index) || index < 0 || index >= resources.length)) throw new Error('resource_watch_indices_invalid');
        if (event.event === 'ready') ready(indices);
        else if (event.event === 'change') changed(indices);
        else unavailable(indices, new Error(data.error?.message ?? data.error?.error ?? 'resource_watch_failed'));
      }
      else if (event.event === 'error') throw new Error((JSON.parse(event.data) as { message: string }).message);
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
}
