import { useId, useState } from 'react';
import type { QueuedInputProjection } from '@achbit/protocol';
import { Button, CloseButton, ModalDialog, PanelHeader } from '../../ui-components';
import { t, type UiLanguage } from '../../i18n';
import { useUiOwner } from '../../ui-ownership/useUiOwner';
import './viewerDialog.css';

/** Compact presentation only: the queued text and its trailing newlines remain untouched. */
export function QueuedInputPreview({ sessionId, input, language }: {
  sessionId: string; input: QueuedInputProjection; language: UiLanguage;
}) {
  const identity = useUiOwner('composer.queued-input', undefined, { sessionId, commandId: input.commandId });
  const [open, setOpen] = useState(false);
  const titleId = useId();
  const close = () => setOpen(false);
  return <div className="local-agent__queued-input" role="status">
    <strong>{t(language, 'agent.queued.waiting')}</strong>
    <Button {...identity.action('open', 'click')} className="local-agent__queued-preview" size="compact" aria-haspopup="dialog"
      aria-label={t(language, 'agent.queued.view')} title={t(language, 'agent.queued.view')} onClick={() => setOpen(true)}>
      <span>{input.text}{input.filesystemReferences.length ? ` · ${input.filesystemReferences.map(item => item.displayName).join(', ')}` : ''}</span>
    </Button>
    {open && <ModalDialog className="conversation-viewer-dialog conversation-queued-dialog" aria-labelledby={titleId} onClose={close}>
      <PanelHeader className="conversation-queued-dialog__header">
        <h2 id={titleId}>{t(language, 'agent.queued.view')}</h2>
        <CloseButton {...identity.action('close', 'click')} aria-label={t(language, 'agent.queued.close')} onClick={close} />
      </PanelHeader>
      <div className="conversation-queued-dialog__body" tabIndex={0}>
        <pre>{input.text}</pre>
        {!!input.filesystemReferences.length && <ul>{input.filesystemReferences.map(item => <li key={item.referenceId}>{item.displayName}</li>)}</ul>}
        {!!input.pluginSelections.length && <ul>{input.pluginSelections.map(item => <li key={item.selectionId}>@{item.label}</li>)}</ul>}
        {!!input.guidanceReferences?.length && <ul>{input.guidanceReferences.map(item => <li key={item.referenceId}>{item.label}</li>)}</ul>}
      </div>
    </ModalDialog>}
  </div>;
}
