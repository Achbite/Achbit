import type { UserSettings, ShellAuthorizationScope } from '@deepcode/protocol';
import { takeRestoredInterfaceView } from '../services/interfaceReload';
import { create } from 'zustand';
import type {
  CommandReply,
  ConversationCatalog,
  ConversationCommand,
  ConversationSessionStatus,
  LlmProviderProfile,
  ModelConnection,
  LlmReasoningEffort,
  SessionModelSettings,
  MessageFeedback,
  PluginCatalogProjection,
  PluginSelectionInput,
  PlanResponse,
  SessionProjection,
  HostWindowBinding,
} from '@deepcode/protocol';
import { CONVERSATION_COMMAND_VERSION } from '@deepcode/protocol';
import { getLlmProfiles, patchLlmProfiles } from '../services/apiClient';
import type { PastedTextInput } from '../services/pastedText';
import {
  attachConversationDirectoryIndex,
  createConversationProject as createProjectRequest,
  createLocalAgentSession,
  detachConversationDirectoryIndex,
  deleteConversationProject as deleteProjectRequest,
  deleteConversationSession as deleteSessionRequest,
  getConversationCatalog,
  getConversationStatuses,
  getConversationCatalogManagement,
  getPluginCatalog,
  getLocalAgentProjection,
  resolveConversationFilesystemReferences,
  submitLocalAgentCommand,
  uploadConversationPastedText,
  updateConversationProject as updateProjectRequest,
  updateConversationSession as updateSessionRequest,
} from '../services/localAgentApi';


const EMPTY_CATALOG: ConversationCatalog = { projects: [], sessions: [] };
const EMPTY_PLUGIN_CATALOG: PluginCatalogProjection = { revision: 'plugin-catalog:empty', plugins: [] };

interface PendingFilesystemPath {
  path: string;
  kind: 'file' | 'directory';
}

type StoreErrorSource =
  | 'initialization'
  | 'projection'
  | 'catalog'
  | 'pluginCatalog'
  | 'profiles'
  | 'command'
  | 'operation';

export interface LocalAgentState {
  sessionId: string | null;
  draftProjectId: string | null;
  selectedProfileId: string | null;
  reasoningEffortOverride: LlmReasoningEffort | null;
  modelSettingsBusy: boolean;
  profiles: LlmProviderProfile[];
  connections: ModelConnection[];
  defaultProfileId: string | null;
  catalog: ConversationCatalog;
  sessionStatuses: Record<string, ConversationSessionStatus>;
  statusError: string | null;
  pluginCatalog: PluginCatalogProjection;
  projection: SessionProjection | null;
  loading: boolean;
  submitting: boolean;
  catalogBusy: boolean;
  error: string | null;
  errorSource: StoreErrorSource | null;
  initialize(): Promise<void>;
  refreshProfiles(): Promise<void>;
  refreshCatalog(): Promise<void>;
  refreshPluginCatalog(): Promise<void>;
  startNewSession(projectId?: string | null): void;
  activateSession(sessionId: string): Promise<void>;
  selectModel(profileId: string, effort: LlmReasoningEffort | null): Promise<boolean>;
  refresh(): Promise<void>;
  sendMessage(
    text: string,
    filesystemPaths?: PendingFilesystemPath[],
    pluginSelections?: PluginSelectionInput[],
    pastedTexts?: PastedTextInput[],
    onSessionCreated?: (sessionId: string) => void,
  ): Promise<CommandReply>;
  focusContext(
    task: string,
    filesystemPaths?: PendingFilesystemPath[],
    pluginSelections?: PluginSelectionInput[],
    pastedTexts?: PastedTextInput[],
    onSessionCreated?: (sessionId: string) => void,
  ): Promise<CommandReply>;
  setMessageFeedback(messageId: string, feedback: MessageFeedback | null): Promise<CommandReply>;
  editMessage(messageId: string, text: string, expectedRevision: number): Promise<CommandReply>;
  attachSessionDirectory(canonicalRoot: string): Promise<void>;
  detachSessionDirectory(workspaceId: string): Promise<void>;
  respondInteraction(response: string, interactionId?: string): Promise<CommandReply>;
  rebindHost(hostBinding: HostWindowBinding): Promise<CommandReply>;
  setPermissions(patches: UserSettings): Promise<CommandReply>;
  revokeAuthorization(authorityId: string): Promise<CommandReply>;
  respondApproval(decision: 'allow' | 'deny', authorizationScope?: ShellAuthorizationScope): Promise<CommandReply>;
  respondPlan(response: PlanResponse): Promise<CommandReply>;
  cancelRun(): Promise<CommandReply>;
  createProject(title: string, workspacePaths?: string[]): Promise<void>;
  updateProject(projectId: string, input: { title?: string; workspacePaths?: string[] }): Promise<void>;
  addProjectWorkspace(projectId: string, canonicalRoot: string): Promise<void>;
  removeProjectWorkspace(projectId: string, workspaceId: string): Promise<void>;
  getProjectWorkspacePaths(projectId: string): Promise<Array<{
    workspaceId: string;
    displayName: string;
    canonicalRoot: string;
  }>>;
  deleteProject(projectId: string): Promise<void>;
  updateSession(sessionId: string, input: { title?: string; projectId?: string | null }): Promise<void>;
  deleteSession(sessionId: string): Promise<void>;
  clearError(): void;
}

