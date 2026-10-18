import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  root: fileURLToPath(new URL('../..', import.meta.url)),
  base: './', plugins: [react()],
  build: { outDir: '../../.task-artifacts/manual-preview', emptyOutDir: true,
    rollupOptions: { input: {
      typography: fileURLToPath(new URL('./typography.html', import.meta.url)),
      reader: fileURLToPath(new URL('./reader.html', import.meta.url)),
      approvalModel: fileURLToPath(new URL('./approval-model.html', import.meta.url)),
      composer: fileURLToPath(new URL('./composer.html', import.meta.url)),
      imageReview: fileURLToPath(new URL('./image-review.html', import.meta.url)),
      followModel: fileURLToPath(new URL('./follow-model.html', import.meta.url)),
      usageWidget: fileURLToPath(new URL('./usage-widget.html', import.meta.url)),
      viewport: fileURLToPath(new URL('./viewport.html', import.meta.url)),
      messages: fileURLToPath(new URL('./messages.html', import.meta.url)),
    } } },
});
