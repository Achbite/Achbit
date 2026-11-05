import { IconButton, type IconButtonProps } from './IconButton';

export type CloseButtonProps = Omit<IconButtonProps, 'icon'>;

/** Presentation only: dismiss, skip, cancel and close-tab remain owner callbacks. */
export function CloseButton(props: CloseButtonProps) {
  return <IconButton icon="close" data-ui-component="CloseButton" {...props} />;
}
