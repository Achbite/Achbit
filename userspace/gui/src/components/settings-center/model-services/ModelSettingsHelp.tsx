import type { ReactNode } from 'react';
import { Button } from '../../../ui-components';
import { useSettingsHelp } from '../SettingsHelp';
import { useModelLanguage } from './modelServiceSettings';

export function ModelSettingsHelp({ children, label = 'ⓘ' }: { children: ReactNode; label?: string }) {
  const { text } = useModelLanguage();
  const { helpId, helpEvents, help } = useSettingsHelp(children, { showOnClick: true });
  return <span className="model-hint">
    <Button size="compact" {...helpEvents} aria-describedby={helpId}
      aria-label={label === 'ⓘ' || label === '*' ? text('更多说明', 'More information') : label}>{label}</Button>
    {help}
  </span>;
}
