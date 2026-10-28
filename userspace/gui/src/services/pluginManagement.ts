import { EventSourceParserStream } from 'eventsource-parser/stream';
import { getHostConnectionHeaders, getKernelApiBase } from './hostTarget';

export async function manageLocalPlugin(action: 'enable' | 'disable' | 'remove', target: string): Promise<void> {
  const response = await fetch(`${getKernelApiBase()}/host/plugins/manage`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...getHostConnectionHeaders() },
    body: JSON.stringify({ action, target }),
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(result.message ?? `Plugin management: ${response.status}`);
  if (result.data?.application?.status === 'failed') throw new Error(result.data.application.error ?? 'Plugin activation failed');
}

/** The stream owns this window's runtime report lifetime; no inventory polling. */
export async function watchUserSettings(clientId: string, signal: AbortSignal, changed: () => Promise<void>): Promise<void> {
  const response = await fetch(`${getKernelApiBase()}/user-settings/events?clientId=${encodeURIComponent(clientId)}`, {
    headers: getHostConnectionHeaders(), signal,
  });
  if (!response.ok || !response.body) throw new Error(`Settings stream: ${response.status} ${await response.text()}`);
  const reader = response.body.pipeThrough(new TextDecoderStream()).pipeThrough(new EventSourceParserStream()).getReader();
  try {
    while (!signal.aborted) {
      const result = await reader.read();
      if (result.done) throw new Error('Settings stream disconnected');
      if (result.value.event === 'ready' || result.value.event === 'change') await changed();
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
}

export async function reportUiPlugins(clientId: string, plugins: readonly {
  path: string; status: 'disabled' | 'loading' | 'active' | 'error'; error: string | null;
}[], signal: AbortSignal): Promise<void> {
  const response = await fetch(`${getKernelApiBase()}/host/plugins/ui-runtime`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...getHostConnectionHeaders() }, signal,
    body: JSON.stringify({ clientId, plugins: plugins.filter(plugin => !plugin.path.startsWith('builtin:'))
      .map(({ path, status, error }) => ({ path, status, error })) }),
  });
  const result = await response.json();
  if (!response.ok || !result.ok) throw new Error(result.message ?? `UI plugin report: ${response.status}`);
}
