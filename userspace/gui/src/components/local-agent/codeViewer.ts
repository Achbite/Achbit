import { EditorState, type Extension } from '@codemirror/state';
import { EditorView, drawSelection, keymap, lineNumbers } from '@codemirror/view';
import { syntaxHighlighting, type Language } from '@codemirror/language';
import { search, searchKeymap } from '@codemirror/search';
import { classHighlighter } from '@lezer/highlight';
import './codeViewer.css';

export function codeViewerExtensions(language: Language | null, dark: boolean, firstLine = 1): Extension[] {
  return [
    EditorState.readOnly.of(true),
    EditorView.editable.of(false),
    EditorView.contentAttributes.of({ tabindex: '0' }),
    lineNumbers({ formatNumber: (line) => String(firstLine + line - 1) }),
    drawSelection(),
    search({ top: true }),
    keymap.of([
      { key: 'Mod-a', run: (view) => {
        view.dispatch({ selection: { anchor: 0, head: view.state.doc.length }, userEvent: 'select' });
        return true;
      } },
      ...searchKeymap,
    ]),
    syntaxHighlighting(classHighlighter),
    language ?? [],
    EditorView.theme({
      '&': { height: '100%', color: 'var(--ac-foreground)', backgroundColor: 'var(--ac-code-background)' },
      '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--ac-font-code, ui-monospace, monospace)', fontSize: 'var(--ac-font-code-size, 12px)', lineHeight: 'var(--ac-line-code, 1.6)' },
      '.cm-content': { padding: '8px 0', caretColor: 'var(--ac-foreground)' },
      '.cm-gutters': { backgroundColor: 'var(--ac-code-background)', color: 'var(--ac-muted)', border: 'none' },
      '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--ac-surface-active)' },
      '.cm-panels': { color: 'var(--ac-foreground)', backgroundColor: 'var(--ac-surface)' },
      '.cm-searchMatch': { backgroundColor: 'var(--ac-surface-active)', outline: '1px solid var(--ac-border-strong)' },
      '.cm-searchMatch-selected': { outline: '2px solid var(--ac-focus-ring, var(--ac-border-strong))' },
    }, { dark }),
  ];
}
