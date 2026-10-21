import { calculateChangedLines, calculateChangePreview } from './fileChangeLineCounts';

self.onmessage = ({ data }: MessageEvent<{ before: string | null; after: string | null; preview?: boolean }>) => {
  try {
    self.postMessage({ result: data.preview ? calculateChangePreview(data.before, data.after) : calculateChangedLines(data.before, data.after) });
  } catch (error: unknown) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
