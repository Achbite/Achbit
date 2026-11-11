import type { ErrorDiagnostics, LocalAgentError } from './localAgent.js';

const object = (value: unknown): value is Record<string, unknown> => Boolean(value) && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && Boolean(value.trim()) && !value.includes('\0');

export function isErrorDiagnostics(value: unknown): value is ErrorDiagnostics {
  if (!object(value) || !['source', 'phase', 'category'].every((key) => text(value[key]))
    || typeof value.retryable !== 'boolean' || !Array.isArray(value.causes) || value.causes.length > 16) return false;
  if (Object.keys(value).some((key) => !['source', 'phase', 'category', 'retryable', 'causes', 'isConnect', 'isTimeout', 'isBody', 'stopReason', 'archivePath', 'providerError', 'secondary'].includes(key))) return false;
  return value.causes.every((cause) => object(cause) && text(cause.message)
    && Object.keys(cause).every((key) => ['message', 'kind', 'osCode'].includes(key))
    && (cause.kind === undefined || text(cause.kind)) && (cause.osCode === undefined || Number.isSafeInteger(cause.osCode)))
    && ['isConnect', 'isTimeout', 'isBody'].every((key) => value[key] === undefined || typeof value[key] === 'boolean')
    && ['stopReason', 'archivePath'].every((key) => value[key] === undefined || text(value[key]))
    && (value.providerError === undefined || object(value.providerError)
      && Object.keys(value.providerError).length > 0
      && Object.entries(value.providerError).every(([key, entry]) => key === 'httpStatus'
        ? Number.isInteger(entry) && Number(entry) >= 100 && Number(entry) <= 599
        : ['code', 'type', 'status', 'retryDirective'].includes(key) && text(entry)))
    && (value.secondary === undefined || Array.isArray(value.secondary) && value.secondary.length <= 16
      && value.secondary.every((entry) => object(entry) && Object.keys(entry).length === 2 && text(entry.code) && text(entry.message)));
}

export function isLocalAgentErrorValue(value: unknown): value is LocalAgentError {
  return object(value) && Object.keys(value).every((key) => ['code', 'message', 'diagnostics'].includes(key))
    && text(value.code) && text(value.message) && (value.diagnostics === undefined || isErrorDiagnostics(value.diagnostics));
}

/** Presentation classification only. Never authorizes a retry or changes the recorded failure. */
export function runFailureKind(error?: LocalAgentError) {
  const d = error?.diagnostics;
  const upstream = d?.source === 'providerTransport';
  if (upstream && ['network', 'transport'].includes(d.category)) return d.isTimeout ? 'timeout' : 'connection';
  if (upstream && d.category === 'protocol') return 'providerProtocol';
  if (upstream && d.category === 'provider') {
    const details = d.providerError;
    const codes = [details?.code, details?.type, details?.status].map(value => value?.toLowerCase());
    const has = (...values: string[]) => values.some(value => codes.includes(value));
    const status = details?.httpStatus;
    if (has('server_is_overloaded', 'overloaded_error') || status === 529) return 'overloaded';
    if (has('insufficient_quota', 'insufficient_balance', 'billing_hard_limit_reached', 'payment_required') || status === 402) return 'quota';
    if (has('authentication_error', 'invalid_api_key', 'authentication', 'unauthenticated') || status === 401) return 'authentication';
    if (has('permission_error', 'permission_denied') || status === 403) return 'permission';
    if (has('rate_limit_exceeded', 'rate_limit_error', 'rate_limit', 'resource_exhausted') || status === 429) return 'rateLimit';
    if (has('timeout', 'request_timeout', 'deadline_exceeded') || status === 408 || status === 504) return 'timeout';
    if (has('service_unavailable_error', 'unavailable') || status === 503) return 'unavailable';
    if (has('server_error', 'api_error', 'internal', 'internal_error') || status !== undefined && status >= 500) return 'providerInternal';
    if (has('context_length_exceeded', 'request_too_large') || status === 413) return 'contextLimit';
    return 'providerRejected';
  }
  if (upstream) return 'providerFailure';
  if (error?.code === 'context_input_budget_exceeded' || error?.code === 'context_budget_invalid') return 'contextLimit';
  if (d?.source === 'session' && d.category === 'internal' || error?.code === 'agent_loop_failed') return 'loop';
  // Old journal entries can lack diagnostics. Do not infer blame from message text.
  if (['provider_transport_failed', 'provider_stream_read_failed'].includes(error?.code ?? '')) return 'connection';
  if (['provider_error', 'provider_http_failed'].includes(error?.code ?? '')) return 'providerFailure';
  return 'unclassified';
}
