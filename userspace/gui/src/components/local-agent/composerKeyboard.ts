export interface ComposerKeyEvent {
  key: string;
  shiftKey: boolean;
  repeat: boolean;
  isComposing: boolean;
  keyCode: number;
}

export interface ComposerCompositionState {
  active: boolean;
  commitPending: boolean;
}

export function shouldSubmitComposerKey(
  event: ComposerKeyEvent,
  composition: ComposerCompositionState,
): boolean {
  return event.key === 'Enter'
    && !event.shiftKey
    && !event.repeat
    && !composition.active
    && !composition.commitPending
    && !event.isComposing
    && event.keyCode !== 229;
}
