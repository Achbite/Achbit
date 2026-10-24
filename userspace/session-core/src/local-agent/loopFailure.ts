import type { ErrorDiagnostics, LocalAgentError } from '@achbit/protocol';

export class LoopFailure extends Error {
  constructor(readonly code: string, message: string, readonly diagnostics?: ErrorDiagnostics) {
    super(message);
    this.name = 'LoopFailure';
  }
}

export class ProviderReportedFailure extends LoopFailure {
  constructor(code: string, message: string, diagnostics?: ErrorDiagnostics) {
    super(code, message, diagnostics);
    this.name = 'ProviderReportedFailure';
  }
}

export function errorFact(error: unknown): LocalAgentError {
  if (error instanceof AggregateError && error.errors.length) {
    const primary = errorFact(error.errors[0]);
    const diagnostics = primary.diagnostics ?? { source: 'session', phase: 'loop', category: 'internal', retryable: false, causes: [] };
    return { ...primary, diagnostics: { ...diagnostics, retryable: false,
      secondary: [...(diagnostics.secondary ?? []), ...error.errors.slice(1).map((item) => {
        const fact = errorFact(item); return { code: fact.code, message: fact.message };
      })].slice(0, 16) } };
  }
  if (error instanceof LoopFailure) return { code: error.code, message: error.message,
    ...(error.diagnostics ? { diagnostics: structuredClone(error.diagnostics) } : {}) };
  const cause = error instanceof Error ? error : new Error(String(error));
  const causes: ErrorDiagnostics['causes'] = [];
  let current: unknown = cause;
  while (current instanceof Error && causes.length < 16) {
    causes.push({ message: current.message || current.name }); current = current.cause;
  }
  return { code: 'agent_loop_failed', message: cause.message || cause.name,
    diagnostics: { source: 'session', phase: 'loop', category: 'internal', retryable: false, causes,
      ...(cause instanceof AggregateError ? { secondary: cause.errors.slice(1, 17).map((item) => {
        const fact = errorFact(item); return { code: fact.code, message: fact.message };
      }) } : {}) } };
}

/** The Provider completed before interpretation, persistence, or cleanup failed. */
export class ProviderCompletedFailure extends LoopFailure {
  constructor(error: unknown) {
    const failure = errorFact(error);
    super(failure.code, failure.message, failure.diagnostics);
    this.name = 'ProviderCompletedFailure';
    this.cause = error;
  }
}
