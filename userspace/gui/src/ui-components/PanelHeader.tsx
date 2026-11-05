import type { ComponentPropsWithRef } from 'react';
import './controls.css';

export type PanelHeaderProps = ComponentPropsWithRef<'header'>;

/** Shared title/action alignment; children retain their headings, labels and owner identities. */
export function PanelHeader({ className = '', ...props }: PanelHeaderProps) {
  return <header className={`ac-panel-header ${className}`.trim()} data-ui-component="PanelHeader" {...props} />;
}
