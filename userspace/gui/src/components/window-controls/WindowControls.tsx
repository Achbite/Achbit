import { UiIcon } from '../../ui-components';
import React from 'react';
import { t, type UiLanguage } from '../../i18n';
import {
  minimizeAppWindow,
  requestCloseAppWindow,
  toggleMaximizeAppWindow,
} from '../../services/runtimeAdapter';
import { usesNativeWindowChrome } from '../../services/hostTarget';
import './windowControls.css';

interface WindowControlsProps {
  language: UiLanguage;
}

const WindowControls: React.FC<WindowControlsProps> = ({ language }) => {
  if (usesNativeWindowChrome()) return null;
  return (
    <div className="window-controls" aria-label={t(language, 'window.controls')}>
      <button
        type="button"
        className="window-control window-control--minimize"
        title={t(language, 'window.minimize')}
        aria-label={t(language, 'window.minimize')}
        onClick={() => void minimizeAppWindow()}
      ><UiIcon name="minus" size={16} /></button>
      <button
        type="button"
        className="window-control window-control--maximize"
        title={t(language, 'window.maximize')}
        aria-label={t(language, 'window.maximize')}
        onClick={() => void toggleMaximizeAppWindow()}
      ><UiIcon name="maximize" size={16} /></button>
      <button
        type="button"
        className="window-control window-control--close"
        title={t(language, 'window.close')}
        aria-label={t(language, 'window.close')}
        onClick={requestCloseAppWindow}
      ><UiIcon name="close" size={16} /></button>
    </div>
  );
};

export default WindowControls;
