import sources from '../../../protocol/src/pluginMarketplaceSources.json';
import { getHostConnectionHeaders, getKernelApiBase } from './hostTarget';
import { requestPluginInstallation } from '../ui-plugins/source';

export const PLUGIN_MARKETPLACE_REPOSITORY_URL = sources.repositoryUrl;
export const PLUGIN_MARKETPLACE_INDEX_URL = sources.indexUrl;

export interface PluginMarketplaceVerification {
  kind: 'publisher' | 'installation';
  platform?: string;
  version?: string;
  evidenceUrl?: string;
}

export interface PluginMarketplaceEntry {
  id: string;
  name: string;
  description: string;
  descriptionZhCN?: string;
  install?: { sha256: string; manifestId: string };
  kind: 'ui' | 'cli' | 'service' | 'guidance';
  author: string;
  version: string;
  sourceCommit: string;
  sourceUrl: string;
  repositoryUrl?: string;
  licenseName: string;
  licenseUrl: string;
  licenseKind: 'open-source' | 'source-available';
  downloadUrl: string;
  verification?: PluginMarketplaceVerification;
}

function objectRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function requiredText(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`Invalid plugin directory field: ${field}`);
  return value.trim();
}

function httpsUrl(value: unknown, field: string): URL {
  const url = new URL(requiredText(value, field));
  if (url.protocol !== 'https:' || url.username || url.password) throw new Error(`Invalid plugin directory URL: ${field}`);
  return url;
}

function fixedDownloadUrl(value: unknown): string {
  const url = httpsUrl(value, 'downloadUrl');
  // Other hosts may use content-addressed links. Maintainers verify those during review.
  const parts = url.pathname.split('/').filter(Boolean);
  const github = url.hostname === 'github.com';
  const raw = url.hostname === 'raw.githubusercontent.com';
  const ref = raw ? parts[2] : github && ['raw', 'blob', 'archive'].includes(parts[2]) ? parts[3] : undefined;
  if (github && parts[2] === 'releases' && parts[3] === 'latest'
    || ref && (['HEAD', 'main', 'master'].includes(ref) || ref === 'refs' && parts.includes('heads'))) {
    throw new Error('Plugin download must identify a fixed version.');
  }
  return url.href;
}

function verification(value: unknown, version: string): PluginMarketplaceVerification | undefined {
  if (value === undefined) return undefined;
  if (!objectRecord(value) || (value.kind !== 'installation' && value.kind !== 'publisher')) {
    throw new Error('Invalid plugin directory verification.');
  }
  const platform = value.platform === undefined ? undefined : requiredText(value.platform, 'verification.platform');
  const testedVersion = value.version === undefined ? undefined : requiredText(value.version, 'verification.version');
  if (value.kind === 'installation' && (!platform || testedVersion !== version)) {
    throw new Error('Installation verification requires the tested platform and matching plugin version.');
  }
  return {
    kind: value.kind,
    ...(platform && { platform }),
    ...(testedVersion && { version: testedVersion }),
    ...(value.evidenceUrl !== undefined && { evidenceUrl: httpsUrl(value.evidenceUrl, 'verification.evidenceUrl').href }),
  };
}

function installMetadata(value: unknown): PluginMarketplaceEntry['install'] {
  if (value === undefined) return undefined;
  if (!objectRecord(value) || typeof value.sha256 !== 'string' || !/^[a-f0-9]{64}$/u.test(value.sha256)) {
    throw new Error('Invalid plugin ZIP SHA-256.');
  }
  return { sha256: value.sha256, manifestId: requiredText(value.manifestId, 'install.manifestId') };
}

function entry(value: unknown): PluginMarketplaceEntry {
  if (!objectRecord(value)) throw new Error('Invalid plugin directory entry.');
  const { kind, licenseKind } = value;
  if (kind !== 'ui' && kind !== 'cli' && kind !== 'service' && kind !== 'guidance') throw new Error('Unknown plugin kind.');
  if (licenseKind !== 'open-source' && licenseKind !== 'source-available') throw new Error('Unknown plugin license kind.');
  const sourceCommit = requiredText(value.sourceCommit, 'sourceCommit');
  const sourceUrl = httpsUrl(value.sourceUrl, 'sourceUrl');
  if (!/^(?:[\da-f]{40}|[\da-f]{64})$/i.test(sourceCommit)
    || ![...sourceUrl.pathname.split('/'), ...sourceUrl.searchParams.values()].some(part => part.toLowerCase() === sourceCommit.toLowerCase())) {
    throw new Error('Plugin source link must identify its full source commit.');
  }
  const version = requiredText(value.version, 'version');
  const mark = verification(value.verification, version);
  const install = installMetadata(value.install);
  return {
    id: requiredText(value.id, 'id'), name: requiredText(value.name, 'name'),
    description: requiredText(value.description, 'description'), kind, author: requiredText(value.author, 'author'), version,
    ...(value.descriptionZhCN !== undefined && { descriptionZhCN: requiredText(value.descriptionZhCN, 'descriptionZhCN') }),
    ...(install && { install }),
    sourceCommit, sourceUrl: sourceUrl.href,
    ...(value.repositoryUrl !== undefined && { repositoryUrl: httpsUrl(value.repositoryUrl, 'repositoryUrl').href }),
    licenseName: requiredText(value.licenseName, 'licenseName'), licenseKind,
    licenseUrl: httpsUrl(value.licenseUrl, 'licenseUrl').href, downloadUrl: fixedDownloadUrl(value.downloadUrl),
    ...(mark && { verification: mark }),
  };
}

