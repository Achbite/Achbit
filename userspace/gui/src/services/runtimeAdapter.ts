import type { ApiResponse, HealthStatus } from '@achbit/protocol';
import { activeT } from '../i18n';
import * as api from './apiClient';
import { isRemoteHost } from './hostTarget';

type TauriCoreApi = {
  invoke?: <T = unknown>(command: string, args?: Record<string, unknown>) => Promise<T>;
};

declare global {
  interface Window {
    __TAURI__?: { core?: TauriCoreApi; event?: {listen<T>(name:string,listener:(event:{payload:T})=>void):Promise<()=>void>} };
    __DEEPCODE_BROWSER_PREVIEW__?: boolean;
  }
}

export const APP_CLOSE_REQUEST_EVENT = 'deepcode:app-close-request';

export interface KernelStartResult {
  started: boolean;
  blocked: boolean;
  message: string;
  status: HostStartupStatusV1;
}

export interface HostStartupStatusV1 {
  schemaVersion: 'deepcode.host-shell.startup-status';
  revision: number;
  attemptId: string;
  mode: 'managed' | 'connectOnly';
  phase: 'idle' | 'starting' | 'ready' | 'external' | 'blocked' | 'failed' | 'stopped';
  stage: string;
  code: string;
  reasonCode?: string;
  message: string;
  retryable: boolean;
  ownsProcesses: boolean;
  diagnosticRef?: string;
  updatedAt: string;
}

function tauriInvoke(): TauriCoreApi['invoke'] | null {
  if (window.__DEEPCODE_BROWSER_PREVIEW__) return null;
  return window.__TAURI__?.core?.invoke ?? null;
}

export function hasDesktopNotifications(): boolean {
  return typeof window !== 'undefined' && tauriInvoke() !== null;
}

export interface CompletionReminder {
  foregroundSound: boolean;
  sessionId: string;
  title: string;
  body: string;
  openLabel: string;
  dismissLabel: string;
}

export async function notifyTaskCompleted(reminder: CompletionReminder): Promise<void> {
  const invoke = tauriInvoke();
  if (!invoke) throw new Error('desktop_notifications_unavailable');
  await invoke('deepcode_notify_completed', { reminder });
}

export interface CompletionSoundInfo { path: string; custom: boolean }

export async function getCompletionSound(): Promise<CompletionSoundInfo> {
  const invoke = tauriInvoke();
  if (!invoke) throw new Error('desktop_notifications_unavailable');
  return invoke<CompletionSoundInfo>('deepcode_completion_sound');
}

export async function setCompletionSound(data: number[] | null): Promise<CompletionSoundInfo> {
  const invoke = tauriInvoke();
  if (!invoke) throw new Error('desktop_notifications_unavailable');
  return invoke<CompletionSoundInfo>('deepcode_set_completion_sound', { data });
}

export async function previewCompletionSound(): Promise<void> {
  const invoke = tauriInvoke();
  if (!invoke) throw new Error('desktop_notifications_unavailable');
  await invoke('deepcode_preview_completion_sound');
}

export async function onCompletionOpen(listener: (sessionId: string) => void): Promise<() => void> {
  if (!hasDesktopNotifications()) return () => {};
  const events = window.__TAURI__?.event;
  if (!events) throw new Error('desktop_events_unavailable');
  return events.listen<string>('deepcode:completion-open', event => listener(event.payload));
}

export interface NativePathOptions {
  kind: 'file' | 'directory' | 'path';
  multiple?: boolean;
  title: string;
  selectLabel?: string;
  cancelLabel?: string;
  defaultPath?: string;
  filters?: { name: string; extensions: string[] }[];
}

export function hasNativePathPicker(): boolean {
  return !isRemoteHost() && typeof window !== 'undefined' && tauriInvoke() !== null;
}

export interface NativePathSelection {
  path: string;
  kind: 'file' | 'directory';
}

export async function pickNativePaths(options: NativePathOptions): Promise<NativePathSelection[] | null> {
  if (!hasNativePathPicker()) throw new Error('native_path_picker_unavailable');
  if (options.kind === 'path' || (typeof __DEEPCODE_DEBUG__ !== 'undefined' && __DEEPCODE_DEBUG__)) {
    return tauriInvoke()!<NativePathSelection[] | null>('deepcode_pick_path', { options: {
      title: options.title,
      kind: options.kind,
      selectLabel: options.selectLabel ?? 'Select',
      cancelLabel: options.cancelLabel ?? 'Cancel',
      defaultPath: options.defaultPath,
      filters: options.filters ?? [],
      multiple: options.multiple ?? false,
    } });
  }
  const { open } = await import('@tauri-apps/plugin-dialog');
  const paths = await open({
    title: options.title,
    directory: options.kind === 'directory',
    multiple: options.kind === 'file' && options.multiple === true,
    defaultPath: options.defaultPath,
    filters: options.filters,
  });
  return paths === null ? null : (Array.isArray(paths) ? paths : [paths]).map(path => ({ path, kind: options.kind as 'file' | 'directory' }));
}

export async function pickNativePath(options: NativePathOptions): Promise<NativePathSelection | null> {
  const paths = await pickNativePaths({ ...options, multiple: false });
  if (paths === null) return null;
  if (paths.length !== 1) throw new Error('native_path_selection_count_invalid');
  return paths[0];
}

