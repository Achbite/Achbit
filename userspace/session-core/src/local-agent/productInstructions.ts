import type { JsonObject, SessionEvent } from '@achbit/protocol';
import type { SessionProductComponent } from './sessionConfiguration.js';

import { decodeSessionEnvironment } from './sessionEnvironment.js';
import type { ToolGuidanceContributor } from './toolPromptContributions.js';

/** Only these bundled Skills consume the product operations paths. */
const operationsSkills = new Set(['achbit-product', 'achbit-iteration']);
const operationsPlugins = new Set([...operationsSkills].map(name => `plugin://${name}@builtin`));

/** The documentation index is shared; product operations adds detail at the relevant entries. */
export function productDocumentation(environment: JsonObject, expanded = true) {
  const directory = environment.productDocsPath;
  if (typeof directory !== 'string' || !directory) return [];
  return [{ id: 'achbit.product-docs', text: [
    '<docs>',
    'Achbit documentation for the harness itself, its tools, configuration and extensions. Read the relevant guide on demand.',
    `- Product guides: ${JSON.stringify(directory)}`,
    '- operations.md: tools, permissions, Plans, collaboration and outputs',
    ...(expanded ? ['  Includes file references and output delivery.'] : []),
    '- model-services.md: models, context and usage',
    ...(expanded ? ['  Includes profiles, authentication and image input.'] : []),
    '- execution-environments.md, managed-processes.md: Shell and command lifecycle',
    ...(expanded ? ['  Covers sandbox, Host, containers, remote execution, background commands, dependency waiting, cancellation and results.',
      '- computer-use.md: browser and desktop operation.'] : []),
    '- debug-control.md: isolated Debug control',
    '- ../plugins/README.md: plugin and Skill interfaces',
    ...(expanded ? ['  Includes CLI tools, hosted services and MCP.', '- ui-plugins.md: display plugin interfaces.'] : []),
    '- Resolve these paths under Product guides, not the current working directory',
    '- Before implementing harness changes, read the relevant guides and their related references.',
    ...(expanded ? ['Use current tool declarations and runtime results to establish available behavior.'] : []),
    '</docs>',
  ].join('\n') }];
}

const productShellGuidance: ToolGuidanceContributor = ({ runtime, events, runId, tools }) => {
  const shells = tools.filter(tool => tool.origin === 'coreBuiltin' && (tool.name === 'bash' || tool.name === 'powershell'));
  if (!shells.length) return [];
  const start = events.find(event => event.type === 'run.started' && event.runId === runId);
  const inputMessageId = start?.type === 'run.started' ? start.payload.inputMessageId : undefined;
  const initiallySelected = start?.type === 'run.started'
    && start.payload.runtimeSnapshot.selectedPlugins.plugins.some(plugin => operationsPlugins.has(plugin.uri));
  const source = events.findLast((event): event is Extract<SessionEvent, { type: 'message.committed' | 'session.plugins.activated' | 'tool.completed' }> => {
    if (event.type === 'message.committed' && event.payload.role === 'user'
      && (event.runId === runId || event.payload.messageId === inputMessageId)) {
      return Boolean(initiallySelected && event.payload.messageId === inputMessageId
        || event.payload.pluginSelections?.some(plugin => operationsPlugins.has(plugin.uri))
        || event.payload.guidanceReferences?.some(ref => ref.toolName === 'skill.read' && operationsSkills.has(ref.name)));
    }
    if (!('runId' in event) || event.runId !== runId) return false;
    if (event.type === 'session.plugins.activated') {
      return event.payload.pluginUris.some(uri => operationsPlugins.has(uri));
    }
    if (event.type !== 'tool.completed') return false;
    const { record } = event.payload;
    return record.preparedEffect.origin === 'coreBuiltin' && record.toolName === 'skill.read'
      && record.outcome === 'completed' && typeof record.input.name === 'string' && operationsSkills.has(record.input.name);
  });
  if (!source) return [];
  const contributionId = source.type === 'message.committed'
    ? `message:${source.payload.messageId}`
    : source.type === 'session.plugins.activated'
      ? `plugin-activation:${source.callId}` : `tool-result:${source.callId}`;

  const { data, hostExecutionAllowed } = decodeSessionEnvironment(runtime.environment);
  const cli = (data.runtimeExecutables as Record<string, unknown> | undefined)?.cli;
  const hasCli = hostExecutionAllowed && (data.executionTarget as Record<string, unknown>).kind === 'native'
    && typeof cli === 'string' && typeof data.hostDataDirectory === 'string';
  const resources = {
    ...(data.productDocsPath ? { productDocsPath: data.productDocsPath } : {}),
    ...(data.commandPaths ? { commandPaths: data.commandPaths } : { developerCommands: data.developerCommands }),
    ...(hasCli ? { achbitCli: cli, hostDataDirectory: data.hostDataDirectory } : {}),
  };
  const text = `Achbit product resources: ${JSON.stringify(resources)}.`
    + (hasCli ? ' Run achbitCli on the Host with --host-data-dir hostDataDirectory. Submit the Shell call with requestHostPermission and an operation-specific reason, including read-only commands such as plugins status; the active permission policy handles authorization.'
      : !hostExecutionAllowed ? ' Host execution is disabled in this session; the product administration CLI is unavailable.' : '');
  return shells.map(tool => ({ toolName: tool.name, text, contributionId }));
};

