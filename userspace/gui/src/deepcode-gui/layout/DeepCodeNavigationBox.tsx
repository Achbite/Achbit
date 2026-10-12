import React from 'react';

interface DeepCodeNavigationBoxProps {
  settingsOpen: boolean;
  settingsTargetRef: React.Ref<HTMLDivElement>;
  collapsed: boolean;
  toolbar: React.ReactNode;
  resizeHandle: React.ReactNode;
  children: React.ReactNode;
}

/** Keep navigation controls available when the navigation content is collapsed. */
export default function DeepCodeNavigationBox({
  settingsOpen, settingsTargetRef, collapsed, toolbar, resizeHandle, children,
}: DeepCodeNavigationBoxProps) {
  return (
    <aside className="deepcode-gui-navigation-box">
      <div className="deepcode-gui-navigation-box__titlebar" data-tauri-drag-region="deep">
        <div className="deepcode-gui-navigation-controls">{toolbar}</div>
      </div>
      <div id="deepcode-navigation-content" className="deepcode-gui-navigation-body" hidden={collapsed} inert={collapsed}>
        <div className="deepcode-gui-navigation-box__content" hidden={settingsOpen} inert={settingsOpen}>
          {children}
        </div>
        <div className="deepcode-gui-navigation-box__content" hidden={!settingsOpen} ref={settingsTargetRef} />
      </div>
      {!collapsed && resizeHandle}
    </aside>
  );
}
