import type { RunRuntimeSnapshot, SessionEvent } from '@achbit/protocol';
import { decodeAgentRecipe, permissionPolicyConstraints } from '@achbit/protocol';

const ENVIRONMENT_ID = 'deepcode.session-environment';

export function environmentInstruction(value: unknown, toolNames: readonly string[] = []): RunRuntimeSnapshot['instructions'][number] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('session_environment_invalid');
  }
  const data = value as Record<string, unknown>;
  {
    const shell = data.shell as Record<string, unknown> | null;
    const target = data.executionTarget as Record<string, unknown> | null;
    if (!target || !['native', 'wsl'].includes(String(target.kind))
      || (target.kind === 'wsl' && ['distribution', 'worker'].some((key) => typeof target[key] !== 'string' || !target[key]))
      || !shell || !['bash', 'powershell'].includes(String(shell.tool))
      || typeof shell.executable !== 'string' || typeof shell.dialect !== 'string' || typeof data.executionPath !== 'string'
      || typeof data.shellAvailable !== 'boolean' || typeof data.workspaceShellSupported !== 'boolean'
      || !Array.isArray(data.developerCommands) || !data.developerCommands.every((item) => typeof item === 'string')) {
      throw new Error('session_environment_invalid');
    }
  }
  const fields = ['os', 'arch', 'locale', 'responseLanguage', 'userShell', 'configuration', 'executionTarget', 'shellAvailable', 'shell', 'developerCommands', 'commandPaths', 'runtimeExecutables', 'productDocsPath', 'executionPath', 'workspaceShellSupported', 'workspaceSandbox', 'hostBinding', 'agentComposition'];
  if (data.agentComposition !== undefined) {
    const composition = data.agentComposition as Record<string, unknown>;
    if (!composition || typeof composition !== 'object' || Array.isArray(composition)
      || Object.keys(composition).some(key => !['permissionPolicy', 'policyConstraints', 'workspaceSandbox', 'sandboxCoverage'].includes(key))
      || composition.sandboxCoverage !== 'workspaceShell') throw new Error('agent_composition_invalid');
    const recipe = decodeAgentRecipe({ permissionPolicy: composition.permissionPolicy, workspaceSandbox: composition.workspaceSandbox });
    const expected = recipe.workspaceSandbox?.requireIsolatedProcesses
      ? { allowHostExecution: false, allowExternalTools: false } : permissionPolicyConstraints(recipe.permissionPolicy);
    const constraints = composition.policyConstraints as Record<string, unknown>;
    if (!constraints || Object.keys(constraints).length !== 2
      || Object.entries(expected).some(([key, value]) => constraints[key] !== value)) throw new Error('agent_composition_invalid');
  }
  if (data.executionPath !== undefined && typeof data.executionPath !== 'string') throw new Error('session_environment_invalid');
  if (data.commandPaths !== undefined && (!data.commandPaths || typeof data.commandPaths !== 'object'
    || Array.isArray(data.commandPaths) || Object.values(data.commandPaths).some((path) => typeof path !== 'string'))) {
    throw new Error('session_environment_invalid');
  }
  if (data.hostBinding !== undefined) {
    const binding = data.hostBinding as Record<string, unknown> | null;
    if (!binding || typeof binding.hostInstanceId !== 'string' || !binding.hostInstanceId
      || typeof binding.windowLabel !== 'string' || !binding.windowLabel) throw new Error('session_host_binding_invalid');
  }
  if (data.productDocsPath !== undefined && data.productDocsPath !== null
    && (typeof data.productDocsPath !== 'string' || !data.productDocsPath)) {
    throw new Error('session_environment_invalid');
  }
  if (data.runtimeExecutables !== undefined) {
    const executables = data.runtimeExecutables;
    if (!executables || typeof executables !== 'object' || Array.isArray(executables)
      || !('kernel' in executables) || Object.keys(executables).some(key => !['kernel', 'cli'].includes(key))
      || Object.values(executables).some(path => typeof path !== 'string' || !path)) throw new Error('session_environment_invalid');
  }
  if (Object.keys(data).some((key) => !fields.includes(key))
    || ['os', 'arch'].some((key) => typeof data[key] !== 'string' || !data[key])
    || ['locale', 'responseLanguage', 'userShell'].some((key) => data[key] !== null && typeof data[key] !== 'string')) {
    throw new Error('session_environment_invalid');
  }
  const hasShell = toolNames.some(name => name === 'bash' || name === 'powershell');
  const execution = hasShell ? `Command environment: ${JSON.stringify({
    os: data.os, arch: data.arch, shell: data.shell,
    ...(data.commandPaths ? { commandPaths: data.commandPaths } : { developerCommands: data.developerCommands }),
    ...(typeof data.productDocsPath === 'string' ? { productDocsPath: data.productDocsPath } : {}),
  })}. ` : '';
  return {
    id: ENVIRONMENT_ID,
    text: `${execution}Use ${data.responseLanguage ?? "the user's language"} for user-facing text unless the user requests another language.`,
  };
}

export function savedSessionEnvironment(events: readonly SessionEvent[]): RunRuntimeSnapshot['environment'] | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index];
    if (event?.type === 'run.started' && event.payload.runtimeSnapshot.environment) {
      return event.payload.runtimeSnapshot.environment;
    }
  }
  return undefined;
}
