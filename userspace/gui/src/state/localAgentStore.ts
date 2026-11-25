import { archivedMeasurements } from '../services/desktopHistory';
import type { PastedImageInput } from '../services/pastedImage';
import type { UserSettings, ShellAuthorizationScope, FilesystemReference, GuidanceReference } from '@achbit/protocol';
import { takeRestoredInterfaceView } from '../services/interfaceReload';
import { create } from 'zustand';
import type {
  AgentSettings,
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
} from '@achbit/protocol';
import { CONVERSATION_COMMAND_VERSION, connectedModelReasoningEfforts, decodeAgentSettings } from '@achbit/protocol';
import { getLlmProfiles, patchLlmProfiles } from '../services/apiClient';
import { useSettingsStore } from './settingsStore';
import { normalizeUiLanguage, t } from '../i18n';
import { retiredDraftSkillNotice } from '../pluginLocalization';
import { runHandoffNotice } from './handoffNotice';
import { selectPendingApproval, type ApprovalIdentity } from '../components/local-agent/composerDecisions';
import { reportedWindowRounds, sessionView, type CachedSessionView, type ContextWindowReading } from './contextWindowReading';
import { uiEvents } from './uiEvents';
import { ChildDeliveryIndex } from '../components/local-agent/childDeliveryIndex';
import { writePosition, type ReadingPosition } from './readingPosition';
import { dismissUnappliedInputs } from './unappliedInputReminders';
import type { PastedTextInput } from '../services/pastedText';
import { supportsNativeFileInput } from '../services/modelFileInput';
import {
  attachConversationDirectoryIndex,
  createConversationProject as createProjectRequest,
  createLocalAgentSession,
  ConversationRequestError,
  detachConversationDirectoryIndex,
  deleteConversationProject as deleteProjectRequest,
  deleteConversationSession as deleteSessionRequest,
  getConversationCatalog,
  getConversationStatuses,
  readMeasuredWindowHistory,
  watchConversationCatalog,
  getConversationCatalogManagement,
  getPluginCatalog,
  getDesktopSessionProjection,
  resolveConversationFilesystemReferences,
  submitLocalAgentCommand,
  uploadConversationPastedText,
  uploadConversationPastedImage,
  updateConversationProject as updateProjectRequest,
  updateConversationSession as updateSessionRequest,
} from '../services/localAgentApi';


let retryCatalogObservation: (() => void) | null = null;

const EMPTY_CATALOG: ConversationCatalog = { projects: [], sessions: [] };
const EMPTY_PLUGIN_CATALOG: PluginCatalogProjection = { revision: 'plugin-catalog:empty', plugins: [] };

interface RetainedMessageResources {
  /** GUI error ownership; excluded from command construction. */
  submissionId?: string;
  filesystemReferences?: FilesystemReference[];
  guidanceReferences?: GuidanceReference[];
}

interface PendingFilesystemPath {
  path: string;
  kind: 'file' | 'directory';
}

type StoreErrorSource =
  | 'initialization'
  | 'contextHistory'
  | 'projection'
  | 'catalog'
  | 'pluginCatalog'
  | 'profiles'
  | 'command'
  | 'operation'
  | { kind: 'input'; submissionId: string };

type ReadStatus = { phase: 'loading' } | { phase: 'ready' } | { phase: 'error'; message: string };
const reading: ReadStatus = { phase: 'loading' };
const ready: ReadStatus = { phase: 'ready' };

/** The workbench reveals the selected Session when its visible regions have their facts. */
export function conversationOpening(state: LocalAgentState): ReadStatus {
  const id = state.sessionId;
  if (!id) return ready;
  if (state.projection?.sessionId === id && state.profileRead.phase === 'ready') return ready;
  if (state.profileRead.phase === 'error') return state.profileRead;
  const error = state.errorSource === 'initialization' || state.errorSource === 'projection' ? state.error : null;
  return error ? { phase: 'error', message: error } : reading;
}

type PlanTarget = Pick<NonNullable<SessionProjection['pendingPlan']>, 'runId' | 'planId' | 'revision'> & { sessionId: string };

export interface LocalAgentState {
  welcomeIndex: number;
  sessionId: string | null;
  draftProjectId: string | null;
  selectedProfileId: string | null;
  reasoningEffortOverride: LlmReasoningEffort | null;
  modelSettingsBusy: boolean;
  draftSubagentSettings: AgentSettings | null;
  subagentSettingsBusy: boolean;
  profiles: LlmProviderProfile[];
  profileRead: ReadStatus;
  connections: ModelConnection[];
  defaultProfileId: string | null;
  catalog: ConversationCatalog;
  catalogStatus: 'pending' | 'ready' | 'error';
  catalogWatchError: string | null;
  sessionStatuses: Record<string, ConversationSessionStatus>;
  statusError: string | null;
  pluginCatalog: PluginCatalogProjection;
  projection: SessionProjection | null;
  contextWindowReading: ContextWindowReading | null;
  rememberReadingAnchor(sessionId: string, anchor: Pick<ReadingPosition, 'key' | 'offset'> | null, sequence?: number): void;
  observeHistory(event: 'ready' | 'change' | 'closed', id?: string): void;
  childOutputs: ChildDeliveryIndex;
  retainedProjections(): SessionProjection[];
  loading: boolean;
  loadingPurpose: 'initialization' | 'session' | null;
  submitting: boolean;
  /** Transport feedback, never a transcript row or permission to start a second run. */
  messageSubmission: { sessionId: string; commandId: string; text: string; phase: 'sending' | 'accepted'; revision?: number } | null;
  catalogBusy: boolean;
  error: string | null;
  errorSource: StoreErrorSource | null;
  runtimeReady: boolean;
  initialize(runtimeReady?: Promise<void>): Promise<void>;
  refreshProfiles(): Promise<void>;
  refreshCatalog(): Promise<void>;
  watchCatalog(): () => void;
  retryCatalogWatch(): void;
  refreshPluginCatalog(): Promise<void>;
  startNewSession(projectId?: string | null): void;
  activateSession(sessionId: string): Promise<void>;
  selectModel(profileId: string, effort: LlmReasoningEffort | null): Promise<boolean>;
  setSubagentSettings(patches: Partial<AgentSettings>): Promise<void>;
  setMode(mode: 'minimal' | 'full'): Promise<CommandReply>;
  refresh(): Promise<void>;
  sendMessage(
    text: string,
    filesystemPaths?: PendingFilesystemPath[],
    pluginSelections?: PluginSelectionInput[],
    pastedTexts?: PastedTextInput[],
    onSessionCreated?: (sessionId: string) => void,
    pastedImages?: PastedImageInput[],
    planMode?: 'manual',
    retained?: RetainedMessageResources,
  ): Promise<CommandReply>;
  focusContext(
    task: string,
    filesystemPaths?: PendingFilesystemPath[],
    pluginSelections?: PluginSelectionInput[],
    pastedTexts?: PastedTextInput[],
    onSessionCreated?: (sessionId: string) => void,
    pastedImages?: PastedImageInput[],
    retained?: RetainedMessageResources,
  ): Promise<CommandReply>;
  setMessageFeedback(messageId: string, feedback: MessageFeedback | null): Promise<CommandReply>;
  editMessage(messageId: string, text: string, expectedRevision: number, submissionId?: string): Promise<CommandReply>;
  attachSessionDirectory(canonicalRoot: string): Promise<void>;
  detachSessionDirectory(workspaceId: string): Promise<void>;
  respondInteraction(response: string, interactionId?: string, submissionId?: string): Promise<CommandReply>;
  rebindHost(hostBinding: HostWindowBinding): Promise<CommandReply>;
  setPermissions(patches: UserSettings): Promise<CommandReply>;
  revokeAuthorization(authorityId: string): Promise<CommandReply>;
  respondApproval(decision: 'allow' | 'deny', authorizationScope: ShellAuthorizationScope | undefined, target: ApprovalIdentity & { sessionId: string }): Promise<CommandReply>;
  respondPlan(response: PlanResponse, target: PlanTarget, submissionId?: string): Promise<CommandReply>;
  continueProvider(sessionId: string, runId: string): Promise<CommandReply>;
  cancelRun(): Promise<CommandReply>;
  cancelTool(sessionId: string, runId: string, callId: string): Promise<CommandReply>;
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
  clearInputError(submissionId: string | undefined): void;
}

