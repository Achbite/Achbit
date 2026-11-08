import { isManagedProcessSnapshot, type JsonObject, type LocalAgentError, type ManagedProcessSnapshot, type SessionEvent, type ToolExecutionRecord, type ToolInputIssue } from '@achbit/protocol';
import { encodeWorkspaceIdentity } from './providerToolCodec.js';
import { LoopFailure } from './loopFailure.js';
import { codingToolText } from './codingTools.js';

type Approval = Extract<SessionEvent, { type: 'approval.resolved' }>['payload'];
type Handles = ReadonlyMap<string, string>;

function object(value: unknown): value is JsonObject {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function fields(value: JsonObject, ...names: string[]): JsonObject {
  return Object.fromEntries(names.filter(name => value[name] !== undefined).map(name => [name, value[name]]));
}

function entries(value: unknown, ...names: string[]): unknown {
  return Array.isArray(value) ? value.map(item => object(item) ? fields(item, ...names) : item) : value;
}

/** Preserve the actual cause and recovery information, not the diagnostic machinery around it. */
function errorDetails(error: LocalAgentError): JsonObject {
  const value = fields({ ...error }, 'code', 'message', 'issues', 'details', 'path', 'operation', 'targets', 'workspaceId');
  if (error.diagnostics) {
    const { causes, secondary, archivePath } = error.diagnostics;
    if (causes?.length) value.causes = causes;
    if (secondary?.length) value.secondary = secondary;
    if (archivePath) value.log = archivePath;
  }
  return value;
}

export function toolError(error: LocalAgentError, handles: Handles): JsonObject {
  return encodeWorkspaceIdentity({ workspaceHandleById: handles }, errorDetails(error));
}

export function rejectionContent(error: LocalAgentError & { issues?: ToolInputIssue[] }, handles: Handles,
  coding: boolean | undefined, kind: 'input' | 'control' | 'indeterminate'): string {
  if (coding) {
    const issues = (error.issues ?? []).filter(issue => issue.message !== error.message)
      .map(issue => `${issue.path}: ${issue.message}`);
    const message = kind === 'indeterminate' ? `Execution outcome unknown. ${error.message}` : error.message;
    return [message, ...issues].join('\n');
  }
  const fields = kind === 'input' ? { status: 'inputRejected', executed: false }
    : kind === 'control' ? { accepted: false, executed: false } : { status: 'indeterminate' };
  return JSON.stringify({ ...fields, error: toolError(error, handles) });
}

function shellOutput(value: JsonObject, incomplete: boolean): JsonObject {
  return {
    ...fields(value, 'exitCode'),
    ...(value.stdout ? { stdout: value.stdout } : {}),
    ...(value.stderr ? { stderr: value.stderr } : {}),
    ...(value.timedOut === true ? { timedOut: true } : {}),
    ...(value.truncated === true ? { truncated: true } : {}),
    ...(value.truncated === true || incomplete ? fields(value, 'fullOutput') : {}),
    ...(incomplete ? fields(value, 'details') : {}),
  };
}

export function managedJobFromRecord(record: ToolExecutionRecord): ManagedProcessSnapshot | undefined {
  if (record.outcome !== 'completed' || !['bash', 'powershell', 'container', 'process'].includes(record.toolName)) return;
  const job = object(record.output) ? record.output.job : undefined;
  return isManagedProcessSnapshot(job) ? job : undefined;
}

/** A status request or a wake delivers the same bounded command result as a foreground call. */
export function processResult(job: ManagedProcessSnapshot, view: 'start' | 'requested' | 'notification'): JsonObject {
  const result: JsonObject = { jobId: job.jobId, status: job.status };
  if (view === 'start' && job.status === 'active') return result;
  if (!['bash', 'powershell', 'container'].includes(job.toolName)) {
    return { ...result, tool: job.toolName,
      ...(job.result === undefined ? {} : { result: object(job.result) ? extensionOutput(job.toolName, job.result) : job.result }),
      ...(job.error ? { error: errorDetails(job.error) } : {}) };
  }
  const out = job.output;
  const tail = view === 'notification';
  const native = object(job.result) ? job.result : {};
  const clipped = out.truncated || native.truncated === true || tail && (out.stdout.length > 2000 || out.stderr.length > 2000);
  const commandResult = { ...native, stdout: tail ? out.stdout.slice(-2000) : out.stdout,
    stderr: tail ? out.stderr.slice(-2000) : out.stderr, truncated: clipped };
  return { ...result, ...shellOutput(commandResult, job.status === 'failed' || job.status === 'cancelled'),
    ...(job.toolName === 'container' ? fields(native, 'containerId', 'projectPath', 'workPath', 'network') : {}),
    ...(job.error ? { error: errorDetails(job.error) } : {}) };
}

function resourceList(value: unknown): unknown {
  return entries(value, 'artifactId', 'label', 'uri', 'logicalPath', 'contentType');
}

function fileResult(record: ToolExecutionRecord, out: JsonObject): JsonObject {
  const changed = Array.isArray(out.fileChanges) ? { changed: out.fileChanges.length > 0 } : {};
  const path = fields(out, 'path');
  const partial = record.outcome === 'completed' ? {} : fields(out, 'details', 'saved', 'patched');
  if (record.toolName === 'fs.delete') {
    // Directory deletion can fail after removing part of the tree.
    const removed = record.outcome !== 'completed' && Array.isArray(out.fileChanges)
      ? out.fileChanges.filter(object).map(change => change.path) : [];
    return { ...path, ...partial, ...fields(out, 'deleted'), ...(removed.length ? { removed } : {}) };
  }
  return { ...path, ...changed, ...(out.created === true ? { created: true } : {}),
    ...(record.toolName === 'fs.edit' ? fields(out, 'editCount') : {}),
    ...(record.input.executable !== undefined ? fields(out, 'executable') : {}),
    // A later attribute error can follow a successful write. Preserve that effect.
    ...partial };
}

/** Extensions own their business output. Remove only documented Achbit storage sidecars. */
function extensionOutput(tool: string, out: JsonObject): JsonObject {
  const projected = { ...out };
  if (['container', 'document.render', 'browser.capture'].includes(tool)) delete projected.fileChanges;
  if (['document.render', 'browser.capture', 'browser.observe', 'computer.control'].includes(tool) && Array.isArray(out.artifacts)) {
    projected.artifacts = out.artifacts.map(item => {
      if (!object(item) || typeof item.artifactId !== 'string' || item.uri !== `artifact://${item.artifactId}` || typeof item.contentRef !== 'string') return item;
      const { contentRef, ...artifact } = item;
      if (projected.contentRef === contentRef) delete projected.contentRef;
      return artifact;
    });
  }
  return projected;
}

/** The owning tool selects model-visible fields while its full record remains immutable. */
function outputForModel(record: ToolExecutionRecord, out: unknown, handles: Handles): unknown {
  if (!object(out)) return out;
  const job = managedJobFromRecord(record);
  if (job) return processResult(job, record.toolName === 'process' && record.input.action === 'status' ? 'requested' : 'start');
  if (record.preparedEffect.origin !== 'coreBuiltin') {
    const output = extensionOutput(record.toolName, out);
    if (record.toolName === 'computer.control' && record.input.action !== 'status' && object(output.diagnostics) && object(output.diagnostics.native)) {
      const { executor: _executor, ...native } = output.diagnostics.native;
      output.diagnostics = { ...output.diagnostics, native };
    }
    return encodeWorkspaceIdentity({ workspaceHandleById: handles }, output);
  }
  switch (record.toolName) {
    case 'fs.read':
      if (Array.isArray(out.entries)) return { entries: entries(out.entries, 'name', 'kind'), ...fields(out, 'nextStartLine') };
      if (typeof out.content === 'string') return out.truncated
        ? { content: out.content, ...fields(out, 'nextByte', 'nextStartLine') } : out.content;
      if (Array.isArray(out.artifacts)) return { artifacts: resourceList(out.artifacts) };
      if (record.outcome !== 'completed') return fields(out, 'details');
      throw new LoopFailure('file_read_result_invalid', 'File read returned neither text, directory entries nor a resource.');
    case 'fs.write': case 'fs.edit': case 'fs.delete': return fileResult(record, out);
    case 'bash': case 'powershell': return shellOutput(out, record.outcome !== 'completed');
    case 'process':
      if (record.outcome !== 'completed') return fields(out, 'details');
      throw new LoopFailure('process_result_invalid', 'Managed process result has no valid job.');
    case 'web.fetch':
      return { ...fields(out, 'content', 'statusCode', 'details'), ...(out.finalUrl && out.finalUrl !== out.url ? { finalUrl: out.finalUrl } : {}),
        ...(out.truncated === true || out.sourceTruncated === true ? { truncated: true } : {}),
        ...fields(out, 'untrustedEvidence') };
    case 'web.search':
      if (out.provider === 'kimi-formula' && typeof out.providerContent === 'string') return out.providerContent;
      return { ...(Array.isArray(out.results) ? { results: entries(out.results, 'title', 'url', 'snippet', 'summary', 'publishedAt', 'language', 'truncated') } : {}),
        ...(out.truncated === true ? { truncated: true } : {}),
        ...(Array.isArray(out.resultIssues) && out.resultIssues.length ? { resultIssues: out.resultIssues } : {}),
        ...fields(out, 'details', 'untrustedEvidence') };
    case 'skill.read': return out.content ?? (record.outcome !== 'completed' ? fields(out, 'details') : undefined);
    case 'plugin.search':
      return { ...(Array.isArray(out.plugins) ? { plugins: entries(out.plugins, 'uri', 'displayName', 'shortDescription') } : {}),
        ...fields(out, 'total', 'details'), ...(typeof out.nextOffset === 'number' ? { nextOffset: out.nextOffset } : {}) };
    case 'artifact.prepare': case 'artifact.preview':
      return { ...(Array.isArray(out.artifacts) ? { artifacts: resourceList(out.artifacts) } : {}), ...fields(out, 'contentVerified', 'details') };
    case 'session.read': {
      const { revision: _revision, ...requestedView } = out;
      return encodeWorkspaceIdentity({ workspaceHandleById: handles }, requestedView);
    }
    default: return encodeWorkspaceIdentity({ workspaceHandleById: handles }, { ...out });
  }
}

function body(value: unknown): string {
  if (value === undefined) throw new LoopFailure('tool_result_missing', 'The tool did not supply a result.');
  return typeof value === 'string' ? value : JSON.stringify(value);
}

export function toolResultContent(record: ToolExecutionRecord, approval: Approval | undefined, handles: Handles, codingTools = false, guidance?: string): string {
  if (codingTools && !approval) {
    const text = codingToolText(record);
    if (text !== undefined) return text;
  }
  const output = 'output' in record && record.output !== undefined ? outputForModel(record, record.output, handles) : undefined;
  const grant = approval?.decision === 'allow' && approval.authorizationScope ? { grantedScope: approval.authorizationScope } : undefined;
  if (record.outcome === 'completed') {
    if (grant) return body({ result: output, ...grant, ...(guidance ? { guidance } : {}) });
    if (guidance) return typeof output === 'string'
      ? `${output}\n\n${guidance}` : body({ result: output, guidance });
    return body(output);
  }
  const error = 'error' in record && record.error ? toolError(record.error, handles) : undefined;
  return body({
    ...(record.outcome !== 'failed' ? { status: record.outcome } : {}),
    ...(error ? { error } : {}),
    ...(approval?.decision === 'deny' && approval.reason ? { reason: approval.reason } : {}),
    ...(output !== undefined && output !== null && (!object(output) || Object.keys(output).length) ? { result: output } : {}),
    ...grant,
  });
}
