import type { PreparedToolDescriptor, RunRuntimeSnapshot, UserSettings } from '@achbit/protocol';
import { SESSION_CONTROL_INTERACTION_REQUEST, SESSION_CONTROL_PLAN_PUBLISH } from '@achbit/protocol';

/** Only the actual stage can contribute Plan and interaction routes. */
export function workspacePermissionInstruction(
  runtime: RunRuntimeSnapshot, tools: readonly PreparedToolDescriptor[], controls: ReadonlyMap<string, string>,
): RunRuntimeSnapshot['instructions'][number] | undefined {
  const { permissions } = runtime;
  const canMutate = tools.some(tool => tool.possibleEffects.some(effect => effect === 'workspaceMutation' || effect === 'process' || effect === 'external'));
  if (!canMutate) return;
  const interaction = controls.get(SESSION_CONTROL_INTERACTION_REQUEST) ?? null;
  const plan = controls.get(SESSION_CONTROL_PLAN_PUBLISH) ?? null;
  const manual = runtime.planMode === 'manual';
  if (permissions['agent.permissions.workspaceMutation'] === 'allow' && !manual && !interaction
    && permissions['agent.permissions.engineeringDecisions'] === 'delegate') return;
  return { id: 'achbit.workspace-autonomy', text: permissionText(permissions, interaction, plan, manual) };
}

function permissionText(settings: UserSettings, interactionRequest: string | null, planPublish: string | null, requestedPlan: boolean): string {
  const workspaceAutonomyInstruction = requestedPlan
    ? 'Work within the confirmed project scope.'
    : settings['agent.permissions.workspaceMutation'] === 'allow'
    ? "Work within the bound workspaces and the user's authorized scope."
    : !planPublish ? 'Work within confirmed scope.'
    : settings['agent.permissions.workspaceMutation'] === 'review'
      ? `Submit a Plan with ${planPublish} for project changes outside confirmed scope. An independent Plan reviewer decides the proposed scope; you do not approve your own Plan. Reuse confirmed scope and submit again only when new or expanded authorization is needed. Project reads need no Plan.`
    : `Investigate as needed and propose a clearly scoped change. Before making project changes outside confirmed scope, call ${planPublish} and wait for confirmation. Then carry out related work within that scope autonomously, including delegated parent scope, without seeking approval again for ordinary implementation details. Request additional scope only when needed. Project reads need no Plan.`;
  const engineeringDecisionInstruction = settings['agent.permissions.engineeringDecisions'] === 'delegate'
    ? 'Engineering decisions are delegated. Choose the smallest sound approach.'
    : 'Choose local implementation details within the agreed approach. Material changes to requirements, public contracts or that approach need the user’s decision.';
  const interaction = interactionRequest ? ` Use ${interactionRequest} for missing facts or decisions that belong to the user.` : '';
  return `${workspaceAutonomyInstruction}\nFile and shell paths resolve from the workspace selected for that call.\n${engineeringDecisionInstruction}${interaction}`;
}
