import { Button } from './Button';
import { IconButton } from './IconButton';
import { CloseButton } from './CloseButton';
import { PanelHeader } from './PanelHeader';
import { DisclosureSummary } from './DisclosureSummary';
import ModalDialog from './ModalDialog';
import ToggleSwitch from './ToggleSwitch';
import NativeSelect from './NativeSelect';
import ResizeHandle from './ResizeHandle';
import UiIcon from '../icons/registry';

/** Static implementation catalog, not another plugin runtime or state store.
 * Register once here; consumers import the named exports below. Component identities
 * remain unchanged, so registration never adds wrappers or resets mounted state.
 */
export const UI_COMPONENTS = Object.freeze({
  Button: { family: 'action', component: Button, purpose: 'Native action with shared sizes and visual variants.' },
  IconButton: { family: 'action', component: IconButton, base: 'Button', purpose: 'Named icon-only action.' },
  CloseButton: { family: 'action', component: CloseButton, base: 'IconButton', purpose: 'Owner-controlled close action.' },
  PanelHeader: { family: 'layout', component: PanelHeader, purpose: 'Panel title and trailing controls.' },
  DisclosureSummary: { family: 'disclosure', component: DisclosureSummary, purpose: 'Native content disclosure with a shared chevron; details owns expansion.' },
  ModalDialog: { family: 'dialog', component: ModalDialog, purpose: 'Native modal layer, focus return and dismissal.' },
  ToggleSwitch: { family: 'input', component: ToggleSwitch, purpose: 'Native checkbox with switch semantics.' },
  NativeSelect: { family: 'input', component: NativeSelect, purpose: 'Native picker and pointer-focus completion.' },
  ResizeHandle: { family: 'layout', component: ResizeHandle, purpose: 'Shared pointer and keyboard pane resizing.' },
  UiIcon: { family: 'icon', component: UiIcon, purpose: 'Registered application glyphs.' },
} as const);

export type UiComponentName = keyof typeof UI_COMPONENTS;
export { Button, IconButton, CloseButton, PanelHeader, DisclosureSummary, ModalDialog, ToggleSwitch, NativeSelect, ResizeHandle, UiIcon };
export type { ButtonProps, ButtonVariant, ControlSize } from './Button';
export type { IconButtonProps } from './IconButton';
export type { CloseButtonProps } from './CloseButton';
export type { PanelHeaderProps } from './PanelHeader';
export type { DisclosureSummaryProps } from './DisclosureSummary';
export type { UiIconName, UiIconProps } from '../icons/registry';
export { UI_ICON_NAMES, UI_ICON_ROLES } from '../icons/registry';
export { UI_REGION_SLOTS } from '../ui-plugins/slots';
