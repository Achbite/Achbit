
/** Built-in UI glyphs: one grid, optical weight and currentColor across every surface.
 * Change glyphs or semantic role mappings here; consumers never define SVG paths.
 * These are application vectors, not a dependency on platform SF Symbols fonts.
 */
export const UI_ICON_GLYPHS = {
  sidebar: <><rect x="3" y="4" width="18" height="16" rx="3"/><path d="M15 4v16"/></>,
  expand: <><path d="M14 4h6v6M20 4l-7 7M4 14v6h6M4 20l7-7"/></>,
  collapse: <><path d="M20 4l-7 7m0-6v6h6M4 20l7-7m-6 0h6v6"/></>,
  refresh: <><path d="M20 7v5h-5M19 12a7 7 0 1 0-1.5 5M20 12a8 8 0 0 0-2-6"/></>,
  code: <><path d="m8 7-5 5 5 5m8-10 5 5-5 5m-3-13-2 16"/></>,
  download: <><path d="M12 3v12m-5-5 5 5 5-5M4 16v4h16v-4"/></>,
  info: <><circle cx="12" cy="12" r="9"/><path d="M12 11v6"/><circle cx="12" cy="7" r="1" fill="currentColor" stroke="none"/></>,
  close: <><path d="m6 6 12 12M18 6 6 18" /></>,
  terminal: <><rect x="3" y="4" width="18" height="16" rx="3" /><path d="m7 9 3 3-3 3M13 15h4" /></>,
  compose: <><path d="M4 20h4l11-11-4-4L4 16v4Z" /><path d="m13.5 6.5 4 4" /></>,
  folder: <><path d="M3 7.5h7l2-2h9v13H3v-11Z" /></>,
  browser: <><circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/></>,
  paperclip: <><path d="m8.4 12.8 6.9-6.9a3.25 3.25 0 0 1 4.6 4.6l-8.6 8.6a5 5 0 0 1-7.1-7.1l8.2-8.2" /><path d="m7.1 14.1 8.2-8.2" /></>,
  plus: <><path d="M12 5v14" /><path d="M5 12h14" /></>,
  more: <><circle cx="5" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1" fill="currentColor" stroke="none" /></>,
  chevronRight: <><path d="m9 6 6 6-6 6" /></>,
  chevronDown: <><path d="m6 9 6 6 6-6" /></>,
  settings: <><circle cx="12" cy="12" r="3.2" />
          <path d="M19.4 13.5a7.8 7.8 0 0 0 0-3l2-1.2-2-3.4-2.2 1a8.6 8.6 0 0 0-2.6-1.5L14.3 3h-4.6l-.4 2.4a8.6 8.6 0 0 0-2.6 1.5l-2.2-1-2 3.4 2 1.2a7.8 7.8 0 0 0 0 3l-2 1.2 2 3.4 2.2-1a8.6 8.6 0 0 0 2.6 1.5l.4 2.4h4.6l.4-2.4a8.6 8.6 0 0 0 2.6-1.5l2.2 1 2-3.4-2.1-1.2Z" /></>,
  activity: <><path d="M4 12h3l2-6 4 12 2-6h5" /></>,
  tool: <><path d="M14.5 6.5a4 4 0 0 0-5 5L4 17l3 3 5.5-5.5a4 4 0 0 0 5-5l-2.2 2.2-3-3 2.2-2.2Z" /></>,
  search: <><circle cx="11" cy="11" r="6.5" /><path d="m16 16 4 4" /></>,
  extension: <><path d="M8 4h4v4h4v4h4v4h-4v4h-4v-4H8v-4H4V8h4V4Z" /><path d="M8 8h8v8H8Z" /></>,
  artifact: <><path d="M6 3h9l3 3v15H6V3Z" /><path d="M15 3v4h4" /><path d="M9 12h6M9 16h6" /></>,
  session: <><path d="M5 5h14v11H9l-4 3V5Z" /></>,
  question: <><path d="M7 19 3 21l1-5a9 9 0 1 1 3 3Z"/><path d="M9.5 8a2.5 2.5 0 1 1 4 2c-1 .7-1.5 1-1.5 2M12 16h.01"/></>,
  copy: <><rect x="8" y="8" width="11" height="11" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></>,
  thumbUp: <><path d="M7 10v10H4V10h3Z" /><path d="M7 19h9.2a2 2 0 0 0 1.9-1.4l1.7-5.4A2 2 0 0 0 17.9 9H14l.6-2.8A2.5 2.5 0 0 0 12.2 3L7 10v9Z" /></>,
  thumbDown: <><path d="M7 14V4H4v10h3Z" /><path d="M7 5h9.2a2 2 0 0 1 1.9 1.4l1.7 5.4a2 2 0 0 1-1.9 2.6H14l.6 2.8a2.5 2.5 0 0 1-2.4 3.2L7 14V5Z" /></>,
  stop: <><rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor" stroke="none" /></>,
  arrowUp: <><path d="m7 11 5-5 5 5" /><path d="M12 6v12" /></>,
  appearance: <><circle cx="12" cy="12" r="4" /><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5" /></>,
  agent: <><path d="M10 3c1 5 2 6 7 7-5 1-6 2-7 7-1-5-2-6-7-7 5-1 6-2 7-7Z" /><path d="M19 14v7m-3.5-3.5h7" /></>,
  subagents: <><circle cx="12" cy="5" r="2.5" /><circle cx="5" cy="18" r="2.5" /><circle cx="19" cy="18" r="2.5" /><path d="M12 7.5V12M5 15.5V12h14v3.5" /></>,
  shield: <><path d="M12 3 4 6v6c0 4 4 7 8 9 4-2 8-5 8-9V6Z" /><path d="m8 12 3 3 5-6" /></>,
  hand: <><path d="M8 12V5a1.5 1.5 0 0 1 3 0v6-7a1.5 1.5 0 0 1 3 0v7-5a1.5 1.5 0 0 1 3 0v6-3a1.5 1.5 0 0 1 3 0v7a7 7 0 0 1-7 7h-1a6 6 0 0 1-5-3L3.5 13a1.7 1.7 0 0 1 2.7-2L8 13" /></>,
  server: <><rect x="3" y="3" width="18" height="7" rx="2" /><rect x="3" y="14" width="18" height="7" rx="2" /><path d="M7 6.5h.01M7 17.5h.01M11 6.5h6M11 17.5h6" /></>,
  git: <><circle cx="6" cy="5" r="2" /><circle cx="6" cy="19" r="2" /><circle cx="18" cy="19" r="2" /><path d="M6 7v10M8 5c7 0 10 5 10 12" /></>,
  account: <><circle cx="12" cy="8" r="3.5" /><path d="M5 21v-1a7 7 0 0 1 14 0v1" /></>,
  check: <><path d="m5 12 4 4L19 6" /></>,
  pause: <><circle cx="12" cy="12" r="9" /><path d="M9 8v8m6-8v8" /></>,
  warning: <><circle cx="12" cy="12" r="9" /><path d="M12 7v6M12 17h.01" /></>,
  dot: <><circle cx="12" cy="12" r="3.5" fill="currentColor" stroke="none" /></>,
  spinner: <><path d="M21 12a9 9 0 1 1-9-9" /></>,
  file: <><path d="M14 3H6v18h12V7l-4-4ZM14 3v5h4" /></>,
  folderOpen: <><path d="M3 19V5h6l2 2h10v3M3 19l3-9h16l-3 9H3Z" /></>,
  newFile: <><path d="M10 21H5V3h9l4 4v4M14 3v5h4M17 14v8m-4-4h8" /></>,
  newFolder: <><path d="M10 20H3V5h6l2 2h10v5M17 14v8m-4-4h8" /></>,
  minus: <><path d="M5 12h14" /></>,
  maximize: <><rect x="5" y="5" width="14" height="14" rx="1" /></>,
  chevronLeft: <><path d="m15 6-6 6 6 6" /></>,
} as const;

export type UiIconName = keyof typeof UI_ICON_GLYPHS;
export const UI_ICON_ROLES = {
  settings: {
    workspace: 'folder', general: 'settings', appearance: 'appearance',
    agent: 'agent', environment: 'terminal', permissions: 'shield',
    models: 'server', plugins: 'extension', about: 'info',
  },
  activity: { explorer: 'folder', git: 'git', search: 'search', settings: 'settings', account: 'account' },
} as const satisfies Record<string, Record<string, UiIconName>>;

export interface UiIconProps {
  name: UiIconName;
  className?: string;
  size?: number;
  title?: string;
}

export default function UiIcon({ name, className, size = 18, title }: UiIconProps) {
  return <svg className={className} data-ui-icon={name} viewBox="0 0 24 24"
    width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8"
    strokeLinecap="round" strokeLinejoin="round" focusable="false"
    aria-hidden={title ? undefined : true} role={title ? 'img' : undefined} aria-label={title}>
    {title && <title>{title}</title>}
    {UI_ICON_GLYPHS[name]}
  </svg>;
}
