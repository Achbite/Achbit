import { Text } from '@codemirror/state';
import { readChangedRanges } from './fileChangeSummary';
import { EditorView } from '@codemirror/view';
import { Change, diff, getChunks, unifiedMergeView } from '@codemirror/merge';
import type { Language } from '@codemirror/language';
import { UI_PALETTE } from '../../theme/palette';
import { codeViewerExtensions } from './codeViewer';

export async function createCodeDiffView(parent: HTMLElement, before: string, after: string, language: Language | null, dark: boolean, signal: AbortSignal): Promise<EditorView> {
  // Use the same newline representations as unifiedMergeView's original and EditorState's current doc.
  const original = Text.of(before.split(/\r?\n/));
  const current = Text.of(after.split(/\r\n?|\n/));
  const ranges = before && after && before !== after && Math.max(before.length, after.length) >= 64 * 1024
    ? await readChangedRanges(original.toString(), current.toString(), signal) : null;
  signal.throwIfAborted();
  // CodeMirror's default character scan can merge distant edits into one enormous deletion widget.
  // Refine matching line boundaries with its same bounded per-character diff and unified renderer.
  const diffConfig = ranges ? { override: (a: string, b: string) => ranges.flatMap(({ fromA, toA, fromB, toB }) =>
    diff(a.slice(fromA, toA), b.slice(fromB, toB), { scanLimit: 500 }).map(change =>
      new Change(fromA + change.fromA, fromA + change.toA, fromB + change.fromB, fromB + change.toB))) } : undefined;
  const colors = UI_PALETTE.diff[dark ? 'dark' : 'light'];
  const view = new EditorView({
    parent,
    doc: current,
    extensions: [
      codeViewerExtensions(language, dark),
      EditorView.lineWrapping,
      unifiedMergeView({ original, diffConfig, mergeControls: false, collapseUnchanged: { margin: 2, minSize: 3 } }),
      EditorView.theme({
        '.cm-insertedLine, .cm-changedLine': { backgroundColor: colors['diffEditor.insertedLineBackground'] },
        '.cm-deletedChunk': { backgroundColor: colors['diffEditor.removedLineBackground'] },
        '.cm-insertedText': { backgroundColor: colors['diffEditor.insertedTextBackground'] },
        '.cm-deletedText': { backgroundColor: colors['diffEditor.removedTextBackground'] },
        '.cm-collapsedLines': { backgroundColor: colors['diffEditor.unchangedRegionBackground'], color: colors['diffEditor.unchangedRegionForeground'] },
      }),
    ],
  });
  const firstChange = getChunks(view.state)?.chunks[0];
  if (firstChange) view.dispatch({ effects: EditorView.scrollIntoView(firstChange.fromB, { y: 'center' }) });
  return view;
}
