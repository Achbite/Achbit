import type { PreparedToolDescriptor, RunRuntimeSnapshot, UserSettings } from '@achbit/protocol';
import { SESSION_CONTROL_INTERACTION_REQUEST, SESSION_CONTROL_PLAN_PUBLISH } from '@achbit/protocol';

/** Only the actual stage can contribute Plan and interaction routes. */
export function workspacePermissionInstruction(
  runtime: RunRuntimeSnapshot, tools: readonly PreparedToolDescriptor[], controls: ReadonlyMap<string, string>,
): RunRuntimeSnapshot['instructions'][number] | undefined {
  const { permissions } = runtime;
  const canMutate = tools.some(tool => tool.possibleEffects.some(effect => effect === 'workspaceMutation' || effect === 'process' || effect === 'external'));
  const interaction = controls.get(SESSION_CONTROL_INTERACTION_REQUEST) ?? null;
  if (!canMutate && !interaction) return;
  const plan = controls.get(SESSION_CONTROL_PLAN_PUBLISH) ?? null;
  const manual = runtime.planMode === 'manual';
  if (permissions['agent.permissions.workspaceMutation'] === 'allow' && !manual && !interaction
    && permissions['agent.permissions.engineeringDecisions'] === 'delegate') return;
  return { id: 'achbit.workspace-autonomy', text: permissionText(permissions, interaction, plan, manual, canMutate) };
}

function permissionText(settings: UserSettings, interactionRequest: string | null, planPublish: string | null, requestedPlan: boolean, canMutate: boolean): string {
  const engineering = settings['agent.permissions.engineeringDecisions'] === 'delegate'
    ? "Engineering decisions are delegated. Choose the smallest sound approach within the user's scope."
    : 'Decide routine implementation details. When viable engineering routes materially differ in scope, public contracts or cost, explain the trade-off and let the user choose before proceeding with that route.';
  const questions = interactionRequest
    ? ` Use ${interactionRequest} for missing requirements or decisions that belong to the user. Continue independent work while awaiting an answer when useful.` : '';
  if (!canMutate) return engineering + questions;
  const workspaceAutonomyInstruction = requestedPlan
    ? 'Work within the confirmed project scope.'
    : settings['agent.permissions.workspaceMutation'] === 'allow'
    ? "Work within the bound workspaces and the user's authorized scope."
    : !planPublish ? 'Work within confirmed scope.'
    : settings['agent.permissions.workspaceMutation'] === 'review'
      ? `Submit a Plan with ${planPublish} for project changes outside confirmed scope. An independent Plan reviewer decides the proposed scope; you do not approve your own Plan. Reuse confirmed scope and submit again only when new or expanded authorization is needed. Project reads need no Plan.`
    : `Investigate as needed and propose a clearly scoped change. Before making project changes outside confirmed scope, call ${planPublish} and wait for confirmation. Then carry out related work within that scope autonomously, including delegated parent scope, without seeking approval again for ordinary implementation details. Request additional scope only when needed. Project reads need no Plan.`;
  return `${workspaceAutonomyInstruction}\nFile and shell paths resolve from the workspace selected for that call.\n${engineering}${questions}`;
}
