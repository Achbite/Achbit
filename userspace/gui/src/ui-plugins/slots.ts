import slots from '../../../../config/ui/plugin-slots.json';

/** The Host validates the same ordered public IDs when installing display plugins. */
export type UiPluginSlot = keyof typeof slots;
type SlotsWith<Role extends string> = {
  [Id in UiPluginSlot]: Role extends keyof (typeof slots)[Id] ? Id : never
}[UiPluginSlot];
export type UiRegionSlot = SlotsWith<'region'>;
export type UiSettingsContributionSlot = SlotsWith<'settingsContribution'>;

const slotIds = Object.keys(slots) as UiPluginSlot[];
export const regionSlots: readonly UiRegionSlot[] = Object.freeze(
  slotIds.filter((id): id is UiRegionSlot => 'region' in slots[id]),
);
export const UI_REGION_SLOTS = Object.freeze(Object.fromEntries(
  regionSlots.map(id => [id, slots[id].region]),
)) as Readonly<Record<UiRegionSlot, string>>;

export function isSettingsContributionSlot(id: UiPluginSlot): id is UiSettingsContributionSlot {
  return Object.hasOwn(slots, id) && 'settingsContribution' in slots[id];
}
