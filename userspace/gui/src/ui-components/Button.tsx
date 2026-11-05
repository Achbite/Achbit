import type { ComponentPropsWithRef } from 'react';
import './controls.css';

export type ButtonVariant = 'ghost' | 'secondary' | 'primary' | 'danger';
export type ControlSize = 'compact' | 'standard' | 'large';
export type ButtonProps = ComponentPropsWithRef<'button'> & {
  variant?: ButtonVariant;
  size?: ControlSize;
};

/** Native button semantics and refs; feature owners supply all actions and copy. */
export function Button({ variant = 'ghost', size = 'standard', type = 'button', className = '', ...props }: ButtonProps) {
  return <button type={type} className={`ac-button ${className}`.trim()}
    data-ui-component="Button" data-variant={variant} data-size={size} {...props} />;
}
