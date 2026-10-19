import { t, type UiLanguage } from '../../i18n';
import ModalDialog from '../shared/ModalDialog';
import type { ResolvedLocalTarget } from './resourceLinks';

export function ResourceLinkChoices({ targets, language, onSelect, onClose }: {
  targets: readonly ResolvedLocalTarget[];
  language: UiLanguage;
  onSelect(target: ResolvedLocalTarget): void;
  onClose(): void;
}) {
  return <ModalDialog className="local-agent__link-choices" aria-label={t(language, 'agent.link.chooseTarget')} onClose={onClose}>
    <header><h2>{t(language, 'agent.link.chooseTarget')}</h2>
      <button type="button" onClick={onClose}>{t(language, 'window.close')}</button></header>
    <p>{t(language, 'agent.link.multipleTargets')}</p>
    <ul>{targets.map(target => <li key={target.path}>
      <button type="button" onClick={() => onSelect(target)}>{target.path}{target.line ? `:${target.line}` : ''}</button>
    </li>)}</ul>
  </ModalDialog>;
}
