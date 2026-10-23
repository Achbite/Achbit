import React from 'react';
import { t, type UiLanguage } from '../../i18n';
import AchbitShellIcon from '../shared/AchbitShellIcon';

/** Dismisses only the owner's current UI error, never Session facts or drafts. */
export function DismissibleError({ children, language, onDismiss }: {
  children: React.ReactNode;
  language: UiLanguage;
  onDismiss(): void;
}) {
  return <div className="local-agent__error local-agent__error--dismissible" role="alert">
    <div className="local-agent__error-content">{children}</div>
    <button type="button" className="local-agent__error-close" onClick={onDismiss}
      aria-label={t(language, 'agent.error.dismiss')} title={t(language, 'agent.error.dismiss')}>
      <AchbitShellIcon name="close" size={14} />
    </button>
  </div>;
}