export function decodePluginMarketplace(value: unknown): PluginMarketplaceEntry[] {
  if (!objectRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.plugins)) {
    throw new Error('Unsupported plugin directory format.');
  }
  const plugins = value.plugins.map(entry);
  if (new Set(plugins.map(plugin => plugin.id)).size !== plugins.length) throw new Error('Duplicate plugin directory ID.');
  return plugins;
}

const REQUEST_TIMEOUT_MS = 6_000;

class DirectoryHttpError extends Error {}

async function readDirectory(url: string, signal?: AbortSignal, headers?: Record<string, string>): Promise<string> {
  const request = new AbortController();
  const cancel = () => request.abort();
  if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
  signal?.addEventListener('abort', cancel, { once: true });
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    request.abort();
  }, REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, { signal: request.signal, credentials: 'omit', cache: 'no-cache', headers });
    if (!response.ok) throw new DirectoryHttpError(`Plugin directory HTTP ${response.status}`);
    // The timeout covers the body transfer as well as connecting to the origin.
    return await response.text();
  } catch (error) {
    if (signal?.aborted) throw signal.reason ?? error;
    if (timedOut) throw new Error(`Plugin directory request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
    throw error;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
  }
}

export async function fetchPluginMarketplace(signal?: AbortSignal): Promise<PluginMarketplaceEntry[]> {
  let raw: string;
  try {
    raw = await readDirectory(PLUGIN_MARKETPLACE_INDEX_URL, signal);
  } catch (primaryError) {
    if (signal?.aborted || primaryError instanceof DirectoryHttpError) throw primaryError;
    try {
      const mirror = await readDirectory(sources.contentsUrl, signal, { Accept: 'application/vnd.github.raw+json' });
      return decodePluginMarketplace(JSON.parse(mirror));
    } catch (secondaryError) {
      if (signal?.aborted) throw secondaryError;
      throw new Error(`raw.githubusercontent.com: ${String(primaryError)} · api.github.com: ${String(secondaryError)}`);
    }
  }
  return decodePluginMarketplace(JSON.parse(raw));
}

export interface InstalledPluginIdentity {
  id: string;
  kind: PluginMarketplaceEntry['kind'];
  path: string;
}

export interface LocalPluginInstallation {
  plugin: InstalledPluginIdentity;
  application: { status: string; error?: string | null };
}

function installedIdentity(value: unknown): InstalledPluginIdentity {
  if (!objectRecord(value) || typeof value.id !== 'string' || !value.id
    || typeof value.path !== 'string' || !value.path
    || !['ui', 'guidance', 'cli', 'service'].includes(String(value.kind))) {
    throw new Error('Invalid installed plugin identity.');
  }
  return { id: value.id, kind: value.kind as InstalledPluginIdentity['kind'], path: value.path };
}

export async function installMarketplacePlugin(entry: PluginMarketplaceEntry): Promise<LocalPluginInstallation> {
  if (!entry.install) throw new Error('This entry provides an author download only.');
  const data = await requestPluginInstallation({
    marketplace: { id: entry.id, version: entry.version, kind: entry.kind, ...entry.install },
  });
  if (!objectRecord(data) || !objectRecord(data.application) || typeof data.application.status !== 'string') {
    throw new Error('Host did not report the plugin installation result.');
  }
  const plugin = installedIdentity(data.plugin);
  if (plugin.kind !== entry.kind || plugin.id !== entry.install.manifestId) throw new Error('Unexpected installed plugin identity.');
  const { status, error } = data.application;
  return { plugin, application: { status, ...(typeof error === 'string' && { error }) } };
}

export async function fetchInstalledMarketplacePlugins(signal?: AbortSignal): Promise<InstalledPluginIdentity[]> {
  const response = await fetch(`${getKernelApiBase()}/host/plugins`, { headers: getHostConnectionHeaders(), signal });
  if (!response.ok) throw new Error(`Plugin inventory: ${response.status} ${await response.text()}`);
  const result = await response.json();
  if (!result.ok) throw new Error(result.message ?? result.error ?? 'Plugin inventory failed.');
  if (!Array.isArray(result.data?.plugins)) throw new Error('Host returned an invalid plugin inventory.');
  return result.data.plugins.filter((item: unknown) =>
    // A broken Skill registration may carry its mount ID instead of its manifest identity.
    !(objectRecord(item) && item.error && (!item.id || item.kind === 'guidance'))
  ).map(installedIdentity);
}
