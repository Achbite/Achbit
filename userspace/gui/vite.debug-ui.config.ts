import { defineConfig } from 'vite';
import { resolve } from 'node:path';
import { collectUiSources } from './ui-ownership-sources.mjs';

export default defineConfig({
  publicDir: false,
  plugins: [{
    name: 'achbit-ui-ownership-sources',
    resolveId(id) { return id === 'virtual:achbit-ui-sources' ? '\0achbit-ui-sources' : undefined; },
    async load(id) {
      if (id !== '\0achbit-ui-sources') return;
      return `export default ${JSON.stringify(await collectUiSources(resolve('src'), resolve('../..')))};`;
    },
  }],
  build: {
    outDir: '../../.build-cache/gui-diagnostics', emptyOutDir: true,
    lib: { entry: resolve('src/debug/install.ts'), name: 'AchbitUiDiagnostics', formats: ['iife'], fileName: () => 'ui.js' },
  },
});
