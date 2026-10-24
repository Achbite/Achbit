import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { pdfDocumentAssets } from './vite.pdf';
import { rename } from 'node:fs/promises';
import { resolve } from 'node:path';

function achbitGuiDevelopmentEntry(): Plugin {
  return {
    name: 'achbit-gui-development-entry',
    configureServer(server) {
      server.middlewares.use((request, _response, next) => {
        const [pathname, query] = (request.url ?? '/').split('?', 2);
        if (pathname === '/' || pathname === '/index.html') {
          request.url = `/achbit-gui.html${query ? `?${query}` : ''}`;
        }
        next();
      });
    },
  };
}

export default defineConfig(({ command }) => {
  const debug = process.env.DEEPCODE_BUILD_KIND === 'debug';
  const host = process.env.DEEPCODE_HOST ?? '127.0.0.1';
  const hostPort = process.env.DEEPCODE_HOST_PORT ?? '31245';
  const devPort = Number(process.env.DEEPCODE_GUI_DEV_PORT ?? '5174');
  const uiToken = process.env.DEEPCODE_HOST_UI_TOKEN ?? '';
  if (command === 'serve') {
    if (!['127.0.0.1', 'localhost', '::1'].includes(host)) {
      throw new Error('Achbit Web development Host must be loopback.');
    }
    if (!Number.isSafeInteger(devPort) || devPort < 1 || devPort > 65_535) {
      throw new Error('DEEPCODE_GUI_DEV_PORT must be an integer from 1 to 65535.');
    }
    if (!/^dcui_[0-9a-f]{64}$/.test(uiToken)) {
      throw new Error('DEEPCODE_HOST_UI_TOKEN is required for Web development mode.');
    }
  }
  const target = `http://${host}:${hostPort}`;
  const proxyOptions = {
    target,
    changeOrigin: true,
    configure(proxy: { on: (event: string, listener: (request: { setHeader: (name: string, value: string) => void }) => void) => void }) {
      proxy.on('proxyReq', (request) => {
        request.setHeader('origin', target);
        request.setHeader('x-deepcode-host-ui-token', uiToken);
      });
    },
  };
  return {
    plugins: [achbitGuiDevelopmentEntry(), react(), pdfDocumentAssets(), {
      name: 'deepcode-build-kind',
      transformIndexHtml: {
        order: 'pre',
        handler: () => debug ? [{ tag: 'script', attrs: { type: 'module', src: '/src/debug/install.ts' }, injectTo: 'head' }] : [],
      },
      async writeBundle(options) {
        if (!options.dir) throw new Error('GUI output directory is required.');
        await rename(resolve(options.dir, 'achbit-gui.html'), resolve(options.dir, 'index.html'));
      },
    }],
    define: { __DEEPCODE_DEBUG__: JSON.stringify(debug) },
    base: './',
    build: {
      outDir: debug ? '../../.build-cache/gui-debug' : 'dist-achbit-gui',
      emptyOutDir: true,
      chunkSizeWarningLimit: 650,
      rollupOptions: {
        input: {
          index: 'achbit-gui.html',
        },
        output: {
          manualChunks(id: string) {
            if (id.endsWith('/pdfjs-dist/legacy/build/pdf.mjs')) return 'pdf-core';
            if (id.endsWith('/pdfjs-dist/legacy/web/pdf_viewer.mjs')) return 'pdf-viewer';
            if (
              id.includes('react-markdown') ||
              id.includes('remark-') ||
              id.includes('rehype-') ||
              id.includes('katex')
            ) {
              return 'markdown-renderer';
            }
            if (id.includes('react') || id.includes('react-dom') || id.includes('zustand')) {
              return 'vendor';
            }
            return undefined;
          },
        },
      },
    },
    server: {
      host: process.env.DEEPCODE_GUI_BIND_HOST ?? '127.0.0.1',
      port: devPort,
      strictPort: true,
      // macOS container mounts do not reliably forward filesystem watch events.
      watch: { usePolling: true, interval: 300 },
      proxy: {
        '/api': proxyOptions,
        '/ws': { ...proxyOptions, ws: true },
      },
    },
  };
});