type StoreSet = (
  state: Partial<LocalAgentState> | ((state: LocalAgentState) => Partial<LocalAgentState>),
) => void;
type StoreGet = () => LocalAgentState;

export function createLocalAgentStore() {
let initialization: Promise<void> | null = null;
let generation = 0;
let viewReadController = new AbortController();
function advanceView(): number {
  viewReadController.abort();
  viewReadController = new AbortController();
  return ++generation;
}
// Draft deltas do not advance the journal revision. Serialize reads across
// polling, navigation and command reconciliation so responses cannot rewind them.
const projectionReadQueues = new Map<string, Promise<void>>();
const projectionCache = new Map<string, SessionProjection>();
function cacheProjection(projection: SessionProjection): void {
  projectionCache.delete(projection.sessionId);
  projectionCache.set(projection.sessionId, projection);
  while (projectionCache.size > 6) projectionCache.delete(projectionCache.keys().next().value!);
}
function readProjection(sessionId: string, signal?: AbortSignal): Promise<SessionProjection> {
  const read = (projectionReadQueues.get(sessionId) ?? Promise.resolve())
    .then(() => {
      signal?.throwIfAborted();
      return getLocalAgentProjection(sessionId, signal);
    })
    .then((projection) => {
      signal?.throwIfAborted();
      const cached = projectionCache.get(sessionId);
      const current = cached && !shouldApplyProjection(cached, projection) ? cached : projection;
      cacheProjection(current);
      return current;
    });
  const queue = read.then(() => undefined, () => undefined);
  projectionReadQueues.set(sessionId, queue);
  void queue.then(() => {
    if (projectionReadQueues.get(sessionId) === queue) projectionReadQueues.delete(sessionId);
  });
  return read;
}
let activeSubmissionCount = 0;
const decisionSubmissions = new Map<string, Promise<CommandReply>>();
let projectionRefreshFlight: {
  sessionId: string | null;
  generation: number;
  promise: Promise<void>;
} | null = null;

const store = create<LocalAgentState>((set, get) => ({
  sessionId: null,
  draftProjectId: null,
  selectedProfileId: null,
  reasoningEffortOverride: null,
  modelSettingsBusy: false,
  profiles: [],
  connections: [],
  defaultProfileId: null,
  catalog: EMPTY_CATALOG,
  sessionStatuses: {},
  statusError: null,
  pluginCatalog: EMPTY_PLUGIN_CATALOG,
  projection: null,
  loading: false,
  submitting: false,
  catalogBusy: false,
  error: null,
  errorSource: null,

  initialize: async () => {
    if (initialization) return await initialization;
    const currentGeneration = advanceView();
    initialization = (async () => {
      set({ loading: true, error: null, errorSource: null });
      try {
        const [catalog, pluginCatalog, profileResult] = await Promise.all([
          getConversationCatalog(),
          getPluginCatalog(),
          getLlmProfiles(),
        ]);
        const profiles = profileResult.ok
          ? (profileResult.data?.profiles ?? [])
          : [];
        const defaultProfileId = initialProfileId(
          profiles,
          profileResult.ok ? profileResult.data?.defaultProfileId : undefined,
        );
        // Catalog readiness is independent of navigation during startup.
        set({ catalog, pluginCatalog, profiles, connections: profileResult.data?.connections ?? [], defaultProfileId });
        void get().refresh();
        if (currentGeneration !== generation) {
          set({
            selectedProfileId: get().selectedProfileId ?? defaultProfileId,
            ...(!get().selectedProfileId && !get().sessionId ? {
              reasoningEffortOverride: profiles.find(profile => profile.id === defaultProfileId)?.reasoningEffort ?? null,
            } : {}),
          });
          if (!profileResult.ok) {
            set({
              error: profileResult.message ?? 'llm_profiles_unavailable',
              errorSource: 'profiles',
            });
          }
          return;
        }
        set({
          catalog,
          pluginCatalog,
          profiles,
          defaultProfileId,
          selectedProfileId: defaultProfileId,
          reasoningEffortOverride: profiles.find(profile => profile.id === defaultProfileId)?.reasoningEffort ?? null,
          sessionId: null,
          projection: null,
          draftProjectId: null,
          loading: false,
          error: profileResult.ok ? null : (profileResult.message ?? 'llm_profiles_unavailable'),
          errorSource: profileResult.ok ? null : 'profiles',
        });
        const restored = takeRestoredInterfaceView<{ sessionId: string | null; draftProjectId: string | null } | null>('conversation', null);
        if (restored?.sessionId && catalog.sessions.some(item => item.id === restored.sessionId)) await get().activateSession(restored.sessionId);
        else if (restored?.draftProjectId && catalog.projects.some(item => item.id === restored.draftProjectId)) set({ draftProjectId: restored.draftProjectId });
      } catch (error) {
        if (currentGeneration === generation) {
          set({
            loading: false,
            error: errorMessage(error),
            errorSource: 'initialization',
          });
        }
      }
    })();
    try {
      await initialization;
    } finally {
      initialization = null;
    }
  },

  refreshProfiles: async () => {
    const profileResult = await getLlmProfiles();
    if (!profileResult.ok) {
      set({
        error: profileResult.message ?? 'llm_profiles_unavailable',
        errorSource: 'profiles',
      });
      return;
    }
    const profiles = (profileResult.data?.profiles ?? []);
    const defaultProfileId = initialProfileId(
      profiles,
      profileResult.data?.defaultProfileId,
    );
    set((state) => {
      const summary = state.sessionId
        ? state.catalog.sessions.find((session) => session.id === state.sessionId)
        : undefined;
      return {
        profiles,
        connections: profileResult.data?.connections ?? [],
        defaultProfileId,
        selectedProfileId: state.selectedProfileId ?? summary?.profileId ?? defaultProfileId,
        ...(!state.selectedProfileId && !state.sessionId ? {
          reasoningEffortOverride: profiles.find(profile => profile.id === defaultProfileId)?.reasoningEffort ?? null,
        } : {}),
        ...(state.errorSource === 'profiles' ? { error: null, errorSource: null } : {}),
      };
    });
  },

  refreshCatalog: async () => {
    try {
      const catalog = await getConversationCatalog();
      set((state) => ({
        catalog,
        ...(state.errorSource === 'catalog' ? { error: null, errorSource: null } : {}),
      }));
    } catch (error) {
      set({ error: errorMessage(error), errorSource: 'catalog' });
    }
  },

  refreshPluginCatalog: async () => {
    try {
      const pluginCatalog = await getPluginCatalog();
      set((state) => ({
        pluginCatalog,
        ...(state.errorSource === 'pluginCatalog'
          ? { error: null, errorSource: null }
          : {}),
      }));
    } catch (error) {
      set({ error: errorMessage(error), errorSource: 'pluginCatalog' });
    }
  },

  startNewSession: (projectId = null) => {
    advanceView();
    activeSubmissionCount = 0;
    set({
      sessionId: null,
      projection: null,
      draftProjectId: projectId,
      modelSettingsBusy: false,
      selectedProfileId: get().defaultProfileId,
      reasoningEffortOverride: get().profiles.find(profile => profile.id === get().defaultProfileId)?.reasoningEffort ?? null,
      loading: false,
      submitting: activeSubmissionCount > 0,
      error: null,
      errorSource: null,
    });
  },

  activateSession: async (sessionId) => {
    if (get().sessionId === sessionId && (get().projection || get().loading)) return;
    const summary = get().catalog.sessions.find((session) => session.id === sessionId);
    if (!summary) {
      set({ error: 'conversation_session_not_found', errorSource: 'operation' });
      return;
    }
    const currentGeneration = advanceView();
    const signal = viewReadController.signal;
    activeSubmissionCount = 0;
    const cached = projectionCache.get(sessionId) ?? null;
    if (cached) cacheProjection(cached);
    set({
      submitting: false,
      modelSettingsBusy: false,
      loading: !cached,
      error: null,
      errorSource: null,
      sessionId,
      selectedProfileId: cached?.modelSettings?.profileId ?? summary.profileId ?? null,
      reasoningEffortOverride: cached?.modelSettings?.reasoningEffortOverride ?? null,
      projection: cached,
      draftProjectId: null,
    });
    if (cached) {
      // Paint the cached view immediately; the small status reply decides whether
      // any full snapshot is needed. Viewing history never reopens a Session run.
      await get().refresh();
      return;
    }
    try {
      const projection = await readProjection(sessionId, signal);
      if (currentGeneration !== generation) return;
      set({
        sessionId,
        selectedProfileId: projection.modelSettings?.profileId ?? summary.profileId ?? null,
        reasoningEffortOverride: projection.modelSettings?.reasoningEffortOverride ?? null,
        projection,
        loading: false,
      });
    } catch (error) {
      if (currentGeneration === generation) {
        set({
          loading: false,
          error: errorMessage(error),
          errorSource: 'projection',
        });
      }
    }
  },

  selectModel: async (profileId, reasoningEffortOverride) => {
    const profile = get().profiles.find(profile => profile.id === profileId && profile.enabled);
    if (!profile || (profile.thinking !== 'disabled' && !(reasoningEffortOverride ?? profile.reasoningEffort))) return false;
    return saveModelSettings(set, get, { profileId, reasoningEffortOverride });
  },

  refresh: async () => {
    const { sessionId } = get();
    const refreshGeneration = generation;
    const signal = viewReadController.signal;
    if (
      projectionRefreshFlight?.sessionId === sessionId
      && projectionRefreshFlight.generation === refreshGeneration
    ) {
      return await projectionRefreshFlight.promise;
    }

    const promise = (async () => {
      const statuses = (async () => {
        try {
          const items = await getConversationStatuses(signal);
          if (generation !== refreshGeneration) return null;
          set((state) => {
            const sessionStatuses = Object.fromEntries(items.map((item) => {
              const current = state.sessionStatuses[item.sessionId];
              return [item.sessionId, current && current.revision > item.revision ? current : item];
            }));
            if (state.statusError === null
              && JSON.stringify(sessionStatuses) === JSON.stringify(state.sessionStatuses)) return state;
            return { sessionStatuses, statusError: null };
          });
          return items;
        } catch (error) {
          if (generation === refreshGeneration) set({ sessionStatuses: {}, statusError: errorMessage(error) });
          return null;
        }
      })();
      try {
        const items = await statuses;
        if (!sessionId || generation !== refreshGeneration || (get().loading && !get().projection)) return;
        const cached = projectionCache.get(sessionId);
        const status = items?.find((item) => item.sessionId === sessionId);
        if (cached && !cached.agentContext && !cached.agentChildren?.length && get().errorSource !== 'projection' && status?.revision === cached.revision && !cached.assistantDraft
          && !['running', 'waiting', 'releasing'].includes(status.run?.status ?? '')) {
          return;
        }
        const projection = await readProjection(sessionId, signal);
        if (generation !== refreshGeneration || get().sessionId !== sessionId) return;
        set((state) => {
          const nextProjection = shouldApplyProjection(state.projection, projection)
            ? projection
            : state.projection;
          if (
            nextProjection === state.projection
            && state.errorSource !== 'projection'
          ) return state;
          return {
            projection: nextProjection,
            ...projectModelSettings(nextProjection),
            ...(state.errorSource === 'projection'
              ? { error: null, errorSource: null }
              : {}),
          };
        });
      } catch (error) {
        if (generation === refreshGeneration && get().sessionId === sessionId) {
          set({ error: errorMessage(error), errorSource: 'projection' });
        }
      } finally {
        await statuses;
      }
    })();
    projectionRefreshFlight = { sessionId, generation: refreshGeneration, promise };
    try {
      await promise;
    } finally {
      if (projectionRefreshFlight?.promise === promise) projectionRefreshFlight = null;
    }
  },

  sendMessage: async (
    text,
    filesystemPaths = [],
    pluginSelections = [],
    pastedTexts = [],
    onSessionCreated,
  ) => {
    const trimmed = text.trim();
    const inputError = !trimmed && !pastedTexts.length && !filesystemPaths.length
      ? 'message_empty'
      : trimmed.startsWith('/') ? `conversation_command_unknown:${trimmed}` : null;
    if (inputError) {
      set({ error: inputError, errorSource: 'command' });
      throw new Error(inputError);
    }
    return await submitNewRun(
      set,
      get,
      'message.submit',
      text,
      filesystemPaths,
      pluginSelections,
      pastedTexts,
      onSessionCreated,
    );
  },

  focusContext: async (
    task,
    filesystemPaths = [],
    pluginSelections = [],
    pastedTexts = [],
    onSessionCreated,
  ) => {
    if (!task.trim()) throw new Error('context_focus_task_empty');
    const { projection } = get();
    if (projection?.pendingPlan || projection?.pendingApproval || projection?.pendingInteraction) {
      throw new Error('context_focus_run_waiting');
    }
    return await submitNewRun(
      set,
      get,
      'context.focus',
      task,
      filesystemPaths,
      pluginSelections,
      pastedTexts,
      onSessionCreated,
    );
  },

  setMessageFeedback: async (messageId, feedback) => {
    const state = get();
    const sessionId = requiredSession(state);
    const target = state.projection?.messages.find((message) => message.messageId === messageId);
    if (!target || target.role !== 'assistant') throw new Error('message_feedback_target_invalid');
    return await submitExisting(set, get, {
      schemaVersion: CONVERSATION_COMMAND_VERSION,
      type: 'message.feedback.set',
      commandId: nextId('command'),
      sessionId,
      messageId,
      feedback,
    });
  },

  editMessage: async (messageId, text, expectedRevision) => {
    const state = get();
    const sessionId = requiredSession(state);
    const target = state.projection?.messages.find((message) => message.messageId === messageId);
    if (!target || target.role !== 'user' || target.replyToInteraction) throw new Error('message_edit_target_invalid');
    return await submitExisting(set, get, {
      schemaVersion: CONVERSATION_COMMAND_VERSION, type: 'message.edit', commandId: nextId('command'),
      sessionId, messageId, text, expectedRevision,
    });
  },

  attachSessionDirectory: async (canonicalRoot) => {
    const sessionId = requiredSession(get());
    set({ catalogBusy: true, error: null, errorSource: null });
    try {
      const projection = await attachConversationDirectoryIndex(sessionId, canonicalRoot);
      if (get().sessionId !== sessionId) throw new Error('conversation_session_changed');
      set({ projection });
    } catch (error) {
      set({ error: errorMessage(error), errorSource: 'operation' });
      throw error;
    } finally {
      set({ catalogBusy: false });
    }
  },

  detachSessionDirectory: async (workspaceId) => {
    const sessionId = requiredSession(get());
    set({ catalogBusy: true, error: null, errorSource: null });
    try {
      const projection = await detachConversationDirectoryIndex(sessionId, workspaceId);
      if (get().sessionId !== sessionId) throw new Error('conversation_session_changed');
      set({ projection });
    } catch (error) {
      set({ error: errorMessage(error), errorSource: 'operation' });
      throw error;
    } finally {
      set({ catalogBusy: false });
    }
  },

  rebindHost: async (hostBinding) => {
    const { sessionId, projection } = get();
    const run = projection?.run;
    if (!sessionId || run?.status !== 'waiting' || !run.hostBinding) throw new Error('host_rebind_not_waiting');
    return submitCommandAndReconcile(set, get, {
      schemaVersion: CONVERSATION_COMMAND_VERSION, type: 'run.host.rebind', commandId: `command:${crypto.randomUUID()}`,
      sessionId, runId: run.runId, expectedHostBinding: run.hostBinding, hostBinding,
    });
  },
  respondInteraction: async (response, interactionId) => {
    const state = get();
    const sessionId = requiredSession(state);
    const interaction = interactionId ? state.projection?.interactions.find(item => item.interactionId === interactionId)
      : state.projection?.pendingInteraction;
    if (!interaction || interaction.status !== 'pending' || !response.trim()) throw new Error('interaction_response_missing');
    return await submitDecision(
      set,
      get,
      `interaction:${sessionId}:${interaction.runId}:${interaction.interactionId}`,
      () => ({
        schemaVersion: CONVERSATION_COMMAND_VERSION,
        type: 'interaction.respond',
        commandId: nextId('command'),
        sessionId,
        runId: interaction.runId,
        interactionId: interaction.interactionId,
        response: response.trim(),
      }),
    );
  },

  setPermissions: async (patches) => {
    const sessionId = requiredSession(get());
    return submitDecision(set, get, `permissions:${sessionId}`, () => ({
      schemaVersion: CONVERSATION_COMMAND_VERSION, type: 'session.permissions.set',
      commandId: nextId('command'), sessionId, patches,
    }));
  },
  revokeAuthorization: async (authorityId) => {
    const sessionId = requiredSession(get());
    const grant = get().projection?.shellAuthorizations.find(item => item.authorityId === authorityId);
    if (!grant) throw new Error('approval_grant_missing');
    return submitDecision(set, get, `revoke:${sessionId}:${authorityId}`, () => ({
      schemaVersion: CONVERSATION_COMMAND_VERSION, type: 'approval.revoke',
      commandId: nextId('command'), sessionId, runId: grant.runId, authorityId,
    }));
  },

  respondApproval: async (decision, authorizationScope) => {
    const state = get();
    const sessionId = requiredSession(state);
    const approval = state.projection?.pendingApproval;
    if (!approval) throw new Error('approval_response_missing');
    return await submitDecision(
      set,
      get,
      `approval:${sessionId}:${approval.runId}:${approval.approvalId}`,
      () => ({
        schemaVersion: CONVERSATION_COMMAND_VERSION,
        type: 'approval.respond',
        commandId: nextId('command'),
        sessionId,
        runId: approval.runId,
        callId: approval.callId,
        approvalId: approval.approvalId,
        decision,
        ...(authorizationScope ? { authorizationScope } : {}),
      }),
    );
  },

  respondPlan: async (response) => await submitPlanResponse(set, get, response),

  cancelRun: async () => {
    const state = get();
    const sessionId = requiredSession(state);
    const runId = state.projection?.run?.runId;
    if (!runId) throw new Error('conversation_run_missing');
    return await submitDecision(set, get, `cancel:${sessionId}:${runId}`, () => ({
      schemaVersion: CONVERSATION_COMMAND_VERSION,
      type: 'run.cancel',
      commandId: nextId('command'),
      sessionId,
      runId,
    }));
  },

  createProject: async (title, workspacePaths = []) => {
    await mutateCatalog(set, async () => await createProjectRequest({ title, workspacePaths }));
  },

  updateProject: async (projectId, input) => {
    await mutateCatalog(set, async () => await updateProjectRequest(projectId, input));
  },

  addProjectWorkspace: async (projectId, canonicalRoot) => {
    const management = await getConversationCatalogManagement();
    const project = management.projects.find((candidate) => candidate.id === projectId);
    if (!project) throw new Error('conversation_project_not_found');
    const roots = rootsForProject(management, project.workspaceBindings.map((binding) => binding.workspaceId));
    if (!roots.includes(canonicalRoot)) roots.push(canonicalRoot);
    await get().updateProject(projectId, { workspacePaths: roots });
  },

  removeProjectWorkspace: async (projectId, workspaceId) => {
    const management = await getConversationCatalogManagement();
    const project = management.projects.find((candidate) => candidate.id === projectId);
    if (!project) throw new Error('conversation_project_not_found');
    const roots = rootsForProject(
      management,
      project.workspaceBindings
        .filter((binding) => binding.workspaceId !== workspaceId)
        .map((binding) => binding.workspaceId),
    );
    await get().updateProject(projectId, { workspacePaths: roots });
  },

  getProjectWorkspacePaths: async (projectId) => {
    const management = await getConversationCatalogManagement();
    const project = management.projects.find((candidate) => candidate.id === projectId);
    if (!project) throw new Error('conversation_project_not_found');
    return project.workspaceBindings.map((binding) => {
      const record = management.workspaces.find((workspace) => (
        workspace.workspaceId === binding.workspaceId
      ));
      if (!record) throw new Error('conversation_workspace_record_missing');
      return {
        workspaceId: record.workspaceId,
        displayName: record.displayName,
        canonicalRoot: record.canonicalRoot,
      };
    });
  },

  deleteProject: async (projectId) => {
    await mutateCatalog(set, async () => await deleteProjectRequest(projectId));
    if (get().draftProjectId === projectId) get().startNewSession(null);
  },

  updateSession: async (sessionId, input) => {
    requiredSummary(get().catalog, sessionId);
    await mutateCatalog(set, async () => await updateSessionRequest(sessionId, input));
  },

  deleteSession: async (sessionId) => {
    const summary = requiredSummary(get().catalog, sessionId);
    const projectId = summary.projectId;
    await mutateCatalog(set, async () => await deleteSessionRequest(sessionId));
    projectionCache.delete(sessionId);
    if (get().sessionId === sessionId) get().startNewSession(projectId ?? null);
  },

  clearError: () => set({ error: null, errorSource: null }),
}));

async function submitPlanResponse(
  set: StoreSet,
  get: () => LocalAgentState,
  response: PlanResponse,
): Promise<CommandReply> {
  const state = get();
  const sessionId = requiredSession(state);
  const plan = state.projection?.pendingPlan;
  if (!plan) throw new Error('plan_response_missing');
  return await submitDecision(
    set,
    get,
    `plan:${sessionId}:${plan.runId}:${plan.planId}:${plan.revision}`,
    () => ({
      schemaVersion: CONVERSATION_COMMAND_VERSION,
      type: 'plan.respond',
      commandId: nextId('command'),
      sessionId,
      runId: plan.runId,
      planId: plan.planId,
      revision: plan.revision,
      response,
    }),
  );
}

async function submitNewRun(
  set: StoreSet,
  get: StoreGet,
  type: 'message.submit' | 'context.focus',
  text: string,
  filesystemPaths: PendingFilesystemPath[],
  pluginSelections: PluginSelectionInput[],
  pastedTexts: PastedTextInput[],
  onSessionCreated?: (sessionId: string) => void,
): Promise<CommandReply> {
  const submissionGeneration = beginSubmission(set);
  try {
    if (filesystemPaths.length + pastedTexts.length > 8) throw new Error('message_filesystem_reference_limit');
    const messageProfileId = get().selectedProfileId;
    const reasoningEffortOverride = get().reasoningEffortOverride;
    const activeRun = get().projection?.run;
    const queuedMessage = type === 'message.submit' && activeRun && ['running', 'waiting'].includes(activeRun.status);
    if (!queuedMessage && (!messageProfileId || !get().profiles.some((profile) => profile.id === messageProfileId && profile.enabled))) throw new Error('llm_profile_unavailable');
    const pluginCatalog = get().pluginCatalog;
    const effectivePluginSelections = requiredFilesystemPluginSelections(
      pluginCatalog,
      filesystemPaths,
      pluginSelections,
    );
    for (const selection of effectivePluginSelections) {
      const plugin = pluginCatalog.plugins.find((item) => item.uri === selection.uri);
      if (!plugin?.enabled || !plugin.available) {
        throw new Error(plugin?.error ? `${plugin.error.code}: ${plugin.error.message}` : `plugin_selection_unavailable:${selection.uri}`);
      }
    }
    let { sessionId } = get();
    if (!sessionId) {
      const { draftProjectId } = get();
      const created = await createLocalAgentSession({
        ...(draftProjectId ? { projectId: draftProjectId } : {}),
      });
      if (generation !== submissionGeneration) throw new Error('conversation_session_changed');
      sessionId = created.sessionId;
      onSessionCreated?.(sessionId);
      set({ sessionId, projection: created, draftProjectId: null });
      await get().refreshCatalog();
    }
    const filesystemReferences = filesystemPaths.length
      ? await resolveConversationFilesystemReferences(sessionId, filesystemPaths)
      : [];
    for (const paste of pastedTexts) {
      filesystemReferences.push(await uploadConversationPastedText(sessionId, paste.inputId, paste.text));
    }
    if (generation !== submissionGeneration || get().sessionId !== sessionId) throw new Error('conversation_session_changed');
    const guidanceReferences = effectivePluginSelections.flatMap((selection) => {
      const reference = pluginCatalog.plugins.find((item)=>item.uri===selection.uri)?.reference;
      return reference ? [{referenceId:selection.selectionId,uri:selection.uri,label:selection.label,...reference}] : [];
    });
    const executionSelections = effectivePluginSelections.filter((selection)=>!pluginCatalog.plugins.find((item)=>item.uri===selection.uri)?.reference);
    const common = {
      schemaVersion: CONVERSATION_COMMAND_VERSION,
      commandId: nextId('command'),
      sessionId,
      ...(filesystemReferences.length
        ? {
            filesystemReferences: filesystemReferences.map((reference) => ({
              ...reference,
            })),
          }
        : {}),
      ...(!queuedMessage ? { profileId: messageProfileId!, reasoningEffortOverride } : {}),
      ...(guidanceReferences.length ? {guidanceReferences} : {}),
      ...(executionSelections.length
        ? {
            pluginCatalogRevision: pluginCatalog.revision,
            pluginSelections: executionSelections.map((selection) => ({ ...selection })),
          }
        : {}),
    };
    const command: ConversationCommand = type === 'message.submit'
      ? { ...common, type, text, ...(queuedMessage ? { runId: activeRun.runId } : {}) }
      : { ...common, type, task: text };
    const reply = await submitCommandAndReconcile(set, get, command);
    await Promise.all([
      get().refreshCatalog(),
      get().refreshPluginCatalog(),
    ]);
    return reply;
  } catch (error) {
    if (errorMessage(error).includes('plugin_selection_stale')) {
      await get().refreshPluginCatalog();
    }
    if (generation === submissionGeneration) set({ error: errorMessage(error), errorSource: 'command' });
    throw error;
  } finally {
    endSubmission(set, submissionGeneration);
  }
}

async function submitDecision(
  set: StoreSet,
  get: StoreGet,
  decisionKey: string,
  command: () => ConversationCommand,
): Promise<CommandReply> {
  const existing = decisionSubmissions.get(decisionKey);
  if (existing) return await existing;
  const submission = submitExisting(set, get, command());
  decisionSubmissions.set(decisionKey, submission);
  try {
    return await submission;
  } finally {
    if (decisionSubmissions.get(decisionKey) === submission) {
      decisionSubmissions.delete(decisionKey);
    }
  }
}

async function submitExisting(
  set: StoreSet,
  get: () => LocalAgentState,
  command: ConversationCommand,
): Promise<CommandReply> {
  const submissionGeneration = beginSubmission(set);
  try {
    return await submitCommandAndReconcile(set, get, command);
  } catch (error) {
    if (generation === submissionGeneration) set({ error: errorMessage(error), errorSource: 'command' });
    throw error;
  } finally {
    endSubmission(set, submissionGeneration);
  }
}

async function submitCommandAndReconcile(
  set: StoreSet,
  get: StoreGet,
  command: ConversationCommand,
): Promise<CommandReply> {
  const commandGeneration = generation;
  const reply = await submitLocalAgentCommand(command);
  if (reply.status === 'accepted') {
    const profileId = command.type === 'message.submit' || command.type === 'context.focus' ? command.profileId : undefined;
    if (profileId) set({ defaultProfileId: profileId });
  }
  const rejection = reply.status === 'rejected' ? commandRejectionMessage(reply) : null;
  try {
    await reconcileProjectionAfterReply(set, get, command.sessionId, reply.revision, commandGeneration);
  } catch (error) {
    const reconciliation = `conversation_projection_reconcile_failed:${errorMessage(error)}`;
    throw new Error(rejection ? `${rejection};${reconciliation}` : reconciliation);
  }
  if (rejection) throw new Error(rejection);
  if (generation === commandGeneration) set({ error: null, errorSource: null });
  return reply;
}

async function reconcileProjectionAfterReply(
  set: StoreSet,
  get: StoreGet,
  sessionId: string,
  replyRevision: number,
  commandGeneration: number,
): Promise<void> {
  const projection = await readProjection(sessionId);
  if (projection.revision < replyRevision) {
    throw new Error(
      `conversation_projection_behind_command_reply:${projection.revision}:${replyRevision}`,
    );
  }
  if (get().sessionId !== sessionId || generation !== commandGeneration) return;
  set((state) => {
    const nextProjection = shouldApplyProjection(state.projection, projection) ? projection : state.projection;
    return { projection: nextProjection, ...projectModelSettings(nextProjection) };
  });
}

function projectModelSettings(projection: SessionProjection | null): Partial<LocalAgentState> {
  return projection?.modelSettings ? {
    selectedProfileId: projection.modelSettings.profileId,
    reasoningEffortOverride: projection.modelSettings.reasoningEffortOverride,
  } : {};
}

async function saveModelSettings(set: StoreSet, get: StoreGet, settings: SessionModelSettings): Promise<boolean> {
  if (get().modelSettingsBusy) return false;
  const sessionId = get().sessionId;
  const settingsGeneration = generation;
  set({ modelSettingsBusy: true });
  try {
    if (sessionId) {
      await submitCommandAndReconcile(set, get, {
        schemaVersion: CONVERSATION_COMMAND_VERSION, type: 'session.model-settings.set',
        sessionId, commandId: nextId('command'), settings,
      });
    }
    const profile = get().profiles.find(item => item.id === settings.profileId);
    if (!profile) throw new Error('llm_profile_unavailable');
    const remembered = { ...profile, reasoningEffort: profile.thinking === 'disabled'
      ? undefined : settings.reasoningEffortOverride ?? profile.reasoningEffort };
    const saved = await patchLlmProfiles({ profile: remembered });
    if (!saved.ok) throw new Error(saved.message ?? saved.error ?? 'reasoning_preference_save_failed');
    set(state => ({ profiles: state.profiles.map(item => item.id === profile.id ? remembered : item) }));
    if (!sessionId && generation === settingsGeneration && !get().sessionId) {
      set({ selectedProfileId: settings.profileId, reasoningEffortOverride: settings.reasoningEffortOverride,
        error: null, errorSource: null });
    }
    return generation === settingsGeneration;
  } catch (error) {
    if (generation === settingsGeneration && get().sessionId === sessionId) set({ error: errorMessage(error), errorSource: 'command' });
    return false;
  } finally {
    if (generation === settingsGeneration) set({ modelSettingsBusy: false });
  }
}

function beginSubmission(set: StoreSet): number {
  activeSubmissionCount += 1;
  set({ submitting: true, error: null, errorSource: null });
  return generation;
}

function endSubmission(set: StoreSet, submissionGeneration: number): void {
  if (generation !== submissionGeneration) return;
  activeSubmissionCount -= 1;
  set({ submitting: activeSubmissionCount > 0 });
}

async function mutateCatalog(
  set: StoreSet,
  operation: () => Promise<ConversationCatalog>,
): Promise<void> {
  set({ catalogBusy: true, error: null, errorSource: null });
  try {
    const activeCatalog = await operation();
    set({ catalog: activeCatalog });
  } catch (error) {
    set({ error: errorMessage(error), errorSource: 'operation' });
    throw error;
  } finally {
    set({ catalogBusy: false });
  }
}

function rootsForProject(
  management: Awaited<ReturnType<typeof getConversationCatalogManagement>>,
  workspaceIds: readonly string[],
): string[] {
  return workspaceIds.map((workspaceId) => {
    const record = management.workspaces.find((workspace) => workspace.workspaceId === workspaceId);
    if (!record) throw new Error('conversation_workspace_record_missing');
    return record.canonicalRoot;
  });
}

function commandRejectionMessage(reply: CommandReply): string {
  return `${reply.error?.code ?? 'conversation_command_rejected'}:${reply.error?.message ?? ''}`;
}

function requiredSession(state: LocalAgentState): string {
  if (!state.sessionId) throw new Error('conversation_session_missing');
  return state.sessionId;
}

function requiredSummary(catalog: ConversationCatalog, sessionId: string) {
  const summary = catalog.sessions.find((session) => session.id === sessionId);
  if (!summary) throw new Error('conversation_session_not_found');
  return summary;
}

function initialProfileId(
  profiles: readonly LlmProviderProfile[],
  preferred: string | undefined,
): string | null {
  return preferred ?? profiles.find((profile) => profile.enabled)?.id ?? null;
}

function shouldApplyProjection(
  current: SessionProjection | null,
  incoming: SessionProjection,
): boolean {
  if (!current || incoming.revision > current.revision) return true;
  if (incoming.revision < current.revision) return false;
  // Reads are serialized. The producer owns all live fields, including inherited
  // permissions that can change without a fact in this Session's own journal.
  // Equality only avoids an unnecessary render; it must not whitelist updates.
  return JSON.stringify(current) !== JSON.stringify(incoming);
}

function requiredFilesystemPluginSelections(
  catalog: PluginCatalogProjection,
  filesystemPaths: readonly PendingFilesystemPath[],
  explicitSelections: readonly PluginSelectionInput[],
): PluginSelectionInput[] {
  const selections = explicitSelections.map((selection) => ({ ...selection }));
  const selectedUris = new Set(selections.map((selection) => selection.uri));
  const requiredMediaTypes = new Set(filesystemPaths.flatMap((reference) => (
    reference.kind === 'file' && reference.path.toLocaleLowerCase().endsWith('.pdf')
      ? ['application/pdf']
      : []
  )));
  for (const mediaType of requiredMediaTypes) {
    const matches = catalog.plugins.filter((plugin) => (
      plugin.activationMediaTypes.includes(mediaType)
    ));
    if (matches.length !== 1) {
      throw new Error(`plugin_selection_unavailable:${mediaType}`);
    }
    const plugin = matches[0]!;
    if (!plugin.enabled || !plugin.available) {
      throw new Error(plugin.error ? `${plugin.error.code}: ${plugin.error.message}` : `plugin_selection_unavailable:${plugin.uri}`);
    }
    if (selectedUris.has(plugin.uri)) continue;
    selections.push({
      selectionId: nextId('plugin-selection'),
      uri: plugin.uri,
      label: plugin.displayName,
    });
    selectedUris.add(plugin.uri);
  }
  return selections;
}

function nextId(kind: string): string {
  const random = globalThis.crypto?.randomUUID?.()
    ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  return `${kind}:${random}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

return store;
}

export const useLocalAgentStore = createLocalAgentStore();
