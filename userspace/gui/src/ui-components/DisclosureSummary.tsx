import type { ComponentPropsWithRef } from 'react';
import UiIcon from '../icons/registry';
import './controls.css';

export type DisclosureSummaryProps = ComponentPropsWithRef<'summary'>;

/** Native summary; the owning details element retains expansion and toggle behavior. */
export function DisclosureSummary({ className = '', children, ...props }: DisclosureSummaryProps) {
  return <summary className={`ac-disclosure-summary ${className}`.trim()} data-ui-component="DisclosureSummary" {...props}>
    {children}
    <UiIcon name="chevronRight" className="ac-disclosure-summary__chevron" size={12} />
  </summary>;
}
