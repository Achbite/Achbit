/// <reference types="vite/client" />
declare const __DEEPCODE_DEBUG__: boolean;
interface Window {
  __DEEPCODE_DEBUG_UI__?: {
    register(id: string, source: { slot: string; pluginId: string | null; read(): unknown; actions(): Record<string, (...args: never[]) => unknown> }): () => void;
    measure(componentId: string, event: string, startedAt: number, outcome: 'completed' | 'failed'): void;
    list(): unknown;
    call(id: string, action: string, args: unknown[]): Promise<unknown>;
    measurements(): unknown;
  };
}
