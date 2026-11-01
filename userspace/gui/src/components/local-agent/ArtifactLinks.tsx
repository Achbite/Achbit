import { useUiOwner } from '../../ui-ownership/useUiOwner';
import { useLocalAgentStore } from '../../state/localAgentStore';
import { t } from '../../i18n';
import { useUiLanguage } from '../../useUiLanguage';
import React from 'react';
import type { ArtifactProjection } from '@achbit/protocol';
import { workspaceResourceLink } from './documentResources';
import { requestReader } from './readerState';
import { useConversationHost } from './ConversationHost';
import AchbitShellIcon from '../shared/AchbitShellIcon';
import { ImageReview } from './ImageReview';

type ArtifactLinkLocation = 'outputs' | 'conversation' | 'shortcuts' | 'agent';
export function ArtifactLinks({ artifacts, onOpen, location }: {
  artifacts: readonly ArtifactProjection[];
  onOpen(workspaceId: string, logicalPath: string): Promise<void>;
  location: ArtifactLinkLocation;
}) {
  const identity = useUiOwner('conversation.artifacts', undefined, { location });
  const host = useConversationHost();
  const [error, setError] = React.useState<string | null>(null);
  return <div className="document-artifacts document-artifacts--compact">
    {artifacts.map((artifact) => {
      const fixed = artifact.contentMode === 'fixed';
      const resource = artifact.workspaceId && artifact.logicalPath
        ? { workspaceId: artifact.workspaceId, logicalPath: artifact.logicalPath }
        : workspaceResourceLink(artifact.uri ?? '');
      const external = /^https?:\/\//i.test(artifact.uri ?? '') ? artifact.uri : null;
      const imagePreview = artifact.contentType.startsWith('image/') && fixed;
      const label = artifact.label.split(/[\\/]/u).at(-1) ?? artifact.label;
      const resourceLocation = artifact.logicalPath ?? artifact.uri ?? artifact.label;
      const title = `${resourceLocation}\n${formatArtifactTime('updatedAt' in artifact ? String(artifact.updatedAt) : artifact.createdAt)}`;
      const trigger = identity.action('open', 'click', { sessionId: artifact.sessionId, artifactId: artifact.artifactId });
      if (imagePreview) return <ArtifactImageLink trigger={trigger} key={artifact.artifactId} artifact={artifact} label={label} title={title} />;
      const content = <><span className="document-artifacts__thumbnail"><AchbitShellIcon name={artifact.contentType === 'text/html' ? 'browser' : 'artifact'} /></span><strong>{label}</strong></>;
      return fixed || resource || external ? <button {...trigger} type="button" className="achbit-gui-output-item document-artifacts__item" key={artifact.artifactId}
        aria-label={label} title={title}
        onClick={() => { setError(null); if(fixed) {requestReader(artifact.sessionId,{kind:'artifact',artifact});return;} void (resource ? onOpen(resource.workspaceId, resource.logicalPath) : host.openExternalLink(external!))
          .catch((reason: unknown) => setError(reason instanceof Error ? reason.message : String(reason))); }}>{content}</button>
        : <div className="achbit-gui-output-item document-artifacts__item" title={resourceLocation} key={artifact.artifactId}>{content}</div>;
    })}
    {error && <p role="alert" className="local-agent__resource-error">{error}</p>}
  </div>;
}

export function ArtifactImageLink({ artifact, label, title, trigger, className = 'achbit-gui-output-item document-artifacts__item' }: {
  artifact: ArtifactProjection; label: string; title: string; className?: string;
  trigger?: React.ComponentProps<typeof ImageReview>['triggerIdentity'];
}) {
  const language = useUiLanguage();
  const runtimeReady = useLocalAgentStore(state => state.runtimeReady);
  const host=useConversationHost();
  const [url,setUrl]=React.useState('');
  const [error,setError]=React.useState<string|null>(null);
  React.useEffect(()=>{
    if (!runtimeReady) return;
    const controller=new AbortController();let release:(()=>void)|undefined;
    setUrl('');setError(null);
    void host.loadImage(artifact.sessionId,`artifact://${artifact.artifactId}`,controller.signal).then((result)=>{
      if(controller.signal.aborted){result.release?.();return;}release=result.release;setUrl(result.url);
    }).catch((reason:unknown)=>{if(!controller.signal.aborted)setError(String(reason));});
    return ()=>{controller.abort();release?.();};
  },[artifact.sessionId,artifact.artifactId,host,runtimeReady]);
  const failed = () => setError(t(language, 'content.image.decodeError'));
  return <ImageReview triggerIdentity={trigger} source={error ? undefined : url || undefined} alt={label}
    className={className} title={error ?? title} onError={failed}>
    <span className="document-artifacts__thumbnail">{error ? <span role="alert" title={error}>!</span>
      : url ? <img className="document-artifact-image" src={url} alt="" onError={failed} />
      : <span aria-label={t(language, 'reader.imageLoading')}><AchbitShellIcon name="artifact" /></span>}</span>
    <strong>{label}</strong>
  </ImageReview>;
}

function formatArtifactTime(value: string): string {
  const date = new Date(/^\d+$/u.test(value) ? Number(value) : value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}

/** Hidden shortcuts do not fetch thumbnails. Retain them after the first opening. */
export function ArtifactShortcuts({ title, ...props }: React.ComponentProps<typeof ArtifactLinks> & { title: string }) {
  const [opened, setOpened] = React.useState(false);
  return <details className="conversation-artifact-shortcuts" onToggle={event => {
    if (event.currentTarget.open) setOpened(true);
  }}>
    <summary>{title}</summary>
    {opened && <ArtifactLinks {...props} />}
  </details>;
}
