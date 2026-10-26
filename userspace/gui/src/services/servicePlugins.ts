import { EventSourceParserStream } from 'eventsource-parser/stream';
import { getHostConnectionHeaders, getKernelApiBase } from './hostTarget';

export interface ServicePluginStatus {
  id: string; name: string; description: string; path: string; enabled: boolean;
  status: 'running' | 'failed' | 'stopped'; error: string | null;
  baseUrl: string | null; pageUrl: string | null; stateDirectory: string;
}

export async function getServicePlugins(signal?: AbortSignal): Promise<ServicePluginStatus[]> {
  const response = await fetch(`${getKernelApiBase()}/plugin-services`, { headers: getHostConnectionHeaders(), signal });
  if (!response.ok) throw new Error(`Service plugins: ${response.status} ${await response.text()}`);
  const result = await response.json();
  if (!result.ok) throw new Error(`${result.error}: ${result.message}`);
  if (!Array.isArray(result.data?.services)) throw new Error('Invalid service plugin inventory');
  return result.data.services;
}

/** One Host stream owns invalidation; inventory reads happen only on its events. */
export async function watchServicePlugins(signal: AbortSignal, changed: (services: ServicePluginStatus[]) => void): Promise<void> {
  const response = await fetch(`${getKernelApiBase()}/plugin-services/events`, {
    signal, headers: { ...getHostConnectionHeaders(), Accept: 'text/event-stream' },
  });
  if (!response.ok || !response.headers.get('content-type')?.startsWith('text/event-stream') || !response.body) {
    const detail = await response.text();
    let message = detail;
    try { const error = JSON.parse(detail) as { message?: string; error?: string }; message = error.message ?? error.error ?? detail; }
    catch { /* Keep the original transport error. */ }
    throw new Error(message || `plugin_services_watch_failed:HTTP ${response.status}`);
  }
  const reader = response.body.pipeThrough(new TextDecoderStream()).pipeThrough(new EventSourceParserStream()).getReader();
  try {
    while (!signal.aborted) {
      const result = await reader.read();
      if (result.done) throw new Error('plugin_services_watch_closed');
      if (result.value.event === 'ready' || result.value.event === 'change') {
        const services = await getServicePlugins(signal);
        if (!signal.aborted) changed(services);
      }
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
}
