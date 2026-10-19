import type { KeyboardEvent } from 'react';

/** Submit through the form owner; Shift+Enter and IME confirmation retain native editing. */
export function submitReplyOnEnter(event: KeyboardEvent<HTMLTextAreaElement>): void {
  if (event.key !== 'Enter' || event.shiftKey || event.altKey || event.ctrlKey || event.metaKey
    || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
  event.preventDefault();
  if (event.repeat || event.currentTarget.disabled) return;
  event.currentTarget.form?.requestSubmit();
}
