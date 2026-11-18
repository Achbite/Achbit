import React from 'react';
import { createRoot } from 'react-dom/client';
import type { ArtifactProjection } from '@achbit/protocol';
import { ArtifactInteractivePreview } from '../../src/components/local-agent/InteractivePreview';
import { useConversationHost } from '../../src/components/local-agent/ConversationHost';
import { Button } from '../../src/ui-components';
import { installPaletteDefaults } from '../../src/theme/palette';
import { typographyStyles } from '../../src/theme/typography';
import '../../src/achbit-gui/styles/achbitDesignTokens.css';
import '../../src/theme/paletteBase.css';
import '../../src/components/shared/focus.css';
import '../../src/components/local-agent/localAgentPanel.css';
import '../../src/components/local-agent/documentPreview.css';
import '../../src/components/local-agent/richContent.css';

const samples = {
  small: 'button{width:48px;height:36px}',
  fixed: 'button{width:640px;height:140px}',
  application: 'html,body{height:100%;overflow:hidden}button{position:absolute;right:0;top:0;width:52px;height:36px}',
};
const sessionId = 'session:preview-layout';
function artifact(id: string): ArtifactProjection {
  return { sessionId, artifactId: id, label: id + '.html', runId: 'run:layout', callId: 'call:layout',
    recordId: 'record:' + id, createdAt: '2026-01-01T00:00:00Z', contentType: 'text/html', contentMode: 'fixed' };
}
const host = useConversationHost();
const previousRead = host.readArtifact;
host.readArtifact = async (session, id, signal) => {
  if (session !== sessionId || !Object.hasOwn(samples, id)) return previousRead(session, id, signal);
  const css = samples[id as keyof typeof samples];
  const html = `<!doctype html><style>body{margin:0}button{display:block}${css}</style><button>打开</button>
    <script>document.querySelector('button').onclick=()=>parent.postMessage('layout:activate','*')</script>`;
  return new Blob([html], { type: 'text/html' });
};
let activations = 0;
addEventListener('message', event => {
  if (event.data === 'layout:activate' && [...document.querySelectorAll('iframe')].some(f => f.contentWindow === event.source)) activations++;
});
function configure(width: number, font: number, zoom: number) {
  const style = document.documentElement.style;
  style.setProperty('--fixture-width', width + 'px');
  style.setProperty('--fixture-height', window.innerHeight / zoom + 'px');
  style.zoom = String(zoom);
  for (const [key, value] of Object.entries(typographyStyles({ 'gui.fontSize': font, 'gui.contentFontSize': font }))) {
    style.setProperty(key, String(value));
  }
}
Object.assign(window, { previewLayout: { configure, activations: () => activations } });
installPaletteDefaults();
configure(1100, 14, 1);
function Fixture() {
  const reader = new URLSearchParams(location.search).get('reader');
  const pane: React.CSSProperties = { width: 'min(100%, var(--fixture-width))', height: 'calc(var(--fixture-height) - 40px)', marginInline: 'auto', padding: 0 };
  if (reader && Object.hasOwn(samples, reader)) return <main className="local-agent" style={{ ...pane, display: 'flex', flexDirection: 'column' }}>
    <ArtifactInteractivePreview sessionId={sessionId} artifact={artifact(reader)} />
  </main>;
  return <><Button id="outside">对话</Button><main style={{ ...pane, display: 'block' }} className="local-agent local-agent--expanded local-agent--workbench">
    <div className="local-agent__body"><div className="local-agent__transcript"><article className="local-agent__message local-agent__message--assistant">
      <div className="local-agent__message-content"><div className="conversation-markdown">
        {Object.keys(samples).map(id => <ArtifactInteractivePreview key={id} inline sessionId={sessionId} artifact={artifact(id)} />)}
      </div></div>
    </article></div></div>
  </main></>;
}
createRoot(document.getElementById('root')!).render(<Fixture />);
