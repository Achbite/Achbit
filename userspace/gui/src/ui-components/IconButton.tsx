import UiIcon, { type UiIconName } from '../icons/registry';
import { Button, type ButtonProps } from './Button';

export type IconButtonProps = Omit<ButtonProps, 'children'> & {
  icon: UiIconName;
  'aria-label': string;
};

/** A named icon action, composed from Button rather than a second control implementation. */
export function IconButton({ icon, className = '', title, 'aria-label': label, ...props }: IconButtonProps) {
  return <Button className={`ac-icon-button ${className}`.trim()} title={title ?? label}
    aria-label={label} data-ui-component="IconButton" {...props}>
    <UiIcon name={icon} />
  </Button>;
}
