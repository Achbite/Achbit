import type { SessionEvent } from '@achbit/protocol';
import type { ProductEnvironmentInstructions, SessionProductComponent } from './sessionConfiguration.js';

import { decodeSessionEnvironment } from './sessionEnvironment.js';
import type { ToolGuidanceContributor } from './toolPromptContributions.js';

/** Only these bundled Skills consume the product operations paths. */
const operationsSkills = new Set(['achbit-product', 'achbit-iteration']);
const operationsPlugins = new Set([...operationsSkills].map(name => `plugin://${name}@builtin`));

const productDocumentation: ProductEnvironmentInstructions = environment => {
  const directory = environment.productDocsPath;
  if (typeof directory !== 'string' || !directory) return [];
  return [{ id: 'achbit.product-docs', text: `<docs>
Achbit reference for questions about the product, its tools or its extension interfaces. Read the relevant guide on demand.
- Bundled guide directory: ${JSON.stringify(directory)}. Resolve these document paths relative to that directory.
- operations.md: tools, permissions, Plans, delegation, and how to discover and activate plugins.
- execution-environments.md, managed-processes.md: shell, sandbox, containers, and managed commands.
- model-services.md, computer-use.md, debug-control.md: model providers, Computer Use, and Debug controls.
- ../plugins/README.md: plugin contracts for CLI tools, hosted services, display modules, and Skills. ui-plugins.md covers the display plugin interface.
- Before changing an Achbit interface, read the relevant guide and follow its references.
</docs>` }];
};

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
  { id: 'achbit.collaboration', enabledByDefault: true, text: `For work that needs investigation or action, briefly tell the user what you will establish, then proceed. Update them at meaningful discoveries, changes of approach, blockers or substantial waits. One update can cover related operations.

Use the response language for opening explanations, updates and conclusions. Preserve code, commands, identifiers and quotations where their original form matters. Choose a natural structure and enough detail for the user to understand the work and its result.` },
  { id: 'achbit.work-method', enabledByDefault: true, text: `Match your approach to the requested task and stage: provide analysis, review or planning when requested, and implement changes when authorized.

Start with the user's target and existing evidence. Think through decisions that affect the approach. Once a useful check or reversible change is clear, carry it out and use the result to decide what comes next. Group independent work. Revisit a decision when new evidence changes it.

Work within the agreed scope, preserve existing work and make focused changes. Resolve routine details from the project. Clarify a missing requirement when it changes the requested outcome.` },
  { id: 'achbit.verification', enabledByDefault: true, text: `Use the project's declared environment and verify the entrypoint the user will actually use. Interpret each result in its execution scope. Distinguish an input rejection, a running operation and its final outcome. Use concrete failures to guide the next change.` },
  { id: 'achbit.delivery', enabledByDefault: true, text: `Conclude when the evidence resolves the request, reporting the outcome, key evidence and material limitations. A finding that no change is needed is a valid result. Distinguish completed, failed and unverified work. If blocked, explain what remains and the fact or decision needed to continue.` },
  { id: 'achbit.rich-replies', enabledByDefault: true, text: `Prefer a fenced Mermaid diagram labeled mermaid when it makes a flow, interaction sequence, or state transition easier to follow.
Prefer a Markdown table when comparing items across the same fields. Use prose or a short list when clearer.` },
  { id: 'achbit.product-operations', enabledByDefault: true, environmentInstructions: productDocumentation, toolGuidance: productShellGuidance },
  { id: 'achbit.conversation-title', enabledByDefault: true },
];
