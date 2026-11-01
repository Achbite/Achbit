/// <reference types="vite/client" />
interface Window {
  __ACHBIT_DEBUG_UI__?: ReturnType<typeof import('./src/debug/registry').createDebugUiRegistry> & {
    identity(element: Element | null): unknown;
    setOverlay(enabled: boolean): unknown;
    overlayStatus(): unknown;
  };
}
declare module 'virtual:achbit-ui-sources' {
  const sources: import('./src/debug/ownership').UiSourceMap;
  export default sources;
}
