import type { RunRuntimeSnapshot, SessionEvent } from '@achbit/protocol';
import { decodeAgentRecipe, permissionPolicyConstraints } from '@achbit/protocol';
import { codingToolNames } from './codingTools.js';

const ENVIRONMENT_ID = 'achbit.session-environment';


export function decodeSessionEnvironment(value: unknown): { data: Record<string, unknown>; hostExecutionAllowed: boolean } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('session_environment_invalid');
  }
  const data = value as Record<string, unknown>;
  let hostExecutionAllowed = true;
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
  const fields = ['os', 'arch', 'locale', 'responseLanguage', 'userShell', 'configuration', 'executionTarget', 'shellAvailable', 'shell', 'developerCommands', 'commandPaths', 'runtimeExecutables', 'hostDataDirectory', 'productDocsPath', 'executionPath', 'workspaceShellSupported', 'workspaceSandbox', 'hostBinding', 'agentComposition', 'primaryWorkspaceDirectory', 'sessionWorkdirId'];
  if (data.sessionWorkdirId !== undefined && (typeof data.sessionWorkdirId !== 'string' || !data.sessionWorkdirId)) {
    throw new Error('session_environment_invalid');
  }
  if (data.primaryWorkspaceDirectory !== undefined) {
    const directory = data.primaryWorkspaceDirectory as Record<string, unknown> | null;
    if (!directory || typeof directory.workspaceId !== 'string' || !directory.workspaceId
      || typeof directory.path !== 'string' || !directory.path) throw new Error('session_environment_invalid');
  }
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
    hostExecutionAllowed = expected.allowHostExecution;
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
  if (data.hostDataDirectory !== undefined && (typeof data.hostDataDirectory !== 'string' || !data.hostDataDirectory)) {
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
  return { data, hostExecutionAllowed };
}

export function environmentInstruction(value: unknown, toolNames: readonly string[] = [], coding?: { cwd?: string }): RunRuntimeSnapshot['instructions'][number] {
  const { data } = decodeSessionEnvironment(value);
  const shell = data.shell as { tool: string; dialect: string };
  const target = data.executionTarget as { kind: string; distribution?: string };
  const hasShell = data.shellAvailable === true && toolNames.includes(shell.tool);
  const language = `Use ${data.responseLanguage ?? "the user's language"} for user-facing text unless the user requests another language.`;
  const commands = data.developerCommands as string[];
  const available = hasShell && commands.length ? `Detected commands on PATH: ${commands.join(', ')}. This records executable discovery; runtime dependencies, sandbox access and service readiness are established by the command's actual result.` : '';
  if (coding) {
    const platform = target.kind === 'wsl' ? `${data.os} (WSL, ${target.distribution})` : data.os;
    const lines = [hasShell && `Shell: ${shell.dialect} on ${platform} (${data.arch}).`, available,
      toolNames.some(name => codingToolNames.has(name))
        && `Use paths relative to the selected workspace${target.kind === 'wsl' ? ' in WSL' : ''}.`, language];
    const sections = ['<environment>', ...lines.filter(Boolean), '</environment>'];
    if (coding.cwd) sections.push('', '<cwd>', JSON.stringify(coding.cwd), '</cwd>');
    return { id: ENVIRONMENT_ID, text: sections.join('\n') };
  }
  const facts = { os: data.os, arch: data.arch, shell: data.shell,
    ...(target.kind === 'wsl' ? { wslDistribution: target.distribution } : {}) };
  const command = hasShell ? `Command environment: ${JSON.stringify(facts)}. ` : '';
  return { id: ENVIRONMENT_ID, text: [command + language, available].filter(Boolean).join('\n') };
}

export function primaryWorkingDirectory(runtime: RunRuntimeSnapshot, primaryId: string | undefined): string | undefined {
  const directory = runtime.environment.primaryWorkspaceDirectory;
  if (primaryId && directory && typeof directory === 'object'
    && 'workspaceId' in directory && directory.workspaceId === primaryId
    && 'path' in directory && typeof directory.path === 'string') return directory.path;
  return undefined;
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
