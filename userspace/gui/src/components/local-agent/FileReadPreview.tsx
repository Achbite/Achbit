import { useEffect, useState } from 'react';
import type { ConversationResourceReadResult } from '../../services/localAgentApi';
import type { UiLanguage } from '../../i18n';
import { useConversationHost } from './ConversationHost';
import { requestReader } from './readerState';

/** Same workspace resource as the Reader; label it as current content, not a historical tool snapshot. */
export function FileReadPreview({ sessionId, workspaceId, path, language }: {
  sessionId: string; workspaceId: string; path: string; language: UiLanguage;
}) {
  const { resources } = useConversationHost();
  const [state, setState] = useState<{ result?: ConversationResourceReadResult; error?: string }>({});
  useEffect(() => {
    const controller = new AbortController();
    setState({});
    void resources.readResourceReference(sessionId, { workspaceId, logicalPath: path }, controller.signal)
      .then(result => { if (!controller.signal.aborted) setState({ result }); })
      .catch(error => { if (!controller.signal.aborted) setState({ error: String(error) }); });
    return () => controller.abort();
  }, [resources, sessionId, workspaceId, path]);
  return <section className="conversation-changes conversation-changes--inline">
    <div className="conversation-change-row">
      <button type="button" className="conversation-change-file" title={path}
        onClick={() => requestReader(sessionId, { kind: 'workspace', workspaceId, logicalPath: path })}>
        <span>{path}</span><small>{language === 'zh-CN' ? '当前文件' : 'Current file'}</small>
      </button>
      {state.error ? <p className="conversation-inline-notice" role="alert">{state.error}</p>
        : !state.result ? <p className="conversation-inline-notice" role="status">{language === 'zh-CN' ? '正在读取…' : 'Loading…'}</p>
        : <>
          <div className="conversation-inline-code">
            {state.result.content.split('\n').map((line, index) => <div className="conversation-inline-line" key={index}>
              <span className="conversation-inline-number">{state.result!.startLine + index}</span><code>{line || '\u200b'}</code>
            </div>)}
          </div>
          {state.result.truncated && <p className="conversation-inline-notice">{language === 'zh-CN' ? '仅显示部分内容' : 'Showing part of the file'}</p>}
        </>}
    </div>
  </section>;
}
