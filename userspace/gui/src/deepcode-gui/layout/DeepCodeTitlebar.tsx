import React from 'react';
import WindowControls from '../../components/window-controls/WindowControls';
import { type UiLanguage } from '../../i18n';

const DeepCodeTitlebar: React.FC<{ language: UiLanguage; sessionHeaderRef: React.Ref<HTMLDivElement>; settings?: React.ReactNode }> = ({ language, sessionHeaderRef, settings }) => (
  <header className="deepcode-gui-titlebar" data-tauri-drag-region="deep">
    <div className="deepcode-gui-session-header" ref={sessionHeaderRef} hidden={!!settings} inert={!!settings} />
    {settings && <div className="deepcode-gui-settings-header">{settings}</div>}
    <WindowControls language={language} />
  </header>
);

export default DeepCodeTitlebar;
