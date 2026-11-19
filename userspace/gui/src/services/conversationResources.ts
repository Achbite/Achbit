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

async function resourceResponseError(response: Response, operation: string): Promise<Error> {
  const detail = await response.text();
  try {
    const body = JSON.parse(detail) as { message?: string; error?: string };
    if (body?.message || body?.error) return new Error(body.message || body.error);
  } catch { /* Keep plain-text Host and proxy errors. */ }
  return new Error(operation + ':HTTP ' + response.status + (detail ? ' ' + detail : ''));
}

export async function readResourceBlob(sessionId: string, resource: ResourceReference, format: 'image' | 'document', signal?: AbortSignal): Promise<Blob> {
  const response = await fetch(endpoint(sessionId, 'read'), { method: 'POST', signal,
    headers: { 'Content-Type': 'application/json', ...getHostConnectionHeaders() }, body: JSON.stringify({ ...resource, format }) });
  const mediaType = response.headers.get('content-type')?.split(';', 1)[0].trim() ?? '';
  const validMediaType = format === 'image' ? mediaType.startsWith('image/') : ['application/pdf', 'text/html', 'text/markdown'].includes(mediaType);
  if (!response.ok || !validMediaType) {
    throw await resourceResponseError(response, 'resource_read_failed');
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
    throw await resourceResponseError(response, 'resource_watch_failed');
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
