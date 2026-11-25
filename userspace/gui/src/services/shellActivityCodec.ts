const SHELL_ACTIVITY_RESULT_FIELDS = [
  'exitCode',
  'success',
  'timedOut',
  'truncated',
  'capturedBytes',
  'durationMs',
] as const;

const SHELL_ENVIRONMENT_FIELDS = [
  'shell',
  'interactive',
  'executionScope',
  'terminal',
  'pathSource',
  'writeScope',
  'homeWritable',
  'networkAccess',
] as const;

export function isShellActivityResult(value: unknown): boolean {
  return isExactRecord(value, [...SHELL_ACTIVITY_RESULT_FIELDS, 'environment', 'stdout', 'stderr'])
    && typeof value.stdout === 'string'
    && typeof value.stderr === 'string' && validResultFields(value);
}

export function isShellResultSummary(value: unknown): value is Omit<import('@achbit/protocol').ShellActivityResultProjection, 'stdout' | 'stderr'> {
  return isExactRecord(value, [...SHELL_ACTIVITY_RESULT_FIELDS, 'environment']) && validResultFields(value);
}

function validResultFields(value: Record<string, unknown>) {
  return (value.exitCode === null
      || typeof value.exitCode === 'number' && Number.isSafeInteger(value.exitCode))
    && typeof value.success === 'boolean'
    && typeof value.timedOut === 'boolean'
    && typeof value.truncated === 'boolean'
    && isNaturalNumber(value.capturedBytes)
    && isNaturalNumber(value.durationMs)
    && isShellExecutionEnvironment(value.environment);
}

export function isShellExecutionEnvironment(value: unknown): boolean {
  return isExactRecord(value, SHELL_ENVIRONMENT_FIELDS)
    && typeof value.shell === 'string'
    && value.shell.trim().length > 0
    && typeof value.terminal === 'boolean'
    && value.interactive === value.terminal
    && (value.executionScope === 'workspace' || value.executionScope === 'host')
    && typeof value.pathSource === 'string'
    && value.pathSource.trim().length > 0
    && typeof value.writeScope === 'string'
    && value.writeScope.trim().length > 0
    && typeof value.homeWritable === 'boolean'
    && typeof value.networkAccess === 'boolean';
}

function isNaturalNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function isExactRecord(
  value: unknown,
  requiredKeys: readonly string[],
  optionalKeys: readonly string[] = [],
): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const allowed = new Set([...requiredKeys, ...optionalKeys]);
  const keys = Object.keys(value);
  return requiredKeys.every((key) => Object.hasOwn(value, key))
    && keys.every((key) => allowed.has(key));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
