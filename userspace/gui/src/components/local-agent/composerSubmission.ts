import type { PluginSelectionInput } from '@deepcode/protocol';
import type { BrowserAnnotationDraft } from './browserReview';
import type { PastedImageInput } from '../../services/pastedImage';
import type { PastedTextInput } from '../../services/pastedText';

export interface ComposerState {
  draft: string;
  pastedTexts: Array<PastedTextInput & { expanded: boolean; browserReview?: BrowserAnnotationDraft }>;
  pastedImages: PastedImageInput[];
  filesystemPaths: Array<{ path: string; kind: 'file' | 'directory' }>;
  pluginSelections: PluginSelectionInput[];
  selectionStart: number;
  selectionEnd: number;
  focused: boolean;
}

export function emptyComposerState(): ComposerState {
  return { draft: '', pastedTexts: [], pastedImages: [], filesystemPaths: [], pluginSelections: [], selectionStart: 0, selectionEnd: 0, focused: false };
}

export function composerStateIsEmpty(state: ComposerState): boolean {
  return !state.draft && !state.pastedTexts.length && !state.pastedImages.length && !state.filesystemPaths.length && !state.pluginSelections.length;
}

export function cloneComposerState(state: ComposerState): ComposerState {
  return { ...state, pastedImages: (state.pastedImages ?? []).map((item) => ({ ...item })), pastedTexts: state.pastedTexts.map((item) => ({ ...item })),
    filesystemPaths: state.filesystemPaths.map((item) => ({ ...item })),
    pluginSelections: state.pluginSelections.map((item) => ({ ...item })) };
}

/** A reply owns the submitted draft, never edits made while that reply was pending. */
export async function submitComposerState(
  key: string,
  submitted: ComposerState,
  actions: {
    read(key: string): ComposerState;
    write(key: string, state: ComposerState): void;
    retainFailed(key: string, state: ComposerState): void;
    send(): Promise<unknown>;
  },
): Promise<boolean> {
  const original = cloneComposerState(submitted);
  actions.write(key, { ...emptyComposerState(), focused: original.focused });
  try {
    await actions.send();
    return true;
  } catch {
    if (composerStateIsEmpty(actions.read(key))) actions.write(key, original);
    else actions.retainFailed(key, original);
    return false;
  }
}
