import type {
  ApiResponse,
  BrowsePathResult,
  GetUserSettingsResult,
  HealthStatus,
  InitialLocations,
  LlmProbeRequest,
  LlmProbeResult,
  LlmProfilesResult,
  OpenWorkspaceResult,
  PatchLlmProfilesRequest,
  PatchUserSettingsResult,
  SaveWorkspaceFileRequest,
  SaveWorkspaceFileResult,
  UserSettingValue,
  WorkspaceState,
} from '@achbit/protocol';
import { activeT } from '../i18n';
import { getHostConnectionHeaders, getKernelApiBase } from './hostTarget';

const API_BASE = getKernelApiBase();

export interface DefaultWorkspacePathResult {
  path: string | null;
}

interface SendJsonOptions {
  signal?: AbortSignal;
}

function endpointLabel(url: string): string {
  try {
    return new URL(
      url,
      typeof window === 'undefined' ? 'http://localhost' : window.location.origin,
    ).pathname;
  } catch {
    return url;
  }
}

async function httpErrorMessage(response: Response, url: string): Promise<string> {
  const fallback = `HTTP ${response.status}: ${response.statusText} (${endpointLabel(url)})`;
  const body = await response.text().catch(() => '');
  if (!body.trim()) return fallback;
  try {
    const value = JSON.parse(body) as Record<string, unknown>;
    const message = typeof value.message === 'string'
      ? value.message
      : typeof value.error === 'string'
        ? value.error
        : null;
    return message ? `${fallback} - ${message}` : fallback;
  } catch {
    return `${fallback} - ${body.trim()}`;
  }
}

function errorResponse(error: unknown): ApiResponse<never> {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof DOMException && error.name === 'AbortError') {
    return { ok: false, error: 'aborted', message };
  }
  if (error instanceof TypeError) {
    return {
      ok: false,
      error: 'network_error',
      message: activeT('api.error.networkUnavailable', { message }),
    };
  }
  return { ok: false, error: 'request_failed', message };
}

async function getJson<T>(url: string, signal?: AbortSignal): Promise<ApiResponse<T>> {
  try {
    const response = await fetch(url, {
      headers: getHostConnectionHeaders(),
      signal,
    });
    if (!response.ok) {
      return { ok: false, error: 'http_error', message: await httpErrorMessage(response, url) };
    }
    return await response.json() as ApiResponse<T>;
  } catch (error) {
    return errorResponse(error);
  }
}

export async function initializeWorkspaceSandbox(): Promise<ApiResponse<unknown>> {
  return sendJson(`${API_BASE}/user-settings/workspace-sandbox`, 'POST', {});
}

async function sendJson<T>(
  url: string,
  method: 'POST' | 'PATCH' | 'DELETE',
  body: unknown,
  options: SendJsonOptions = {},
): Promise<ApiResponse<T>> {
  try {
    const response = await fetch(url, {
      method,
      headers: {
        'content-type': 'application/json',
        ...getHostConnectionHeaders(),
      },
      body: JSON.stringify(body),
      signal: options.signal,
    });
    if (!response.ok) {
      return { ok: false, error: 'http_error', message: await httpErrorMessage(response, url) };
    }
    return await response.json() as ApiResponse<T>;
  } catch (error) {
    return errorResponse(error);
  }
}

function queryString(values: Record<string, string | undefined>): string {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) {
    if (value) query.set(key, value);
  }
  const encoded = query.toString();
  return encoded ? `?${encoded}` : '';
}

export type HostReadiness = Pick<HealthStatus, 'service' | 'ok' | 'status' | 'version' | 'buildCommit'> & {
  catalog: 'readable'; hostInstanceId: string; hostPid: number;
  kernel: 'starting' | 'ready' | 'failed'; session: 'starting' | 'ready' | 'failed';
  runtimeError?: { code: string; message: string } | null;
};
export function getHostReadiness(): Promise<ApiResponse<HostReadiness>> {
  return getJson(`${API_BASE}/host/readiness`);
}