/** Installed by the Achbit product. The standalone Session registry has no product defaults. */
export const achbitProductComponents: readonly SessionProductComponent[] = [
  { id: 'achbit.collaboration', enabledByDefault: true, text: `For work that needs investigation or action, briefly tell the user what you will establish, then proceed. Update them at meaningful discoveries, changes of approach, blockers or substantial waits. One update can cover related operations; avoid narrating every tool call.

Use the response language for opening explanations, updates and conclusions. Keep progress separate from the final result, and include the detail needed to understand the work.` },
  { id: 'achbit.work-method', enabledByDefault: true, text: `Match your approach to the requested task and stage: provide analysis, review or planning when requested, and implement changes when authorized.

Start with the user's target, existing evidence and relevant files. Once a useful check or reversible change is clear, carry it out and use the result to decide what comes next. Group independent work; wait for a result before starting an operation that depends on it. Revisit a decision when new evidence changes it.

Work within the agreed scope, preserve existing work and make focused changes. Resolve routine details from the project. Clarify a missing requirement when it changes the requested outcome.` },
  { id: 'achbit.verification', enabledByDefault: true, text: `Verify the actual entrypoint in its declared environment. Rejected input was not executed; approval or progress is not completion. Keep the original error, any partial effects and any uncertainty about the outcome.

Report what each check establishes. Builds, tests, interface observations and real use provide different evidence. If the evidence fits multiple answers, say what remains unknown rather than picking one or adding unsupported details.` },
  { id: 'achbit.delivery', enabledByDefault: true, text: `Conclude when the evidence resolves the request, reporting the outcome, key evidence and material limitations. A finding that no change is needed is a valid result. Distinguish completed, failed and unverified work. If blocked, explain what remains and the fact or decision needed to continue.

Present materials that need user review as clickable links and register them in the outputs table using the available delivery capability. Writing a file, archiving it and delivering it are separate steps; listing a path alone does not register an output. Link the returned delivery references in the final reply.

Keep simple explanations inline. Routine source references can be file links without a separate document. Keep temporary scripts, raw logs and observation images intermediate unless selected for review; summarize relevant evidence in the delivered report.` },
  { id: 'achbit.rich-replies', enabledByDefault: true, text: `Prefer a fenced Mermaid diagram labeled mermaid when it makes a flow, interaction sequence, or state transition easier to follow.
Prefer a Markdown table when comparing items across the same fields. Use prose or a short list when clearer.
Standalone components can be previewed interactively within a reply, alongside the explanation. Frontend Design describes the presentation options and preview reference format.` },
  { id: 'achbit.product-operations', enabledByDefault: true, environmentInstructions: productDocumentation, toolGuidance: productShellGuidance },
  { id: 'achbit.conversation-title', enabledByDefault: true },
];
