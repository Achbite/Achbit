import AchbitShellIcon from '../shared/AchbitShellIcon';
import { Button, CloseButton, ModalDialog, PanelHeader } from '../../ui-components';
import React, { useEffect, useMemo, useRef, useState } from 'react';
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
  const navigation = useRef(0);

  const navigateTo = async (absolutePath: string): Promise<void> => {
    const request = ++navigation.current;
    setLoading(true);
    setError(null);
    setBrowseResult(null);
    setAddressInput(absolutePath);
    setSelectedEntry(null);
    setSelectedFiles([]);
    try {
      const result = await browsePath(absolutePath);
      if (request !== navigation.current) return;
      if (result.ok && result.data) {
        setBrowseResult(result.data);
        setAddressInput(result.data.absolutePath);
      } else {
        setError(result.message ?? t(language, 'workspaceDialog.error.browse'));
      }
    } catch (cause) {
      if (request === navigation.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (request === navigation.current) setLoading(false);
    }
  };

  useEffect(() => {
    let cancelled = false;
    const initialNavigation = navigation.current;
    void (async () => {
      setLoading(true);
      const result = await getInitialLocations();
      if (cancelled) return;
      if (!result.ok || !result.data) {
        if (navigation.current !== initialNavigation) return;
        setError(result.message ?? t(language, 'workspaceDialog.error.initialLocations'));
        setLoading(false);
        return;
      }
      setLocations(result.data.locations);
      if (navigation.current !== initialNavigation) return;
      const first = result.data.locations[0];
      if (first) await navigateTo(first.absolutePath);
      else setLoading(false);
    })();
    return () => {
      cancelled = true;
      navigation.current++;
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
  const canConfirm = !loading && !error && Boolean(selectedPath)
    && (selectionMode !== 'file' || selectedType === 'file');
  const selectEntry = (entry: BrowseEntry, additive = false) => {
    if (isAttachmentSelection && entry.type === 'file') {
      setSelectedEntry(null);
      setSelectedFiles(current => additive
        ? current.some(file => file.absolutePath === entry.absolutePath)
          ? current.filter(file => file.absolutePath !== entry.absolutePath) : [...current, entry]
        : [entry]);
    } else { setSelectedFiles([]); setSelectedEntry(entry); }
  };
  const openEntry = (entry: BrowseEntry) => {
    if (entry.type === 'directory') void navigateTo(entry.absolutePath);
    else if (allowsFiles) {
      onSelectMany ? onSelectMany([{ path: entry.absolutePath, kind: entry.type }]) : onSelect(entry.absolutePath, entry.type);
    }
  };

  return (
    <ModalDialog className="ws-open-dialog__backdrop" onClose={onCancel} aria-label={title ?? t(language, 'achbitGui.project.folderDialogTitle')}>
      <div
        className={`ws-open-dialog${isAttachmentSelection ? ' ws-open-dialog--message-attachment' : ''}`}
        aria-label={title ?? t(language, isAttachmentSelection
          ? 'agent.attachment.pickerTitle'
          : 'achbitGui.project.folderDialogTitle')}
        onClick={(event) => event.stopPropagation()}
      >
        <PanelHeader className="ws-open-dialog__header">
          <span>
            <strong>{title ?? t(language, isAttachmentSelection
              ? 'agent.attachment.pickerTitle'
              : 'achbitGui.project.folderDialogTitle')}</strong>
            {isAttachmentSelection && (
              <small>{t(language, 'agent.attachment.pickerDescription')}</small>
            )}
          </span>
          <CloseButton aria-label={t(language, 'workspaceDialog.cancel')} onClick={onCancel} />
        </PanelHeader>
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
              if (event.key === 'Enter' && !event.nativeEvent.isComposing && addressInput.trim()) {
                event.preventDefault();
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
                    title={entry.absolutePath}
                  >
                    {isAttachmentSelection && entry.type === 'file' && <input type="checkbox"
                      aria-label={entry.name} checked={selectedFiles.some(file => file.absolutePath === entry.absolutePath)}
                      onClick={event => event.stopPropagation()} onChange={() => {
                        setSelectedEntry(null);
                        setSelectedFiles(current => current.some(file => file.absolutePath === entry.absolutePath)
                          ? current.filter(file => file.absolutePath !== entry.absolutePath) : [...current, entry]);
                      }} />}
                    <Button size="compact" className="ws-open-dialog__entry-action"
                      aria-pressed={selectedEntry?.absolutePath === entry.absolutePath || selectedFiles.some(file => file.absolutePath === entry.absolutePath)}
                      onClick={event => selectEntry(entry, event.metaKey || event.ctrlKey)}
                      onDoubleClick={() => openEntry(entry)}
                      onKeyDown={event => {
                        if (event.nativeEvent.isComposing || event.repeat) return;
                        if (event.key === 'Enter') {
                          event.preventDefault(); event.stopPropagation(); openEntry(entry); return;
                        }
                        if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return;
                        const rows = [...(event.currentTarget.closest('ul')?.querySelectorAll<HTMLButtonElement>('.ws-open-dialog__entry-action') ?? [])];
                        const index = rows.indexOf(event.currentTarget);
                        const next = event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1
                          : Math.max(0, Math.min(rows.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)));
                        event.preventDefault(); rows[next]?.focus();
                      }}>
                      <span className="ws-open-dialog__entry-icon">
                        <AchbitShellIcon name={entry.type === 'directory' ? 'folder' : 'file'} size={16} />
                      </span>
                      <span className="ws-open-dialog__entry-name">{entry.name}</span>
                    </Button>
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
              disabled={!canConfirm}
              onClick={() => {
                if (!canConfirm) return;
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
