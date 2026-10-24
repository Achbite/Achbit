import type { ProjectionMessage } from '@achbit/protocol';
import { t, type UiLanguage } from '../../i18n';

export function SourceReferences({ references, language }: {
  references: ProjectionMessage['sourceReferences']; language: UiLanguage;
}) {
  if (!references) return null;
  return <aside className="local-agent__source-references">
    {references.citations.length > 0 && <><span>{t(language, 'agent.sources.title')}</span>
      <ul>{references.citations.map((citation, index) => <li key={`${citation.url}:${index}`}>
        <a href={citation.url}>{citation.title}</a>
      </li>)}</ul></>}
    {references.unresolved && <p>{t(language, 'agent.sources.unresolved')}</p>}
  </aside>;
}
