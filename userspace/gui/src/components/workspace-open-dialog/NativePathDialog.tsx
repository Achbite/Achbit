import { ModalDialog } from '../../ui-components';
import { useEffect, useRef, useState } from 'react';
import { t, type UiLanguage } from '../../i18n';
import { pickNativePaths, type NativePathOptions, type NativePathSelection } from '../../services/runtimeAdapter';
import './workspaceOpenDialog.css';

interface NativePathDialogProps extends NativePathOptions {
  language: UiLanguage;
  onSelect: (path: string, kind: 'file' | 'directory') => void;
  onSelectMany?: (paths: NativePathSelection[]) => void;
  onCancel: () => void;
}

/** One OS dialog per mounted selection, including React Strict Mode effects. */
export default function NativePathDialog(props: NativePathDialogProps) {
  const request = useRef<Promise<NativePathSelection[] | null> | null>(null);
  const callbacks = useRef(props);
  callbacks.current = props;
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    request.current ??= pickNativePaths(props);
    void request.current.then((selection) => {
      if (!active) return;
      if (selection === null) callbacks.current.onCancel();
      else if (callbacks.current.onSelectMany) callbacks.current.onSelectMany(selection);
      else if (selection.length === 1) callbacks.current.onSelect(selection[0].path, selection[0].kind);
      else throw new Error('native_path_selection_count_invalid');
    }).catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => { active = false; };
    // Selection options belong to this mounted dialog; callbacks may change as messages arrive.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  if (!error) return null;
  return <ModalDialog className="ws-open-dialog__backdrop" onClose={props.onCancel} aria-label={props.title}>
    <div className="ws-open-dialog ws-open-dialog--native"
      aria-label={props.title} onClick={(event) => event.stopPropagation()}>
      <div className="ws-open-dialog__header"><strong>{props.title}</strong></div>
      <p className="ws-open-dialog__error" role="alert">{error}</p>
      <div className="ws-open-dialog__footer">
        <button type="button" autoFocus className="ws-open-dialog__btn" onClick={props.onCancel}>
          {t(props.language, 'workspaceDialog.cancel')}
        </button>
      </div>
    </div>
  </ModalDialog>;
}
