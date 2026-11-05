import { Button as ButtonView } from './Button';
import { IconButton as IconButtonView } from './IconButton';
import { CloseButton as CloseButtonView } from './CloseButton';
import { PanelHeader as PanelHeaderView } from './PanelHeader';
import ModalDialogView from '../components/shared/ModalDialog';
import ToggleSwitchView from '../components/shared/ToggleSwitch';
import NativeSelectView from '../components/shared/NativeSelect';
import ResizeHandleView from '../components/shared/ResizeHandle';
import IconView from '../icons/registry';

/** Static implementation catalog, not another plugin runtime or state store.
 * Register once here; consumers import the named exports below. Component identities
 * remain unchanged, so registration never adds wrappers or resets mounted state.
 */
export const UI_COMPONENTS = Object.freeze({
  Button: { component: ButtonView, purpose: 'Native action with shared sizes and visual variants.' },
  IconButton: { component: IconButtonView, base: 'Button', purpose: 'Named icon-only action.' },
  CloseButton: { component: CloseButtonView, base: 'IconButton', purpose: 'Owner-controlled close action.' },
  PanelHeader: { component: PanelHeaderView, purpose: 'Panel title and trailing controls.' },
  ModalDialog: { component: ModalDialogView, purpose: 'Native modal layer, focus return and dismissal.' },
  ToggleSwitch: { component: ToggleSwitchView, purpose: 'Native checkbox with switch semantics.' },
  NativeSelect: { component: NativeSelectView, purpose: 'Native picker and pointer-focus completion.' },
  ResizeHandle: { component: ResizeHandleView, purpose: 'Shared pointer and keyboard pane resizing.' },
  UiIcon: { component: IconView, purpose: 'Registered application glyphs.' },
} as const);

export type UiComponentName = keyof typeof UI_COMPONENTS;
export const Button = UI_COMPONENTS.Button.component;
export const IconButton = UI_COMPONENTS.IconButton.component;
export const CloseButton = UI_COMPONENTS.CloseButton.component;
export const PanelHeader = UI_COMPONENTS.PanelHeader.component;
export const ModalDialog = UI_COMPONENTS.ModalDialog.component;
export const ToggleSwitch = UI_COMPONENTS.ToggleSwitch.component;
export const NativeSelect = UI_COMPONENTS.NativeSelect.component;
export const ResizeHandle = UI_COMPONENTS.ResizeHandle.component;
export const UiIcon = UI_COMPONENTS.UiIcon.component;
export type { ButtonProps, ButtonVariant, ControlSize } from './Button';
export type { IconButtonProps } from './IconButton';
export type { CloseButtonProps } from './CloseButton';
export type { PanelHeaderProps } from './PanelHeader';
export type { UiIconName, UiIconProps } from '../icons/registry';
export { UI_REGION_SLOTS } from '../ui-plugins/slots';
