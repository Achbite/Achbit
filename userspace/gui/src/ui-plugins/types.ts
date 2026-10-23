import type { ConversationProject, ConversationSessionSummary, SessionProjection, AssistantDraftBlockProjection, LlmProviderProfile, LlmReasoningEffort, ModelConnection, ActivityProjection, ConnectionSummary, ProviderAdapterDescriptor, UsageQuery, UsageReport, AuthFlow, QuotaSnapshot } from '@achbit/protocol';

import type { UsageWidgetLabels } from './usageWidgetLabels';
import type { UsageCostDisplay } from './usageCost';

export interface UsageReadPort {
  query(query: UsageQuery, signal: AbortSignal): Promise<UsageReport>;
}
export interface ConnectionSettingsPort {
  startLogin(method: 'browser' | 'deviceCode'): Promise<AuthFlow>;
  readLogin(flowId: string, signal: AbortSignal): Promise<AuthFlow>;
  cancelLogin(flowId: string): Promise<AuthFlow>;
  logout(): Promise<void>;
  readQuota(signal: AbortSignal): Promise<QuotaSnapshot>;
}
export type UiRegionSlot = 'workbench.layout' | 'navigation' | 'conversation.header'
  | 'activity.row' | 'activity.summary' | 'activity.detail' | 'composer.layout'
  | 'composer.model' | 'composer.attachments' | 'composer.actions' | 'task.panel'
  | 'artifact.panel' | 'reader.layout' | 'reader.toolbar' | 'reader.tree' | 'settings.navigation';
/** Read-only values from the existing Session projection or Host view state. */
export type UiRegionData =
  | { kind: 'activities'; activities: readonly ActivityProjection[]; expanded: boolean }
  | { kind: 'providerHosted'; blocks: readonly Extract<AssistantDraftBlockProjection, { kind: 'providerHosted' }>[]; expanded: boolean }
  | { kind: 'tasks'; todoList: SessionProjection['todoList']; run: SessionProjection['tokenUsageHistory'][number] | null }
  | { kind: 'artifacts'; artifacts: SessionProjection['artifacts']; expanded: boolean }
  | { kind: 'composer'; draft: string; canSend: boolean; canStop: boolean; attachments: readonly { path: string; kind: 'file' | 'directory' }[] }
  | { kind: 'reader'; tabs: readonly { id: string; title: string }[]; activeId: string | null; visible: boolean; expanded: boolean; treeVisible: boolean }
  | { kind: 'conversationHeader'; sessionId: string | null; title: string; project: { id: string; title: string } | null;
      reader: { visible: boolean; expanded: boolean; treeVisible: boolean; canOpen: boolean } }
  | { kind: 'settingsNavigation'; pages: readonly { id: string; label: string; icon: string }[]; activePage: string; searchQuery: string }
  | { kind: 'resourceTree'; visible: boolean; filter: string; showRuntime: boolean; watchError: string; selectedId: string | null;
      items: readonly { id: string; parentId?: string; name: string; kind: 'directory' | 'file' | 'unavailable'; depth: number; expanded: boolean; selected: boolean; error?: string }[] }
  | { kind: 'navigation'; projects: readonly ConversationProject[]; sessions: readonly ConversationSessionSummary[]; activeSessionId: string | null; busy: boolean };
