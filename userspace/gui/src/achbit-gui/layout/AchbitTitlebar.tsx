import React from 'react';
import WindowControls from '../../components/window-controls/WindowControls';
import { type UiLanguage } from '../../i18n';

const AchbitTitlebar: React.FC<{ language: UiLanguage; sessionHeaderRef: React.Ref<HTMLDivElement>; settings?: React.ReactNode }> = ({ language, sessionHeaderRef, settings }) => (
  <header className="achbit-gui-titlebar" data-tauri-drag-region="deep">
    <div className="achbit-gui-session-header" ref={sessionHeaderRef} hidden={!!settings} inert={!!settings} />
    {settings && <div className="achbit-gui-settings-header">{settings}</div>}
    <WindowControls language={language} />
  </header>
);

export default AchbitTitlebar;
