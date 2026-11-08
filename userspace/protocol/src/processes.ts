import type { ManagedProcessSnapshot, ProcessActivityProjection, ToolOutputProjection } from './localAgent.js';
import { isLocalAgentErrorValue } from './errorDiagnostics.js';
const object = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
const natural = (v: unknown): v is number => Number.isSafeInteger(v) && Number(v) >= 0;
const text = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const timestamp = (v: unknown) => typeof v === 'string' && /^\d+$/u.test(v);
export function isProcessOutput(v: unknown): v is ToolOutputProjection {
  return object(v) && typeof v.stdout === 'string' && typeof v.stderr === 'string'
    && natural(v.stdoutBytes) && natural(v.stderrBytes) && typeof v.truncated === 'boolean';
}
export function isManagedProcessSnapshot(v: unknown): v is ManagedProcessSnapshot {
  return object(v) && ['jobId', 'sessionId', 'runId', 'callId', 'command'].every(k => text(v[k]))
    && natural(v.revision) && v.revision > 0 && text(v.toolName)
    && ['active', 'completed', 'failed', 'cancelled'].includes(String(v.status))
    && Array.isArray(v.targets) && v.targets.every(text) && timestamp(v.startedAt)
    && (v.lastOutputAt === undefined || timestamp(v.lastOutputAt))
    && (v.status === 'active' ? v.completedAt === undefined : timestamp(v.completedAt))
    && isProcessOutput(v.output) && (v.error === undefined || isLocalAgentErrorValue(v.error))
    && (v.status === 'failed' || v.status === 'cancelled' ? v.error !== undefined : v.error === undefined);
}
/** Wire-shape validation only; Session owns the projection and outcome. */
export function isProcessActivity(v: unknown): v is ProcessActivityProjection {
  if (!object(v) || !text(v.jobId) || !text(v.command) || !isProcessOutput(v.output)) return false;
  return v.result === undefined || object(v.result)
    && (v.result.exitCode === null || Number.isSafeInteger(v.result.exitCode))
    && natural(v.result.durationMs) && typeof v.result.timedOut === 'boolean';
}
