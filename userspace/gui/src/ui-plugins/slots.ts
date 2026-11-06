/** Existing replaceable regions. The type and built-in registration list derive from this catalog.
 * New public slots still require an explicit plugin-contract decision; primitives use ui-components.
 */
export const UI_REGION_SLOTS = Object.freeze({
  'workbench.layout': 'Workbench composition',
  navigation: 'Projects and conversations',
  'conversation.header': 'Conversation heading and Reader controls',
  'activity.row': 'Activity disclosure',
  'activity.summary': 'Activity summary',
  'activity.detail': 'Activity details',
  'composer.layout': 'Composer layout',
  'composer.model': 'Model selection',
  'composer.attachments': 'Composer attachments',
  'composer.actions': 'Composer actions',
  'task.panel': 'Task progress',
  'artifact.panel': 'Delivered resources',
  'reader.layout': 'Reader layout',
  'reader.toolbar': 'Reader toolbar',
  'reader.tree': 'Resource tree',
  'settings.navigation': 'Settings navigation',
} as const);
export type UiRegionSlot = keyof typeof UI_REGION_SLOTS;
export const regionSlots: readonly UiRegionSlot[] = Object.freeze(Object.keys(UI_REGION_SLOTS) as UiRegionSlot[]);
