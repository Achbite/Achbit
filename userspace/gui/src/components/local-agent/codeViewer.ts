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
      '&': { height: '100%', color: 'var(--dc-foreground)', backgroundColor: 'var(--dc-code-background)' },
      '.cm-scroller': { overflow: 'auto', fontFamily: 'var(--dc-font-code, ui-monospace, monospace)', fontSize: 'var(--dc-font-code-size, 12px)', lineHeight: 'var(--dc-line-code, 1.6)' },
      '.cm-content': { padding: '8px 0', caretColor: 'var(--dc-foreground)' },
      '.cm-gutters': { backgroundColor: 'var(--dc-code-background)', color: 'var(--dc-muted)', border: 'none' },
      '.cm-selectionBackground, &.cm-focused .cm-selectionBackground': { backgroundColor: 'var(--dc-surface-active)' },
      '.cm-panels': { color: 'var(--dc-foreground)', backgroundColor: 'var(--dc-surface)' },
      '.cm-searchMatch': { backgroundColor: 'var(--dc-surface-active)', outline: '1px solid var(--dc-border-strong)' },
      '.cm-searchMatch-selected': { outline: '2px solid var(--dc-focus-ring, var(--dc-border-strong))' },
    }, { dark }),
  ];
}
