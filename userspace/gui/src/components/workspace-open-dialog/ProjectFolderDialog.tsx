import AchbitShellIcon from '../shared/AchbitShellIcon';
import ModalDialog from '../shared/ModalDialog';
import React, { useEffect, useMemo, useState } from 'react';
import type { BrowseEntry, BrowsePathResult, InitialLocation } from '@achbit/protocol';
import { t, type UiLanguage } from '../../i18n';
import { browsePath, getInitialLocations, hasNativePathPicker, type NativePathOptions, type NativePathSelection } from '../../services/runtimeAdapter';
import NativePathDialog from './NativePathDialog';
import './workspaceOpenDialog.css';

interface ProjectFolderDialogProps {
  language: UiLanguage;
  onCancel: () => void;
  onSelect: (absolutePath: string, type: BrowseEntry['type']) => void;
  onSelectMany?: (paths: NativePathSelection[]) => void;
  selectionMode?: 'directory' | 'file' | 'path' | 'messageAttachment';
  title?: string;
  filters?: NativePathOptions['filters'];
}

const BrowserProjectFolderDialog: React.FC<ProjectFolderDialogProps> = ({
  language,
  onCancel,
  onSelect,
  onSelectMany,
  selectionMode = 'directory',
  title,
  filters,
}) => {
  const [locations, setLocations] = useState<InitialLocation[]>([]);
  const [browseResult, setBrowseResult] = useState<BrowsePathResult | null>(null);
  const [addressInput, setAddressInput] = useState('');
  const [selectedEntry, setSelectedEntry] = useState<BrowseEntry | null>(null);
  const [selectedFiles, setSelectedFiles] = useState<BrowseEntry[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showHidden, setShowHidden] = useState(false);

  const navigateTo = async (absolutePath: string): Promise<void> => {
    setLoading(true);
    setError(null);
    setSelectedEntry(null);
    setSelectedFiles([]);
    const result = await browsePath(absolutePath);
    if (result.ok && result.data) {
      setBrowseResult(result.data);
      setAddressInput(result.data.absolutePath);
    } else {
      setError(result.message ?? t(language, 'workspaceDialog.error.browse'));
    }
    setLoading(false);
  };

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      setLoading(true);
      const result = await getInitialLocations();
      if (cancelled) return;
      if (!result.ok || !result.data) {
        setError(result.message ?? t(language, 'workspaceDialog.error.initialLocations'));
        setLoading(false);
        return;
      }
      setLocations(result.data.locations);
      const first = result.data.locations[0];
      if (first) await navigateTo(first.absolutePath);
      else setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
    // navigateTo deliberately remains local to this modal instance.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const isAttachmentSelection = selectionMode === 'messageAttachment';
  const allowsFiles = selectionMode !== 'directory';
  const entries = useMemo(
    () => (browseResult?.entries ?? []).filter((entry) => (
      (showHidden || !entry.hidden)
      && (allowsFiles || entry.type === 'directory')
      && (entry.type === 'directory' || !filters?.length || filters.some((filter) => (
        filter.extensions.some((extension) => entry.name.toLowerCase().endsWith(`.${extension.toLowerCase()}`))
      )))
    )),
    [browseResult, allowsFiles, showHidden, filters],
  );
  const selectedPath = selectedEntry?.absolutePath ?? browseResult?.absolutePath ?? '';
  const selectedType = selectedEntry?.type ?? 'directory';

  return (
    <ModalDialog className="ws-open-dialog__backdrop" onClose={onCancel} aria-label={title ?? t(language, 'achbitGui.project.folderDialogTitle')}>
      <div
        className={`ws-open-dialog${isAttachmentSelection ? ' ws-open-dialog--message-attachment' : ''}`}
        aria-label={title ?? t(language, isAttachmentSelection
          ? 'agent.attachment.pickerTitle'
          : 'achbitGui.project.folderDialogTitle')}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="ws-open-dialog__header">
          <span>
            <strong>{title ?? t(language, isAttachmentSelection
              ? 'agent.attachment.pickerTitle'
              : 'achbitGui.project.folderDialogTitle')}</strong>
            {isAttachmentSelection && (
              <small>{t(language, 'agent.attachment.pickerDescription')}</small>
            )}
          </span>
          <button
            type="button"
            className="ws-open-dialog__close"
            aria-label={t(language, 'workspaceDialog.cancel')}
            onClick={onCancel}
          ><AchbitShellIcon name="close" size={14} /></button>
        </div>
        <div className="ws-open-dialog__addressbar">
          <button
            type="button"
            className="ws-open-dialog__btn"
            disabled={!browseResult?.parentPath}
            onClick={() => browseResult?.parentPath && void navigateTo(browseResult.parentPath)}
          >
            {t(language, 'workspaceDialog.up')}
          </button>
          <input
            className="ws-open-dialog__address"
            value={addressInput}
            onChange={(event) => setAddressInput(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && addressInput.trim()) {
                void navigateTo(addressInput.trim());
              }
            }}
          />
          <button
            type="button"
            className="ws-open-dialog__btn"
            onClick={() => addressInput.trim() && void navigateTo(addressInput.trim())}
          >
            {t(language, 'workspaceDialog.go')}
          </button>
          <label className="ws-open-dialog__toggle">
            <input
              type="checkbox"
              checked={showHidden}
              onChange={(event) => setShowHidden(event.target.checked)}
            />
            <span>{t(language, 'workspaceDialog.hidden')}</span>
          </label>
        </div>
        <div className="ws-open-dialog__body">
          <aside className="ws-open-dialog__sidebar">
            <div className="ws-open-dialog__sidebar-title">
              {t(language, 'workspaceDialog.quickLocations')}
            </div>
            {locations.map((location) => (
              <button
                type="button"
                key={`${location.kind}:${location.absolutePath}`}
                className="ws-open-dialog__sidebar-item"
                onClick={() => void navigateTo(location.absolutePath)}
                title={location.absolutePath}
              >
                <span className="ws-open-dialog__sidebar-icon">
                  <AchbitShellIcon name={location.kind === 'home' ? 'account' : 'folder'} size={16} />
                </span>
                <span>{location.label}</span>
              </button>
            ))}
          </aside>
          <main className="ws-open-dialog__main">
            {loading && <div className="ws-open-dialog__placeholder">{t(language, 'workspaceDialog.loading')}</div>}
            {error && <div className="ws-open-dialog__error">{error}</div>}
            {!loading && !error && entries.length === 0 && (
              <div className="ws-open-dialog__placeholder">{t(language, 'workspaceDialog.empty')}</div>
            )}
            {!loading && !error && entries.length > 0 && (
              <ul className="ws-open-dialog__entries">
                {entries.map((entry) => (
                  <li
                    key={entry.absolutePath}
                    className={`ws-open-dialog__entry${selectedEntry?.absolutePath === entry.absolutePath || selectedFiles.some(file => file.absolutePath === entry.absolutePath) ? ' ws-open-dialog__entry--selected' : ''}`}
                    onClick={(event) => {
                      if (isAttachmentSelection && entry.type === 'file') {
                        setSelectedEntry(null);
                        setSelectedFiles(current => event.metaKey || event.ctrlKey
                          ? current.some(file => file.absolutePath === entry.absolutePath)
                            ? current.filter(file => file.absolutePath !== entry.absolutePath) : [...current, entry]
                          : [entry]);
                      } else { setSelectedFiles([]); setSelectedEntry(entry); }
                    }}
                    onDoubleClick={() => {
                      if (entry.type === 'directory') {
                        void navigateTo(entry.absolutePath);
                      } else if (allowsFiles) {
                        onSelectMany ? onSelectMany([{ path: entry.absolutePath, kind: entry.type }]) : onSelect(entry.absolutePath, entry.type);
                      }
                    }}
                    title={entry.absolutePath}
                  >
                    {isAttachmentSelection && entry.type === 'file' && <input type="checkbox"
                      aria-label={entry.name} checked={selectedFiles.some(file => file.absolutePath === entry.absolutePath)}
                      onClick={event => event.stopPropagation()} onChange={() => {
                        setSelectedEntry(null);
                        setSelectedFiles(current => current.some(file => file.absolutePath === entry.absolutePath)
                          ? current.filter(file => file.absolutePath !== entry.absolutePath) : [...current, entry]);
                      }} />}
                    <span className="ws-open-dialog__entry-icon">
                      <AchbitShellIcon name={entry.type === 'directory' ? 'folder' : 'file'} size={16} />
                    </span>
                    <span className="ws-open-dialog__entry-name">{entry.name}</span>
                  </li>
                ))}
              </ul>
            )}
          </main>
        </div>
        <div className="ws-open-dialog__footer">
          <div className="ws-open-dialog__footer-info" title={selectedPath}>{selectedFiles.length ? `${selectedFiles.length} ${language === 'zh-CN' ? '个文件' : 'files'}` : selectedPath}</div>
          <div className="ws-open-dialog__footer-actions">
            <button type="button" className="ws-open-dialog__btn" onClick={onCancel}>
              {t(language, 'workspaceDialog.cancel')}
            </button>
            <button
              type="button"
              className="ws-open-dialog__btn ws-open-dialog__btn--primary"
              disabled={!selectedPath || !selectedType || (selectionMode === 'file' && selectedType !== 'file')}
              onClick={() => {
                if (selectedFiles.length && onSelectMany) onSelectMany(selectedFiles.map(file => ({ path: file.absolutePath, kind: 'file' })));
                else if (selectedPath && selectedType) onSelect(selectedPath, selectedType);
              }}
            >
              {t(language, selectionMode === 'file' ? 'reader.open' : allowsFiles
                ? 'agent.attachment.attachSelected'
                : 'workspaceDialog.openSelectedFolder')}
            </button>
          </div>
        </div>
      </div>
    </ModalDialog>
  );
};

export default function ProjectFolderDialog(props: ProjectFolderDialogProps) {
  if (!hasNativePathPicker()) return <BrowserProjectFolderDialog {...props} />;
  const kind = props.selectionMode === 'messageAttachment' ? 'path' : props.selectionMode ?? 'directory';
  return <NativePathDialog language={props.language} kind={kind} filters={props.filters} multiple={props.selectionMode === 'messageAttachment'}
    selectLabel={props.selectionMode === 'messageAttachment'
      ? t(props.language, 'agent.attachment.attachSelected') : (props.language === 'zh-CN' ? '选择' : 'Select')}
    cancelLabel={t(props.language, 'workspaceDialog.cancel')}
    title={props.title ?? t(props.language, kind === 'directory'
      ? 'achbitGui.project.folderDialogTitle' : 'agent.attachment.pickerTitle')}
    onSelect={props.onSelect} onSelectMany={props.onSelectMany} onCancel={props.onCancel} />;
}
