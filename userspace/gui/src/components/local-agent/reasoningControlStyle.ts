export const REASONING_CONTROL_SETTING = 'gui.reasoningEffortControl';
export type ReasoningControlStyle = 'segments' | 'slider';

export function reasoningControlStyle(value: unknown): ReasoningControlStyle {
  if (value === undefined || value === null) return 'segments';
  if (value === 'segments' || value === 'slider') return value;
  throw new Error(`invalid_reasoning_effort_control:${String(value)}`);
}