async function windowCommand(
  command: 'minimize' | 'toggleMaximize' | 'close',
  fallback?: () => void,
): Promise<void> {
  const invoke = tauriInvoke();
  if (invoke) {
    try {
      await invoke({
        minimize: 'deepcode_window_minimize',
        toggleMaximize: 'deepcode_window_toggle_maximize',
        close: 'deepcode_window_close',
      }[command]);
    } catch (error) {
      console.warn(`[window] ${command} failed`, error);
    }
    return;
  }
  fallback?.();
}

export async function minimizeAppWindow(): Promise<void> {
  await windowCommand('minimize');
}

export async function toggleMaximizeAppWindow(): Promise<void> {
  await windowCommand('toggleMaximize');
}

export function requestCloseAppWindow(): void {
  window.dispatchEvent(new CustomEvent(APP_CLOSE_REQUEST_EVENT));
}

export async function closeAppWindow(): Promise<void> {
  await windowCommand('close', () => window.close());
}

export async function openExternalUrl(url: string): Promise<void> {
  const invoke = tauriInvoke();
  if (invoke) {
    await invoke('deepcode_open_external_url', { url });
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

export function healthVersion(health?: HealthStatus): string {
  return health?.version || health?.buildCommit || 'unknown';
}

export function isRuntimeReady(
  response: ApiResponse<HealthStatus>,
): response is ApiResponse<HealthStatus> & { data: HealthStatus } {
  return response.ok === true
    && response.data?.ok === true
    && response.data.status === 'ok'
    && response.data.kernel === 'ready'
    && response.data.session === 'ready';
}

export async function startKernelAfterPermission(): Promise<ApiResponse<KernelStartResult>> {
  const invoke = tauriInvoke();
  if (!invoke) {
    return {
      ok: false,
      error: 'kernel_start_unavailable',
      message: activeT('runtime.kernelStart.desktopOnly'),
    };
  }
  try {
    return { ok: true, data: await invoke<KernelStartResult>('deepcode_start_kernel_after_permission') };
  } catch (error) {
    return { ok: false, error: 'kernel_start_failed', message: String(error) };
  }
}

export async function onHostStartupComplete(listener: () => void): Promise<() => void> {
  if (typeof window === 'undefined' || !tauriInvoke()) return () => {};
  const events = window.__TAURI__?.event;
  if (!events) throw new Error('desktop_events_unavailable');
  return events.listen('deepcode:host-startup-complete', listener);
}

export async function getHostStartupStatus(): Promise<ApiResponse<HostStartupStatusV1>> {
  const invoke = tauriInvoke();
  if (!invoke) {
    return {
      ok: false,
      error: 'host_startup_status_unavailable',
      message: activeT('runtime.hostStartupStatus.desktopOnly'),
    };
  }
  try {
    return { ok: true, data: await invoke<HostStartupStatusV1>('deepcode_host_startup_status') };
  } catch (error) {
    return { ok: false, error: 'host_startup_status_failed', message: String(error) };
  }
}

export async function getDefaultWorkspacePath(): Promise<ApiResponse<string | null>> {
  if (!isRemoteHost() && document.documentElement.dataset.product === 'deepcode-gui') {
    const invoke = tauriInvoke();
    if (invoke) {
      try {
        return { ok: true, data: await invoke<string | null>('deepcode_default_workspace_path') };
      } catch (error) {
        return { ok: false, error: 'default_workspace_failed', message: String(error) };
      }
    }
  }
  const response = await api.getDefaultWorkspacePath();
  return response.ok
    ? { ok: true, data: response.data?.path }
    : { ok: false, error: response.error, message: response.message };
}

export const getHealth = api.getHealth;

export interface SshTarget {
  destination: string;
  port?: number;
  identityFile?: string;
  configFile?: string;
  cliPath: string;
  userRoot?: string;
  remoteShell?: 'posix' | 'windows';
}

export async function connectSsh(target: SshTarget): Promise<void> {
  const invoke = tauriInvoke();
  if (!invoke) throw new Error('ssh_requires_desktop_host');
  await invoke('deepcode_connect_ssh', { target });
}

export async function openLocalWindow(): Promise<void> {
  const invoke = tauriInvoke();
  if (!invoke) throw new Error('local_window_requires_desktop_host');
  await invoke('deepcode_open_local');
}

export async function getSshTarget(): Promise<SshTarget | null> {
  const invoke = tauriInvoke();
  if (!invoke) return null;
  return (await invoke<{ ssh: SshTarget | null }>('deepcode_boot_target')).ssh;
}
export const getCurrentWorkspace = api.getCurrentWorkspace;
export const openWorkspace = api.openWorkspace;
export const saveWorkspaceFile = api.saveWorkspaceFile;
export const getInitialLocations = api.getInitialLocations;
export const browsePath = api.browsePath;
export const getUserSettings = api.getUserSettings;
export const patchUserSettings = api.patchUserSettings;
export const getLlmProfiles = api.getLlmProfiles;
export const patchLlmProfiles = api.patchLlmProfiles;
export const probeLlmProfile = api.probeLlmProfile;
