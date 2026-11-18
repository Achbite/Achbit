export const PLUGIN_MARKETPLACE_REPOSITORY_URL = 'https://github.com/Achbite/achbit-plugins';
export const PLUGIN_MARKETPLACE_INDEX_URL = 'https://raw.githubusercontent.com/Achbite/achbit-plugins/main/plugins.json';

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
  return {
    id: requiredText(value.id, 'id'), name: requiredText(value.name, 'name'),
    description: requiredText(value.description, 'description'), kind, author: requiredText(value.author, 'author'), version,
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

const CONTENTS_URL = 'https://api.github.com/repos/Achbite/achbit-plugins/contents/plugins.json?ref=main';
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
      const mirror = await readDirectory(CONTENTS_URL, signal, { Accept: 'application/vnd.github.raw+json' });
      return decodePluginMarketplace(JSON.parse(mirror));
    } catch (secondaryError) {
      if (signal?.aborted) throw secondaryError;
      throw new Error(`raw.githubusercontent.com: ${String(primaryError)} · api.github.com: ${String(secondaryError)}`);
    }
  }
  return decodePluginMarketplace(JSON.parse(raw));
}