export interface UiViewActions {
  selectModel?(profileId: string, effort: import('@achbit/protocol').LlmReasoningEffort | null): Promise<void>;
  pickAttachments?(): void;
  addAttachments?(files: Array<{ path: string; kind: 'file' | 'directory' }>): Promise<void>;
  updateDraft?(text: string): void;
  submitDraft?(): Promise<void>;
  stopRun?(): Promise<void>;
  activateSession?(sessionId: string): Promise<void>;
  selectReaderTab?(tabId: string): void;
  toggleReader?(): void;
  toggleReaderExpanded?(): void;
  setExpanded?(expanded: boolean): void;
  toggleTree?(): void;
  selectSettingsPage?(pageId: string): void;
  setSettingsSearch?(query: string): void;
  setTreeFilter?(filter: string): void;
  setTreeRuntimeVisible?(visible: boolean): void;
  setTreeItemExpanded?(itemId: string, expanded: boolean): void;
  openTreeItem?(itemId: string): void;
  openTreeItemMenu?(itemId: string): void;
  setUsageVisibility?(value: 'summary' | 'collapsed' | 'hidden'): void;
  openUsageSettings?(): void;
}
/** Views have typed inputs and scoped effects; they never receive execution or Session mutation ports. */
export type UiPluginSlot =
  | UiRegionSlot
  | 'usage.widget'
  | 'message.plain'
  | 'message.markdown'
  | 'document.html'
  | 'document.markdown'
  | 'document.pdf'
  | 'theme'
  | 'settings.models.overview'
  | 'settings.connection.detail'
  | 'settings.usage.panel'
  | 'tool.result';
export interface UiPluginManifest {
  id: string;
  name: string;
  entry: string;
  description?: string;
  slots: UiPluginSlot[];
  adapterId?: string;
  toolId?: string;
  capabilities?: Array<'usage.read' | 'quota.read' | 'connection.auth'>;
}
export interface UiPluginSource {
  path: string;
  enabled: boolean;
}
export interface UiPluginFile extends UiPluginSource {
  manifest: UiPluginManifest | null;
  source: string | null;
  error: string | null;
}
export type UiPluginInput = Readonly<
  | { kind: 'region'; slot: UiRegionSlot; regionNames: readonly string[]; data?: Readonly<UiRegionData>; locale: string; theme: string }
  | { kind: 'usage.widget'; labels: UsageWidgetLabels; costDisplay: UsageCostDisplay; connection: ModelConnection | null; modelId: string | null; visibility: 'summary' | 'collapsed' | 'hidden'; expanded: boolean; revision: number; locale: string; theme: string }
  | { kind: 'composer.model'; profiles: readonly LlmProviderProfile[]; connections: readonly ModelConnection[]; selectedProfileId: string | null; reasoningEffort: LlmReasoningEffort | null; confirmed: boolean; busy: boolean; locale: string; theme: string }
  | { kind: 'settings.models'; connections: readonly ConnectionSummary[]; adapters: readonly ProviderAdapterDescriptor[]; locale: string; theme: string }
  | { kind: 'settings.connection'; connection: ConnectionSummary; locale: string; theme: string }
  | { kind: 'settings.usage'; query: UsageQuery; report: UsageReport; locale: string; theme: string }
  | { kind: 'tool.result'; activity: Readonly<ActivityProjection>; toolId: string; locale: string; theme: string }
  | {
      kind: 'message';
      text: string;
      format: 'plain' | 'markdown';
      locale: string;
      theme: string;
    }
  | {
      kind: 'document';
      blob: Blob;
      filename: string;
      format: 'html' | 'markdown' | 'pdf';
      locale: string;
      theme: string;
    }
>;
export interface UiPluginScope {
  readonly signal: AbortSignal;
  readonly usage?: UsageReadPort;
  readonly quota?: { read(signal: AbortSignal): Promise<QuotaSnapshot> };
  readonly regions?: { mount(name: string, container: HTMLElement): void };
  readonly actions?: UiViewActions;
  readonly connection?: ConnectionSettingsPort;
  onDispose(dispose: () => void | Promise<void>): void;
  addStyle(css: string): void;
  reportError(error: unknown): void;
}
export interface UiPluginView {
  update(input: UiPluginInput): void;
  dispose(): void | Promise<void>;
}
export type UiPluginRenderer = (
  container: HTMLElement,
  input: UiPluginInput,
  scope: UiPluginScope,
) => UiPluginView;
export interface UiPluginContext extends UiPluginScope {
  readonly slots: readonly UiPluginSlot[];
  register(slot: Exclude<UiPluginSlot, 'theme'>, renderer: UiPluginRenderer): void;
}
export interface UiPluginModule {
  apply(
    context: UiPluginContext,
  ): void | (() => void | Promise<void>) | Promise<void | (() => void | Promise<void>)>;
}