type StoreSet = (
  state: Partial<LocalAgentState> | ((state: LocalAgentState) => Partial<LocalAgentState>),
) => void;
type StoreGet = () => LocalAgentState;

export function subagentDefaults(settings: UserSettings): AgentSettings {
  const prefix = 'agent.subagents.';
  return decodeAgentSettings(Object.fromEntries(Object.entries(settings)
    .filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key.slice(prefix.length), value])));
}

export function createLocalAgentStore() {
let initialization: Promise<void> | null = null;
let executionReady: Promise<void> = Promise.resolve();
async function waitForExecution(signal?: AbortSignal): Promise<void> {
  signal?.throwIfAborted();
  if (!signal) return executionReady;
  let abort: () => void = () => {};
  const cancelled = new Promise<never>((_, reject) => {
    abort = () => reject(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
  });
  try { await Promise.race([executionReady, cancelled]); signal.throwIfAborted(); }
  finally { signal.removeEventListener('abort', abort); }
}
let generation = 0;
let catalogVersion = 0;
let viewReadController = new AbortController();
const childOutputs = new ChildDeliveryIndex();
// A complete read that crosses a known Host gap can still be displayed immediately.
let observationGap = 0;
const needsRevalidation = new WeakSet<SessionProjection>();
function observeConnection(ready: boolean) {
  if (childOutputs.connected) observationGap++;
  childOutputs.connection(ready);
}
function observationAtRead() {
  return observationGap && !childOutputs.connected ? null : observationGap;
}
function advanceView(): number {
  viewReadController.abort();
  viewReadController = new AbortController();
  return ++generation;
}
// Draft deltas do not advance the journal revision. Serialize reads across
// polling, navigation and command reconciliation so responses cannot rewind them.
const projectionReadQueues = new Map<string, { tail?: Promise<void>; signal?: AbortSignal }>();
const projectionCache = new Map<string, CachedSessionView>();
let openingFlight: { sessionId: string; generation: number; promise: Promise<void> } | null = null;
function cacheProjection(projection: SessionProjection, observedAt: number | null, selectedId = store.getState().sessionId): CachedSessionView {
  const cached = projectionCache.get(projection.sessionId);
  const active = store.getState();
  const previous = cached ?? (active.projection?.sessionId === projection.sessionId
    ? { projection: active.projection, contextWindowReading: active.contextWindowReading } : undefined);
  const view = previous && !shouldApplyProjection(previous.projection, projection) ? previous : sessionView(projection, previous);
  if (observedAt === observationGap) needsRevalidation.delete(view.projection);
  else needsRevalidation.add(view.projection);
  projectionCache.delete(projection.sessionId);
  projectionCache.set(projection.sessionId, view);
  if (projectionCache.size > 6) {
    const oldest = [...projectionCache.keys()].find(id => id !== selectedId);
    if (oldest) projectionCache.delete(oldest);
  }
  return view;
}
function readSessionView(sessionId: string, signal?: AbortSignal): Promise<CachedSessionView> {
  const previous = projectionReadQueues.get(sessionId);
  const queue = previous && !previous.signal?.aborted ? previous : { signal, tail: undefined };
  projectionReadQueues.set(sessionId, queue);
  const checkOwner = () => {
    signal?.throwIfAborted();
    if (projectionReadQueues.get(sessionId) !== queue) throw new Error('conversation_session_not_found');
  };
  const fetchView = async () => {
      checkOwner();
      const observedAt = observationAtRead();
      let projection = await getDesktopSessionProjection(sessionId, signal);
      checkOwner();
      const observed = store.getState().sessionStatuses[sessionId]?.revision ?? 0;
      if (projection.revision < observed) {
        projection = await getDesktopSessionProjection(sessionId, signal);
        checkOwner();
        if (projection.revision < observed) throw new Error('session_projection_revision_behind');
      }
      const visible = store.getState().projection;
      const previous = projectionCache.get(sessionId)?.projection ?? (visible?.sessionId === sessionId ? visible : undefined);
      const current = cacheProjection(projection, observedAt);
      const notice = runHandoffNotice(previous, current.projection,
        store.getState().profiles.find(profile => profile.id === current.projection.contextHandoff?.profileId)?.name,
        normalizeUiLanguage(useSettingsStore.getState().effectiveSettings['workbench.language']));
      if (notice) uiEvents.publish(notice);
      return current;
  };
  const read = queue.tail ? queue.tail.then(fetchView) : fetchView();
  const tail = queue.tail = read.then(() => undefined, () => undefined);
  void tail.then(() => {
    if (projectionReadQueues.get(sessionId) === queue && queue.tail === tail) projectionReadQueues.delete(sessionId);
  });
  return read;
}
async function freshRun(id: string): Promise<SessionProjection | null> {
  const signal = viewReadController.signal;
  if (!store.getState().runtimeReady) await waitForExecution(signal);
  const previousInput = acceptedInputs.get(id);
  if (previousInput) await previousInput;
  if (openingFlight?.sessionId === id) await openingFlight.promise;
  const state = store.getState();
  if (state.sessionId !== id) throw new Error('conversation_session_changed');
  if (state.errorSource === 'projection') {
    const current = await readSessionView(id, signal);
    signal.throwIfAborted();
    store.setState({ ...current, ...projectModelSettings(current.projection), error: null, errorSource: null });
    return current.projection;
  }
  return state.projection;
}

let activeSubmissionCount = 0;
const decisionSubmissions = new Map<string, Promise<CommandReply>>();
let projectionRefreshFlight: {
  sessionId: string | null;
  generation: number;
  promise: Promise<void>;
} | null = null;


let statusFlight: { owner: number; promise: Promise<ConversationSessionStatus[] | null> } | null = null;
function observeStatuses(set: StoreSet, owner: number, signal: AbortSignal) {
  if (statusFlight?.owner === owner) return statusFlight.promise;
  const promise = getConversationStatuses(signal).then(items => {
    if (generation !== owner) return null;
    set(state => {
      const sessionStatuses = Object.fromEntries(items.map(item => {
        const current = state.sessionStatuses[item.sessionId];
        return [item.sessionId, current && current.revision > item.revision ? current : item];
      }));
      if (state.statusError === null && JSON.stringify(sessionStatuses) === JSON.stringify(state.sessionStatuses)) return state;
      return { sessionStatuses, statusError: null };
    });
    return items;
  }).catch(error => {
    if (generation === owner) set({ sessionStatuses: {}, statusError: errorMessage(error) });
    return null;
  });
  statusFlight = { owner, promise };
  void promise.then(() => { if (statusFlight?.promise === promise) statusFlight = null; });
  return promise;
}

async function refreshProfileConfiguration(set: StoreSet): Promise<void> {
  set(state => state.profileRead.phase === 'error' ? { profileRead: reading } : state);
  const owner = executionReady;
  const profileResult = await getLlmProfiles();
  if (owner !== executionReady) return;
  const data = profileResult.data;
  if (!profileResult.ok || !Array.isArray(data?.profiles)) {
    const message = profileResult.message ?? 'llm_profiles_unavailable';
    set(state => ({
      profileRead: state.profileRead.phase === 'ready' ? ready : { phase: 'error', message },
      error: message, errorSource: 'profiles',
    }));
    return;
  }
  const profiles = data.profiles;
  const defaultProfileId = initialProfileId(
    profiles,
    data.defaultProfileId,
  );
  set((state) => {
    const summary = state.sessionId
      ? state.catalog.sessions.find((session) => session.id === state.sessionId)
      : undefined;
    return {
      profiles,
      profileRead: ready,
      connections: data.connections ?? [],
      defaultProfileId,
      selectedProfileId: state.selectedProfileId ?? summary?.profileId ?? defaultProfileId,
      ...(!state.selectedProfileId && !state.sessionId ? {
        reasoningEffortOverride: profiles.find(profile => profile.id === defaultProfileId)?.reasoningEffort ?? null,
      } : {}),
      ...(state.errorSource === 'profiles' ? { error: null, errorSource: null } : {}),
    };
  });
}

const store = create<LocalAgentState>((set, get) => ({
  welcomeIndex: Math.floor(Math.random() * 4),
  sessionId: null,
  draftProjectId: null,
  selectedProfileId: null,
  reasoningEffortOverride: null,
  modelSettingsBusy: false,
  draftSubagentSettings: null,
  subagentSettingsBusy: false,
  profiles: [],
  profileRead: reading,
  connections: [],
  defaultProfileId: null,
  catalog: EMPTY_CATALOG,
  catalogStatus: 'pending',
  catalogWatchError: null,
  sessionStatuses: {},
  statusError: null,
  pluginCatalog: EMPTY_PLUGIN_CATALOG,
  projection: null,
  contextWindowReading: null,
  rememberReadingAnchor: (id, anchor, sequence) => {
    const state = get();
    const session = state.catalog.sessions.find(entry => entry.id === id);
    if (!session || state.sessionId !== id) return;
    if (!anchor) { writePosition(id, null); return; }
    // Named navigation and reading positions refer directly to the complete timeline.
    const seq = sequence ?? state.projection?.timeline.find(row => row.timelineId === anchor.key
      || 'streamId' in row && row.streamId === anchor.key || row.kind === 'message' && row.messageId === anchor.key)?.sequence;
    if (seq !== undefined) writePosition(id, { ...anchor, sequence: seq, createdAt: session.createdAt });
  },
  childOutputs,
  retainedProjections: () => Array.from(projectionCache.values(), view => view.projection).filter(canRestoreProjection),
  observeHistory: (event, id) => {
    const previousSize = projectionCache.size;
    if (event === 'change' && id) {
      childOutputs.changed(id);
      projectionCache.delete(id);
      for (const [key, view] of projectionCache) {
        if (view.projection.agentChildren?.some(child => child.agentSessionId === id)
          || view.projection.agentContext?.ownerSessionId === id) projectionCache.delete(key);
      }
    } else {
      if (childOutputs.connected || event === 'closed') projectionCache.clear();
      observeConnection(event === 'ready');
    }
    if (projectionCache.size !== previousSize) set({});
  },
  loading: false, loadingPurpose: null,
  submitting: false, messageSubmission: null,
  catalogBusy: false,
  error: null,
  errorSource: null,

  runtimeReady: true,
  initialize: async (runtimeReady) => {
    if (initialization) return await initialization;
    if (runtimeReady) {
      observeConnection(false);
      projectionReadQueues.clear();
      projectionCache.clear();
      set({ profileRead: reading, runtimeReady: false, projection: null, contextWindowReading: null, sessionStatuses: {} });
      const gate: Promise<void> = runtimeReady.then(() => {
        if (executionReady === gate) set({ runtimeReady: true });
      }, error => {
        if (executionReady === gate) set({ runtimeReady: false, error: errorMessage(error), errorSource: 'initialization' });
        throw error;
      });
      executionReady = gate;
    }
    const currentGeneration = advanceView();
    initialization = (async () => {
      const readVersion = catalogVersion;
      set({ loading: true, loadingPurpose: 'initialization', catalogStatus: 'pending', error: null, errorSource: null });
      try {
        // The sidebar can select a Session while its first screen is being prepared.
        await Promise.all([
          getConversationCatalog().catch((error) => {
            if (readVersion === catalogVersion) set({ catalogStatus: 'error' });
            throw error;
          }).then(async (catalog) => {
            if (readVersion !== catalogVersion) catalog = get().catalog;
            else { catalogVersion += 1; set({ catalog, catalogStatus: 'ready' }); }
            if (currentGeneration === generation) {
              set({ loading: false, loadingPurpose: null });
              const restored = takeRestoredInterfaceView<{ sessionId: string | null; draftProjectId: string | null } | null>('conversation', null);
              const selectedSessionId = get().sessionId ?? restored?.sessionId;
              if (selectedSessionId && !get().projection && catalog.sessions.some(item => item.id === selectedSessionId)) await get().activateSession(selectedSessionId);
              else if (!get().sessionId && restored?.draftProjectId && catalog.projects.some(item => item.id === restored.draftProjectId)) set({ draftProjectId: restored.draftProjectId });
            }
          }),
          executionReady.then(() => getPluginCatalog()).then(pluginCatalog => set({ pluginCatalog })),
          // Both the model catalog and the conversation reader are available at Host publication.
          refreshProfileConfiguration(set),
        ]);
        const profileRead = get().profileRead;
        if (profileRead.phase === 'error') set({ error: profileRead.message, errorSource: 'profiles' });
        // A selected history entry owns its first projection read. Do not queue
        // another full read of a child-bearing session behind that activation.
        if (!get().sessionId || (currentGeneration === generation && get().projection)) void get().refresh();

      } catch (error) {
        if (currentGeneration === generation) {
          set({
            loading: false, loadingPurpose: null,
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

  refreshProfiles: async () => { await refreshProfileConfiguration(set); },

  watchCatalog: () => {
    const connect = () => {
      const controller = new AbortController();
      let dirty = false, reading = false;
      const refreshChangedCatalog = async () => {
        if (reading || controller.signal.aborted || get().catalogBusy) return;
        reading = true;
        try {
          while (dirty && !controller.signal.aborted && !get().catalogBusy) {
            dirty = false;
            const readVersion = catalogVersion;
            try {
              const catalog = await getConversationCatalog(controller.signal);
              if (controller.signal.aborted) break;
              if (readVersion !== catalogVersion || get().catalogBusy) { dirty = true; continue; }
              catalogVersion += 1;
              set((state) => ({ catalog, catalogStatus: 'ready',
                ...(state.errorSource === 'catalog' ? { error: null, errorSource: null } : {}) }));
            } catch (error) {
              if (!controller.signal.aborted) set({ catalogStatus: 'error', error: errorMessage(error), errorSource: 'catalog' });
            }
          }
        } finally { reading = false; }
      };
      const unsubscribe = store.subscribe((state, previous) => {
        if (previous.catalogBusy && !state.catalogBusy && dirty) void refreshChangedCatalog();
      });
      void watchConversationCatalog(controller.signal, () => {
        set({ catalogWatchError: null });
        dirty = true;
        void refreshChangedCatalog();
      }).catch(error => {
        if (!controller.signal.aborted) set({ catalogWatchError: errorMessage(error) });
      });
      return () => { controller.abort(); unsubscribe(); };
    };
    let dispose = connect();
    const retry = () => { dispose(); dispose = connect(); };
    retryCatalogObservation = retry;
    return () => {
      dispose();
      if (retryCatalogObservation === retry) retryCatalogObservation = null;
    };
  },

  retryCatalogWatch: () => { retryCatalogObservation?.(); },

  refreshCatalog: async () => {
    const readVersion = catalogVersion;
    try {
      const catalog = await getConversationCatalog();
      if (readVersion !== catalogVersion) return;
      catalogVersion += 1;
      set((state) => ({
        catalog,
        catalogStatus: 'ready',
        ...(state.errorSource === 'catalog' ? { error: null, errorSource: null } : {}),
      }));
    } catch (error) {
      set({ ...(readVersion === catalogVersion ? { catalogStatus: 'error' as const } : {}),
        error: errorMessage(error), errorSource: 'catalog' });
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
    const draftGeneration = advanceView();
    const defaults = useSettingsStore.getState();
    activeSubmissionCount = 0;
    set({
      messageSubmission: null,
      welcomeIndex: get().sessionId === null ? get().welcomeIndex : Math.floor(Math.random() * 4),
      sessionId: null,
      projection: null,
      contextWindowReading: null,
      draftProjectId: projectId,
      draftSubagentSettings: defaults.storePath && !defaults.errorMessage ? subagentDefaults(defaults.effectiveSettings) : null,
      subagentSettingsBusy: false,
      modelSettingsBusy: false,
      selectedProfileId: get().defaultProfileId,
      reasoningEffortOverride: get().profiles.find(profile => profile.id === get().defaultProfileId)?.reasoningEffort ?? null,
      loading: false, loadingPurpose: null,
      submitting: activeSubmissionCount > 0,
      error: null,
      errorSource: null,
    });
    if (!get().draftSubagentSettings && get().runtimeReady) void defaults.loadUserSettings().then(() => {
      const loaded = useSettingsStore.getState();
      if (generation === draftGeneration && !get().sessionId && !get().draftSubagentSettings && !loaded.errorMessage) {
        set({ draftSubagentSettings: subagentDefaults(loaded.effectiveSettings) });
      }
    });
  },

  activateSession: async (sessionId) => {
    if (openingFlight?.sessionId === sessionId && openingFlight.generation === generation) return openingFlight.promise;
    if (get().sessionId === sessionId) {
      if (get().profileRead.phase === 'error') void get().refreshProfiles();
      const current = get().projection;
      if (current?.sessionId === sessionId && !needsRevalidation.has(current)) return;
    }
    const owner = advanceView();
    const signal = viewReadController.signal;
    activeSubmissionCount = 0;
    let summary = get().catalog.sessions.find(s => s.id === sessionId);
    if (!summary) {
      set({ loading: true, loadingPurpose: 'session', error: null, errorSource: null });
      const version = catalogVersion;
      try {
        const catalog = await getConversationCatalog(signal);
        if (owner !== generation) return;
        if (catalogVersion === version) {
          catalogVersion += 1;
          set({ catalog, catalogStatus: 'ready' });
        }
      } catch (error) {
        if (owner !== generation) return;
        if (catalogVersion === version) {
          set({ loading: false, loadingPurpose: null, catalogStatus: 'error', error: errorMessage(error), errorSource: 'catalog' });
          return;
        }
      }
      summary = get().catalog.sessions.find(s => s.id === sessionId);
      if (!summary) {
        set({ loading: false, loadingPurpose: null, error: 'conversation_session_not_found', errorSource: 'catalog' });
        return;
      }
    }
    const retained = projectionCache.get(sessionId);
    const cached = retained && canRestoreProjection(retained.projection) ? retained : undefined;
    const status = get().sessionStatuses[sessionId];
    if (cached) {
      projectionCache.delete(sessionId);
      projectionCache.set(sessionId, cached);
    }
    set({
      sessionId, projection: null, contextWindowReading: null, ...cached,
      messageSubmission: null, draftProjectId: null, selectedProfileId: summary.profileId ?? get().defaultProfileId, reasoningEffortOverride: null,
      ...projectModelSettings(cached?.projection ?? null),
      submitting: false, modelSettingsBusy: false, subagentSettingsBusy: false, loading: !cached, loadingPurpose: cached ? null : 'session',
      error: null, errorSource: null,
    });
    const open = async () => {
      if (cached && !needsRevalidation.has(cached.projection)
        && (!status || status.revision <= cached.projection.revision && !isLiveRun(status.run))) return;
      if (!get().runtimeReady) await waitForExecution(signal);
      const view = await readSessionView(sessionId, signal);
      if (owner === generation && get().sessionId === sessionId) {
        set({ ...view, ...projectModelSettings(view.projection), loading: false, loadingPurpose: null });
      }
    };
    const flight = { sessionId, generation: owner, promise: open() };
    openingFlight = flight;
    try { await flight.promise; } catch (error) {
      if (owner === generation) set({ loading: false, loadingPurpose: null, error: errorMessage(error), errorSource: 'projection' });
    } finally { if (openingFlight === flight) openingFlight = null; }
  },

  setMode: async (mode) => {
    const sessionId = get().sessionId;
    if (!sessionId) throw new Error('session_not_found');
    return submitCommandAndReconcile(set, get, {
      schemaVersion: CONVERSATION_COMMAND_VERSION, type: 'session.mode.set',
      sessionId, commandId: nextId('command'), mode,
    });
  },
  selectModel: async (profileId, reasoningEffortOverride) => {
    const profile = get().profiles.find(profile => profile.id === profileId && profile.enabled);
    if (!profile || (profile.thinking !== 'disabled' && connectedModelReasoningEfforts(profile, get().connections).length > 0
      && !(reasoningEffortOverride ?? profile.reasoningEffort))) return false;
    return saveModelSettings(set, get, { profileId, reasoningEffortOverride });
  },
  setSubagentSettings: async patches => {
    const { sessionId, draftSubagentSettings, subagentSettingsBusy, submitting } = get();
    if (subagentSettingsBusy || submitting) throw new Error('subagent_settings_busy');
    const defaults = useSettingsStore.getState();
    const current = sessionId ? (await freshRun(sessionId))?.subagentSettings : draftSubagentSettings ?? subagentDefaults(defaults.effectiveSettings);
    if (!current) throw new Error('session_subagent_settings_unavailable');
    const settings = decodeAgentSettings({ ...current, ...patches });
    const owner = generation;
    set({ subagentSettingsBusy: true });
    try {
      if (sessionId) {
        await submitCommandAndReconcile(set, get, { schemaVersion: CONVERSATION_COMMAND_VERSION,
          type: 'session.subagent-settings.set', sessionId, commandId: nextId('command'), settings });
        await readNewConversationDefaults(set);
      } else {
        // Only explicit fields reach the global settings port. The draft itself keeps a complete copy.
        const activation = await defaults.patchUserSettingsBatch(Object.fromEntries(
          Object.entries(patches).map(([key, value]) => [`agent.subagents.${key}`, value])));
        if (!activation) throw new Error(useSettingsStore.getState().errorMessage ?? 'subagent_defaults_save_failed');
        if (generation === owner) set({ draftSubagentSettings: settings });
      }
      const readError = useSettingsStore.getState().errorMessage;
      if (readError) throw new Error(readError);
      if (generation === owner) set({ error: null, errorSource: null });
    } catch (error) {
      if (generation === owner) set({ error: errorMessage(error), errorSource: 'command' });
      throw error;
    } finally {
      if (generation === owner) set({ subagentSettingsBusy: false });
    }
  },

  refresh: async () => {
    if (!get().runtimeReady) return;
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
      const statuses = observeStatuses(set, refreshGeneration, signal);
      try {
        const items = await statuses;
        if (!sessionId || generation !== refreshGeneration || (get().loading && !get().projection)) return;
        const cachedView = projectionCache.get(sessionId);
        const cached = cachedView?.projection;
        const status = items?.find((item) => item.sessionId === sessionId);
        if (cached && !needsRevalidation.has(cached) && !cached.agentContext && !cached.agentChildren?.length && get().errorSource !== 'projection' && status?.revision === cached.revision && !cached.assistantDraft
          && !['running', 'waiting', 'releasing'].includes(status.run?.status ?? '')) {
          return;
        }
        const view = await readSessionView(sessionId, signal);
        if (generation !== refreshGeneration || get().sessionId !== sessionId) return;
        set((state) => {
          const apply = state.projection !== view.projection;
          if (!apply && state.errorSource !== 'projection') return state;
          return {
            ...(apply ? view : {}),
            ...projectModelSettings(apply ? view.projection : state.projection),
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
    pastedImages = [],
    planMode,
    retained = {},
  ) => {
    const trimmed = text.trim();
    const inputError = !trimmed && !pastedTexts.length && !pastedImages.length && !filesystemPaths.length && !retained.filesystemReferences?.length
      ? 'message_empty'
      : null;
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
      pastedImages,
      planMode,
      retained,
    );
  },

  focusContext: async (
    task,
    filesystemPaths = [],
    pluginSelections = [],
    pastedTexts = [],
    onSessionCreated,
    pastedImages = [],
    retained = {},
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
      pastedImages,
      undefined,
      retained,
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

  editMessage: async (messageId, text, expectedRevision, submissionId) => {
    const state = get();
    const sessionId = requiredSession(state);
    const target = state.projection?.messages.find((message) => message.messageId === messageId);
    if (!target || target.role !== 'user' || target.replyToInteraction) throw new Error('message_edit_target_invalid');
    return await submitExisting(set, get, {
      schemaVersion: CONVERSATION_COMMAND_VERSION, type: 'message.edit', commandId: nextId('command'),
      sessionId, messageId, text, expectedRevision,
    }, submissionId);
  },

  attachSessionDirectory: async (canonicalRoot) => {
    const sessionId = requiredSession(get());
    set({ catalogBusy: true, error: null, errorSource: null });
    try {
      const observedAt = observationAtRead();
      const projection = await attachConversationDirectoryIndex(sessionId, canonicalRoot);
      if (get().sessionId !== sessionId) throw new Error('conversation_session_changed');
      set(cacheProjection(projection, observedAt));
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
      const observedAt = observationAtRead();
      const projection = await detachConversationDirectoryIndex(sessionId, workspaceId);
      if (get().sessionId !== sessionId) throw new Error('conversation_session_changed');
      set(cacheProjection(projection, observedAt));
    } catch (error) {
      set({ error: errorMessage(error), errorSource: 'operation' });
      throw error;
    } finally {
      set({ catalogBusy: false });
    }
  },

  rebindHost: async (hostBinding) => {
    const { sessionId } = get();
    const run = sessionId ? (await freshRun(sessionId))?.run : null;
    if (!sessionId || run?.status !== 'waiting' || !run.hostBinding) throw new Error('host_rebind_not_waiting');
    return submitCommandAndReconcile(set, get, {
      schemaVersion: CONVERSATION_COMMAND_VERSION, type: 'run.host.rebind', commandId: `command:${crypto.randomUUID()}`,
      sessionId, runId: run.runId, expectedHostBinding: run.hostBinding, hostBinding,
    });
  },
  respondInteraction: async (response, interactionId, submissionId) => {
    const state = get();
    const sessionId = requiredSession(state);
    const current = await freshRun(sessionId);
    const interaction = current?.pendingInteraction;
    if (interactionId && interaction?.interactionId !== interactionId) throw new Error('interaction_response_missing');
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
      submissionId,
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

  respondApproval: async (decision, authorizationScope, target) => {
    const state = get();
    const sessionId = requiredSession(state);
    if (sessionId !== target.sessionId) throw new Error('approval_response_missing');
    const view = await freshRun(sessionId);
    const approval = selectPendingApproval(view, target);
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

  respondPlan: async (response, target, submissionId) => submitPlanResponse(set, get, response, target, submissionId),

  cancelTool: async (sessionId, runId, callId) => submitDecision(set, get, `cancel-tool:${sessionId}:${callId}`, () => ({
    schemaVersion: CONVERSATION_COMMAND_VERSION, type: 'tool.cancel', commandId: nextId('command'), sessionId, runId, callId,
  })),

  continueProvider: (sessionId, runId) => submitDecision(set, get, `continue-provider:${sessionId}:${runId}`, () => ({
    schemaVersion: CONVERSATION_COMMAND_VERSION, type: 'provider.continue', commandId: nextId('command'), sessionId, runId,
  })),

  cancelRun: async () => {
    const state = get();
    const sessionId = requiredSession(state);
    const runId = (await freshRun(sessionId))?.run?.runId;
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
    let failure: unknown;
    try { await mutateCatalog(set, async () => await updateProjectRequest(projectId, input)); }
    catch (error) { failure = error; }
    const sessionId = get().sessionId;
    if (input.workspacePaths !== undefined && sessionId
      && get().catalog.sessions.some(session => session.id === sessionId && session.projectId === projectId)) {
      try { await reconcileProjectionAfterReply(set, get, sessionId, 0, generation); }
      catch (error) {
        const message = `${failure ? `${errorMessage(failure)}; ` : ''}conversation_projection_reconcile_failed:${errorMessage(error)}`;
        set({ error: message, errorSource: 'operation' });
        throw new Error(message);
      }
    }
    if (failure) throw failure;
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
    writePosition(sessionId, null);
    projectionCache.delete(sessionId);
    uiEvents.clear(sessionId);
    if (get().sessionId === sessionId) get().startNewSession(projectId ?? null);
  },

  clearError: () => set({ error: null, errorSource: null }),
  clearInputError: submissionId => {
    const source = get().errorSource;
    if (submissionId && typeof source === 'object' && source?.kind === 'input' && source.submissionId === submissionId) {
      set({ error: null, errorSource: null });
    }
  },
}));

async function submitPlanResponse(
  set: StoreSet,
  get: () => LocalAgentState,
  response: PlanResponse,
  target: PlanTarget,
  submissionId?: string,
): Promise<CommandReply> {
  const { sessionId, runId, planId, revision } = target;
  const plan = (await freshRun(sessionId))?.pendingPlan;
  if (get().sessionId !== sessionId || !plan || plan.runId !== runId || plan.planId !== planId || plan.revision !== revision) {
    const message = t(normalizeUiLanguage(useSettingsStore.getState().effectiveSettings['workbench.language']), 'tui.childDecisionChanged');
    if (get().sessionId === sessionId) set({ error: message, errorSource: submissionId ? { kind: 'input', submissionId } : 'command' });
    throw new Error(message);
  }
  return await submitDecision(
    set,
    get,
    `plan:${sessionId}:${plan.runId}:${plan.planId}:${plan.revision}`,
    () => ({
      schemaVersion: CONVERSATION_COMMAND_VERSION,
      type: 'plan.respond',
      commandId: nextId('command'),
      sessionId,
      runId, planId, revision,
      response,
    }),
    submissionId,
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
  pastedImages: PastedImageInput[] = [],
  planMode?: 'manual',
  retained: RetainedMessageResources = {},
): Promise<CommandReply> {
  const submissionGeneration = beginSubmission(set);
  try {
    if (filesystemPaths.length + pastedTexts.length + pastedImages.length + (retained.filesystemReferences?.length ?? 0) > 8) throw new Error('message_filesystem_reference_limit');
    if (pluginSelections.length || retained.guidanceReferences?.length) {
      const notice = retiredDraftSkillNotice(get().pluginCatalog, pluginSelections, retained.guidanceReferences,
        normalizeUiLanguage(useSettingsStore.getState().effectiveSettings['workbench.language']));
      if (notice) throw new Error(notice);
    }
    const messageProfileId = get().selectedProfileId;
    const profile = get().profiles.find(item => item.id === messageProfileId);
    const reasoningEffortOverride = get().reasoningEffortOverride
      ?? (!get().sessionId && profile?.thinking !== 'disabled' ? profile?.reasoningEffort ?? null : null);
    const selected = get().sessionId;
    const controls = selected ? await freshRun(selected) : null;
    if (generation !== submissionGeneration || get().sessionId !== selected) throw new Error('conversation_session_changed');
    const activeRun = controls?.run;
    const queuedMessage = type === 'message.submit' && activeRun && ['running', 'waiting'].includes(activeRun.status);
    if (queuedMessage && planMode) throw new Error('plan_run_active');
    if (!queuedMessage && (!messageProfileId || !get().profiles.some((profile) => profile.id === messageProfileId && profile.enabled))) throw new Error('llm_profile_unavailable');
    const pluginCatalog = get().pluginCatalog;
    const effectivePluginSelections = requiredFilesystemPluginSelections(
      pluginCatalog,
      filesystemPaths,
      pluginSelections,
      supportsNativeFileInput('application/pdf', get().profiles.find(profile => profile.id === messageProfileId),
        queuedMessage ? activeRun : null),
    );
    for (const selection of effectivePluginSelections) {
      const plugin = pluginCatalog.plugins.find((item) => item.uri === selection.uri);
      if (!plugin?.enabled || !plugin.available) {
        throw new Error(plugin?.error ? `${plugin.error.code}: ${plugin.error.message}` : `plugin_selection_unavailable:${selection.uri}`);
      }
    }
    let { sessionId } = get();
    if (!sessionId) {
      const { draftProjectId, draftSubagentSettings } = get();
      // Materialize the visible draft, not a newer profile from another window before the first message.
      const observedAt = observationAtRead();
      const created = await createLocalAgentSession({
        profileId: messageProfileId!,
        ...(reasoningEffortOverride ? { recipe: { reasoningEffort: reasoningEffortOverride } } : {}),
        ...(draftProjectId ? { projectId: draftProjectId } : {}),
        ...(draftSubagentSettings ? { subagentSettings: draftSubagentSettings } : {}),
      });
      if (generation !== submissionGeneration) throw new Error('conversation_session_changed');
      sessionId = created.sessionId;
      onSessionCreated?.(sessionId);
      set({ sessionId, ...cacheProjection(created, observedAt, sessionId), draftProjectId: null, draftSubagentSettings: null });
      void get().refreshCatalog();
    }
    const filesystemReferences = [...(retained.filesystemReferences ?? []), ...(filesystemPaths.length
      ? await resolveConversationFilesystemReferences(sessionId, filesystemPaths)
      : [])];
    for (const paste of pastedTexts) {
      filesystemReferences.push(await uploadConversationPastedText(sessionId, paste.inputId, paste.text));
    }
    for (const image of pastedImages) {
      filesystemReferences.push(await uploadConversationPastedImage(sessionId, image));
    }
    if (generation !== submissionGeneration || get().sessionId !== sessionId) throw new Error('conversation_session_changed');
    const guidanceReferences = [...(retained.guidanceReferences ?? []), ...effectivePluginSelections.flatMap((selection) => {
      const reference = pluginCatalog.plugins.find((item)=>item.uri===selection.uri)?.reference;
      return reference ? [{referenceId:selection.selectionId,uri:selection.uri,label:selection.label,...reference}] : [];
    })];
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
            pluginSelections: executionSelections.map((selection) => ({ ...selection })),
          }
        : {}),
    };
    const command: ConversationCommand = type === 'message.submit'
      ? { ...common, type, text, ...(planMode ? { planMode } : {}), ...(queuedMessage ? { runId: activeRun.runId } : {}) }
      : { ...common, type, task: text };
    if (type === 'message.submit') globalThis.window?.__ACHBIT_DEBUG_UI__?.observe?.('conversation.composer', 'send.command',
      { sessionId, submissionId: retained.submissionId, commandId: command.commandId });
    return await submitCommandAndReconcile(set, get, command);
  } catch (error) {
    if (type === 'message.submit') globalThis.window?.__ACHBIT_DEBUG_UI__?.observe?.('conversation.composer', 'send.failed',
      { submissionId: retained.submissionId, reason: generation === submissionGeneration ? 'submission-failed' : 'session-changed' });
    if (errorMessage(error).includes('plugin_selection_stale')) {
      void get().refreshPluginCatalog();
    }
    if (generation === submissionGeneration) set({ error: errorMessage(error),
      errorSource: retained.submissionId ? { kind: 'input', submissionId: retained.submissionId } : 'command' });
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
  submissionId?: string,
): Promise<CommandReply> {
  const existing = decisionSubmissions.get(decisionKey);
  if (existing) return await existing;
  const submission = submitExisting(set, get, command(), submissionId);
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
  submissionId?: string,
): Promise<CommandReply> {
  const submissionGeneration = beginSubmission(set);
  try {
    return await submitCommandAndReconcile(set, get, command);
  } catch (error) {
    if (generation === submissionGeneration) set({ error: errorMessage(error),
      errorSource: submissionId ? { kind: 'input', submissionId } : 'command' });
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
  const id = command.sessionId;
  if (command.type === 'message.submit' && get().sessionId === id) set({ messageSubmission: {
    sessionId: id, commandId: command.commandId, text: command.text.trim().slice(0, 180), phase: 'sending',
  } });
  const clearReceipt = () => {
    const pending = get().messageSubmission;
    if (pending?.sessionId === id && pending.commandId === command.commandId) set({ messageSubmission: null });
  };
  try { return await sendAndReconcile(set, get, command, clearReceipt); }
  catch (error) { clearReceipt(); throw error; }
}

const acceptedInputs = new Map<string, Promise<void>>();
async function sendAndReconcile(set: StoreSet, get: StoreGet, command: ConversationCommand, clearReceipt: () => void): Promise<CommandReply> {
  const commandGeneration = generation;
  const fullOwner = get().projection?.sessionId === command.sessionId;
  const previousProjection = get().projection;
  const previousReminders = (command.type === 'message.submit' || command.type === 'context.focus')
    && previousProjection?.sessionId === command.sessionId
    ? previousProjection.queuedInputs?.filter(input => input.status === 'notApplied').map(input => input.commandId) ?? []
    : [];
  const reply = await submitLocalAgentCommand(command).catch(async error => {
    if (command.type === 'message.submit') globalThis.window?.__ACHBIT_DEBUG_UI__?.observe?.('conversation.composer', 'send.transport-failed',
      { sessionId: command.sessionId, commandId: command.commandId });
    // This Host error acknowledges a Session edit while reporting a failed save of future defaults.
    if ((command.type === 'session.subagent-settings.set' || command.type === 'session.model-settings.set')
      && error instanceof ConversationRequestError && error.code === 'conversation_defaults_save_failed') {
      try { await reconcileProjectionAfterReply(set, get, command.sessionId, 0, commandGeneration); }
      catch (readError) { throw new Error(`${errorMessage(error)};conversation_projection_reconcile_failed:${errorMessage(readError)}`); }
    }
    throw error;
  });
  if (command.type === 'message.submit') globalThis.window?.__ACHBIT_DEBUG_UI__?.observe?.('conversation.composer', 'send.receipt',
    { sessionId: reply.sessionId, commandId: reply.commandId, revision: reply.revision, phase: reply.status });
  const pending = get().messageSubmission;
  if (generation === commandGeneration && pending?.commandId === reply.commandId && pending.sessionId === reply.sessionId) {
    set({ messageSubmission: reply.status === 'rejected' ? null : { ...pending, phase: 'accepted', revision: reply.revision } });
  }
  if ((reply.status === 'accepted' || reply.status === 'replayed') && previousReminders.length
    && typeof sessionStorage !== 'undefined') {
    try {
      dismissUnappliedInputs(command.sessionId, previousReminders);
    } catch (error) {
      // The message is already accepted; a UI receipt failure must never turn it into a failed send.
      const zh = normalizeUiLanguage(useSettingsStore.getState().effectiveSettings['workbench.language']) === 'zh-CN';
      uiEvents.publish({ key: `unapplied-dismissal:${command.commandId}`, sessionId: command.sessionId, tone: 'warning',
        text: `${zh ? '消息已提交，但未能保存旧提醒的关闭状态' : 'Message submitted, but the previous reminders could not be dismissed'}: ${errorMessage(error)}` });
    }
  }
  const rejection = reply.status === 'rejected' ? commandRejectionMessage(reply) : null;
  const isSendReceipt = command.type === 'message.submit' && !rejection;
  const covered = () => {
    const s = get();
    const current = s.projection;
    return isSendReceipt && generation === commandGeneration && s.sessionId === command.sessionId
      && !s.statusError && s.errorSource !== 'projection' && current?.sessionId === reply.sessionId
      && current.revision >= reply.revision && current !== previousProjection;
  };
  const reconcile = async () => {
    if (isSendReceipt && (generation !== commandGeneration || get().sessionId !== command.sessionId)) {
      projectionCache.delete(command.sessionId);
      globalThis.window?.__ACHBIT_DEBUG_UI__?.observe?.('conversation.composer', 'send.projection', {
        sessionId: reply.sessionId, commandId: reply.commandId, replyRevision: reply.revision, phase: 'inactive' });
      return;
    }
    const refresh = projectionRefreshFlight;
    if (isSendReceipt && refresh?.generation === commandGeneration && refresh.sessionId === command.sessionId && !covered()) await refresh.promise;
    if (!covered()) await reconcileProjectionAfterReply(set, get, command.sessionId, reply.revision, commandGeneration, fullOwner);
    const diagnostics = globalThis.window?.__ACHBIT_DEBUG_UI__;
    if (isSendReceipt && diagnostics?.observe) {
      const state = get();
      const current = generation === commandGeneration && state.sessionId === command.sessionId;
      const projection = state.projection;
      const adopted = current && projection?.sessionId === reply.sessionId && projection.revision >= reply.revision;
      diagnostics.observe('conversation.composer', 'send.projection', {
        sessionId: reply.sessionId, commandId: reply.commandId, replyRevision: reply.revision,
        revision: current ? projection?.revision : undefined, phase: adopted ? 'adopted' : current ? 'uncovered' : 'inactive',
      });
    }
  };
  if (isSendReceipt) {
    const publication = reconcile().catch(error => {
      globalThis.window?.__ACHBIT_DEBUG_UI__?.observe?.('conversation.composer', 'send.projection', {
        sessionId: reply.sessionId, commandId: reply.commandId, replyRevision: reply.revision, phase: 'failed' });
      if (generation === commandGeneration) set({ error: `conversation_projection_reconcile_failed:${errorMessage(error)}`, errorSource: 'projection' });
    }).finally(() => {
      if (acceptedInputs.get(command.sessionId) === publication) acceptedInputs.delete(command.sessionId);
      clearReceipt();
    });
    acceptedInputs.set(command.sessionId, publication);
    return reply;
  }
  try { await reconcile(); }
  catch (error) {
    const message = `conversation_projection_reconcile_failed:${errorMessage(error)}`;
    throw new Error(rejection ? `${rejection};${message}` : message);
  }
  clearReceipt();
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
  completeSnapshot = false,
): Promise<void> {
  if (get().sessionId !== sessionId || generation !== commandGeneration) {
    if (completeSnapshot) await readSessionView(sessionId);
    return;
  }
  const view = await readSessionView(sessionId, viewReadController.signal);
  if (view.projection.revision < replyRevision) {
    throw new Error(
      `conversation_projection_behind_command_reply:${view.projection.revision}:${replyRevision}`,
    );
  }
  if (get().sessionId !== sessionId || generation !== commandGeneration) return;
  set((state) => {
    return shouldApplyProjection(state.projection, view.projection)
      ? { ...view, ...projectModelSettings(view.projection) } : projectModelSettings(state.projection);
  });
}

function projectModelSettings(projection: Pick<SessionProjection, 'modelSettings'> | null): Partial<LocalAgentState> {
  return projection?.modelSettings ? {
    selectedProfileId: projection.modelSettings.profileId,
    reasoningEffortOverride: projection.modelSettings.reasoningEffortOverride,
  } : {};
}

// An explicit edit on an existing Session publishes the whole tuple through the Host command.
// Read both preference owners; never write a second time or change the currently displayed Session.
async function readNewConversationDefaults(set: StoreSet): Promise<void> {
  const [models] = await Promise.all([getLlmProfiles(), useSettingsStore.getState().loadUserSettings()]);
  if (!models.ok || !models.data) throw new Error(models.message ?? models.error ?? 'llm_profiles_unavailable');
  set({ profiles: models.data.profiles, defaultProfileId: models.data.defaultProfileId ?? null });
  const error = useSettingsStore.getState().errorMessage;
  if (error) throw new Error(error);
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
      await readNewConversationDefaults(set);
      return generation === settingsGeneration;
    }
    const profile = get().profiles.find(item => item.id === settings.profileId);
    if (!profile) throw new Error('llm_profile_unavailable');
    const remembered = { ...profile, reasoningEffort: profile.thinking === 'disabled'
      ? undefined : settings.reasoningEffortOverride ?? profile.reasoningEffort };
    const saved = await patchLlmProfiles({ profile: remembered, defaultProfileId: profile.id });
    if (!saved.ok || !saved.data) throw new Error(saved.message ?? saved.error ?? 'reasoning_preference_save_failed');
    set({ profiles: saved.data.profiles, defaultProfileId: saved.data.defaultProfileId ?? null });
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
    catalogVersion += 1;
    set({ catalog: activeCatalog, catalogStatus: 'ready' });
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

function isLiveRun(run: ConversationSessionStatus['run'] | undefined) {
  return run?.status === 'running' || run?.status === 'waiting' || run?.status === 'releasing';
}
function canRestoreProjection(projection: SessionProjection) {
  return !projection.assistantDraft && !isLiveRun(projection.run);
}
function shouldApplyProjection(
  current: SessionProjection | null,
  incoming: SessionProjection,
): boolean {
  if (current === incoming) return false;
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
  nativePdfInput: boolean,
): PluginSelectionInput[] {
  const selections = explicitSelections.map((selection) => ({ ...selection }));
  const selectedUris = new Set(selections.map((selection) => selection.uri));
  const requiredMediaTypes = new Set(filesystemPaths.flatMap((reference) => (
    !nativePdfInput && reference.kind === 'file' && reference.path.toLocaleLowerCase().endsWith('.pdf')
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

// Historical recovery is separate from navigation/command completion: do not hold the
// timeline, a new live reading, or another conversation behind this read-only lookup.
let historyLookup: { key: string; controller: AbortController } | null = null;
store.subscribe((state, previous) => {
  if (state.catalog !== previous.catalog) {
    // A catalog title change is not a new Session; deletion/recreation is. Its former
    // monotone sidebar revision cannot impose a minimum on a new incarnation either.
    const now = new Map(state.catalog.sessions.map(s => [s.id, s.createdAt]));
    let remaining: LocalAgentState['sessionStatuses'] | undefined;
    for (const before of previous.catalog.sessions) {
      const id = before.id;
      if (now.has(id) && now.get(id) === before.createdAt) continue;
      writePosition(id, null);
      if (openingFlight?.sessionId === id && openingFlight.generation === generation) viewReadController.abort(new Error('conversation_session_not_found'));
      projectionReadQueues.delete(id);
      projectionCache.delete(id);
      if (state.sessionStatuses[id]) {
        remaining ??= { ...state.sessionStatuses }; delete remaining[id];
      }
    }
    if (remaining) store.setState({ sessionStatuses: remaining });
  }
  if (state.projection === previous.projection && state.sessionId === previous.sessionId) return;
  // Only a decoded snapshot admitted to this view's cache can authorize a journal lookup.
  const admitted = state.sessionId ? projectionCache.get(state.sessionId) : undefined;
  const p = admitted && admitted.projection === state.projection ? admitted.projection : null;
  const rounds = p?.run && !p.contextUsage && !archivedMeasurements.has(p) ? reportedWindowRounds(p) : [];
  const newest = rounds[0];
  // Only new usage can yield a new reading. Draft deltas, tool progress, and starting
  // a successor with zero reports must neither cancel the lookup nor trigger another scan.
  const key = p && newest ? JSON.stringify([p.sessionId, p.contextHandoff?.historyThroughSequence ?? 0,
    newest.runId, newest.reportedCallCount]) : null;
  if (key && key === historyLookup?.key) return;
  historyLookup?.controller.abort();
  historyLookup = null;
  if (!key || !p) {
    if (state.errorSource === 'contextHistory') store.setState({ error: null, errorSource: null });
    return;
  }
  const controller = new AbortController();
  historyLookup = { key, controller };
  const after = state.contextWindowReading?.receipt?.sequence ?? 0;
  void readMeasuredWindowHistory(p, rounds, after, controller.signal).then(reading => {
    if (controller.signal.aborted) return;
    const current = store.getState();
    if (current.errorSource === 'contextHistory') store.setState({ error: null, errorSource: null });
    if (!reading || current.sessionId !== p.sessionId || current.projection?.contextUsage) return;
    const cached = projectionCache.get(p.sessionId);
    if (!cached || cached.projection !== current.projection) { historyLookup = null; return; }
    if (!reportedWindowRounds(cached.projection).some(round => round.runId === reading.usage.runId)
      || (cached.contextWindowReading?.receipt?.sequence ?? 0) >= reading.receipt.sequence) return;
    cached.contextWindowReading = reading;
    store.setState({ contextWindowReading: reading });
  }).catch(error => {
    if (!controller.signal.aborted) store.setState({ error: errorMessage(error), errorSource: 'contextHistory' });
  });
});
return store;
}

export const useLocalAgentStore = createLocalAgentStore();
