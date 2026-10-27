import React from 'react';

interface AchbitNavigationBoxProps {
  settingsOpen: boolean;
  settingsTargetRef: React.Ref<HTMLDivElement>;
  collapsed: boolean;
  toolbar: React.ReactNode;
  resizeHandle: React.ReactNode;
  children: React.ReactNode;
}

/** Keep navigation controls available when the navigation content is collapsed. */
export default function AchbitNavigationBox({
  settingsOpen, settingsTargetRef, collapsed, toolbar, resizeHandle, children,
}: AchbitNavigationBoxProps) {
  return (
    <aside className="achbit-gui-navigation-box">
      <div className="achbit-gui-navigation-box__titlebar" data-tauri-drag-region="deep">
        <div className="achbit-gui-navigation-controls">{toolbar}</div>
      </div>
      <div id="achbit-navigation-content" className="achbit-gui-navigation-body" hidden={collapsed} inert={collapsed}>
        <div className="achbit-gui-navigation-box__content" hidden={settingsOpen} inert={settingsOpen}>
          {children}
        </div>
        <div className="achbit-gui-navigation-box__content" hidden={!settingsOpen} ref={settingsTargetRef} />
      </div>
      {!collapsed && resizeHandle}
    </aside>
  );
}
