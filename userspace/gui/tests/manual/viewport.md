# Scroll handoff at tool-output boundaries

Build the manual fixture with `vite.config.ts` and open `viewport.html`. It uses the real `ToolActivityGroup`, `useConversationViewport`, and Composer without a daemon or Provider.

1. Expand long command output. Keep the pointer inside it and scroll down. The outer position should remain unchanged until the output reaches its bottom; continued scrolling should then move the outer conversation.
2. Reverse direction. Scroll the output first, then hand off to the outer conversation at the top. The counters display outer position and current/maximum output position.
3. Scroll up to read, then click the append-body control. The reading position should stay fixed. Return to the conversation end and append again; following should resume.
4. Expand and collapse commands and tool groups. Their headings should retain the current reading position. Reduce the viewport and repeat in both directions.

`nested-scroll.test.mjs` checks following state during handoff. Verify native browser boundary scrolling by interacting with this fixture; synthetic wheel events do not replace that check.
