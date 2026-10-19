/** An editor draft is presentation state; only the settings owner supplies saved values. */
export interface SettingDraft { saved: string; text: string }

export function reconcileSettingDraft(draft: SettingDraft, saved: string): SettingDraft {
  if (draft.saved === saved) return draft;
  return { saved, text: draft.text === draft.saved ? saved : draft.text };
}

/** Refresh untouched form fields without submitting or discarding independent text edits. */
export function reconcileSettingFields<T extends object>(draft: T, previous: T, saved: T): T {
  const result = { ...draft };
  for (const key of new Set([...Object.keys(previous), ...Object.keys(saved)]) as Set<keyof T>) {
    if (!Object.is(draft[key], previous[key])) continue;
    if (Object.hasOwn(saved, key)) result[key] = saved[key];
    else delete result[key];
  }
  return result;
}

export function reconcileJsonSettingDraft(draft: SettingDraft, saved: string, confirmedKeys: readonly string[] = []): SettingDraft {
  if (draft.text === draft.saved) return { saved, text: saved };
  const canonical = JSON.parse(saved) as Record<string, unknown>;
  const values = reconcileSettingFields(JSON.parse(draft.text) as Record<string, unknown>, JSON.parse(draft.saved), canonical);
  for (const key of confirmedKeys) {
    if (Object.hasOwn(canonical, key)) values[key] = canonical[key];
    else delete values[key];
  }
  return { saved, text: JSON.stringify(values) };
}

export function parseSettingDraft(text: string, numeric: boolean): string | number | null {
  if (!numeric) return text;
  if (!text.trim()) return null;
  const value = Number(text);
  return Number.isFinite(value) ? value : null;
}
