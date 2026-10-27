import { getHostConnectionHeaders, getKernelApiBase } from '../services/hostTarget';
import type { UiPluginFile, UiPluginSource } from './types';

export function decodePluginSources(encoded: string): UiPluginSource[] {
  const value: unknown = JSON.parse(encoded);
  if (!Array.isArray(value) || !value.every((item) => item && typeof item.path === 'string' && item.path.trim() && typeof item.enabled === 'boolean')
    || new Set(value.map((item) => item.path)).size !== value.length) throw new Error('UI plugin sources must be unique folders with enabled flags.');
  return value;
}

export async function watchUiPlugins(sources: UiPluginSource[], signal: AbortSignal, changed: (files: UiPluginFile[]) => void): Promise<void> {
  const response = await fetch(`${getKernelApiBase()}/host/ui-plugins/watch`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...getHostConnectionHeaders() },
    body: JSON.stringify({ sources }), signal,
  });
  if (!response.ok) throw new Error(`UI plugin watch: ${response.status} ${await response.text()}`);
  if (!response.body) throw new Error('UI plugin watch returned no stream.');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let pending = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) throw new Error('UI plugin watch disconnected. Refresh plugins to reconnect.');
      pending += decoder.decode(value, { stream: true });
      let end;
      while ((end = pending.indexOf('\n')) >= 0) {
        const line = pending.slice(0, end); pending = pending.slice(end + 1);
        const files: unknown = JSON.parse(line);
        if (!Array.isArray(files) || !files.every((file) => file && typeof file.path === 'string' && typeof file.enabled === 'boolean'
          && (file.source === null || typeof file.source === 'string') && (file.error === null || typeof file.error === 'string')
          && (file.manifest === null || (typeof file.manifest.id === 'string' && typeof file.manifest.name === 'string' && Array.isArray(file.manifest.slots))))) {
          throw new Error('UI plugin watch returned invalid source data.');
        }
        if (!signal.aborted) changed(files);
      }
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
}

export interface LocalPluginInspection {
  kind: 'ui' | 'cli' | 'guidance' | 'service'; path: string; id: string; name: string; description: string;
  manifestPath: string; slots?: string[]; command?: string; args?: string[]; entry?: string;
}
export async function inspectLocalPlugin(path: string, signal?: AbortSignal): Promise<LocalPluginInspection> {
  const response = await fetch(`${getKernelApiBase()}/host/plugins/inspect`, {
    method: 'POST', headers: { 'Content-Type':'application/json', ...getHostConnectionHeaders() }, body:JSON.stringify({path}), signal,
  });
  if (!response.ok) throw new Error(`Plugin inspection: ${response.status} ${await response.text()}`);
  const result = await response.json();
  if (!result.ok) throw new Error(`${result.error}: ${result.message}`);
  const item = result.data;
  if (!item || !['ui','cli','guidance','service'].includes(item.kind) || !['path','manifestPath','id','name','description'].every(key=>typeof item[key]==='string')) throw new Error('Invalid plugin manifest metadata.');
  return item;
}

/** Host copies and publishes one installation; GUI never persists an external source path. */
export async function installLocalPlugin(path: string, replacePath?: string): Promise<void> {
  const response = await fetch(`${getKernelApiBase()}/host/plugins/install`, {
    method: 'POST', headers: { 'Content-Type': 'application/json', ...getHostConnectionHeaders() },
    body: JSON.stringify({ path, ...(replacePath ? { replacePath } : {}) }),
  });
  if (!response.ok) throw new Error(`Plugin installation: ${response.status} ${await response.text()}`);
  const result = await response.json();
  if (!result.ok) throw new Error(`${result.error}: ${result.message}`);
}