export function getHealth(): Promise<ApiResponse<HealthStatus>> {
  return getJson(`${API_BASE}/health`);
}

export function getCurrentWorkspace(): Promise<ApiResponse<WorkspaceState>> {
  return getJson(`${API_BASE}/workspaces/current`);
}

export function getDefaultWorkspacePath(): Promise<ApiResponse<DefaultWorkspacePathResult>> {
  return getJson(`${API_BASE}/workspaces/default-path`);
}

export function openWorkspace(path: string): Promise<ApiResponse<OpenWorkspaceResult>> {
  return sendJson(`${API_BASE}/workspaces/open`, 'POST', { path });
}

export function saveWorkspaceFile(
  request: SaveWorkspaceFileRequest,
): Promise<ApiResponse<SaveWorkspaceFileResult>> {
  return sendJson(`${API_BASE}/workspaces/save-file`, 'POST', request);
}

export function getInitialLocations(): Promise<ApiResponse<InitialLocations>> {
  return getJson(`${API_BASE}/fs/initial-locations`);
}

export function browsePath(absolutePath?: string): Promise<ApiResponse<BrowsePathResult>> {
  return getJson(`${API_BASE}/fs/browse${queryString({ path: absolutePath })}`);
}

export function getUserSettings(): Promise<ApiResponse<GetUserSettingsResult>> {
  return getJson(`${API_BASE}/user-settings`);
}

export function patchUserSettings(
  patches: Record<string, UserSettingValue>,
): Promise<ApiResponse<PatchUserSettingsResult>> {
  return sendJson(`${API_BASE}/user-settings`, 'PATCH', { patches });
}

export function getLlmProfiles(): Promise<ApiResponse<LlmProfilesResult>> {
  return getJson(`${API_BASE}/llm/profiles`);
}

export function patchLlmProfiles(
  request: PatchLlmProfilesRequest,
): Promise<ApiResponse<LlmProfilesResult>> {
  return sendJson(`${API_BASE}/llm/profiles`, 'PATCH', request);
}

export function probeLlmProfile(
  request: LlmProbeRequest,
): Promise<ApiResponse<LlmProbeResult>> {
  return sendJson(`${API_BASE}/llm/probe`, 'POST', request);
}


// Model services use the same authenticated Host connection as ConversationPort.
export function getModelConnections(signal?: AbortSignal) {
  return getJson<import('@achbit/protocol').ConnectionsResult>(`${API_BASE}/llm/connections`, signal);
}
export function patchModelConnections(edit: import('@achbit/protocol').ConnectionEdit) {
  return sendJson<import('@achbit/protocol').ConnectionsResult>(`${API_BASE}/llm/connections`, 'PATCH', edit);
}
export function startModelAuth(connectionId: string, method: 'browser' | 'deviceCode') {
  return sendJson<import('@achbit/protocol').AuthFlow>(`${API_BASE}/llm/auth`, 'POST', { connectionId, method });
}
export function getModelAuth(id: string, signal?: AbortSignal) {
  return getJson<import('@achbit/protocol').AuthFlow>(`${API_BASE}/llm/auth/${encodeURIComponent(id)}`, signal);
}
export function cancelModelAuth(id: string) {
  return sendJson<import('@achbit/protocol').AuthFlow>(`${API_BASE}/llm/auth/${encodeURIComponent(id)}`, 'DELETE', {});
}
export function logoutModelConnection(id: string) {
  return sendJson<unknown>(`${API_BASE}/llm/connections/${encodeURIComponent(id)}/logout`, 'POST', {});
}
export function getModelQuota(id: string, signal?: AbortSignal) {
  return getJson<import('@achbit/protocol').QuotaSnapshot>(`${API_BASE}/llm/connections/${encodeURIComponent(id)}/quota`, signal);
}
export function queryModelUsage(query: import('@achbit/protocol').UsageQuery, signal?: AbortSignal) {
  return sendJson<import('@achbit/protocol').UsageReport>(`${API_BASE}/llm/usage`, 'POST', query, { signal });
}
