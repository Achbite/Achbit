import type { ChangeComputation } from './fileChangeSummary';
import { calculateChangedLines, calculateChangedRanges, calculateChangePreview } from './fileChangeLineCounts';

self.onmessage = ({ data }: MessageEvent<{ before: string | null; after: string | null; operation: ChangeComputation }>) => {
  try {
    const { before, after, operation } = data;
    const result = operation === 'ranges' ? calculateChangedRanges(before ?? '', after ?? '')
      : operation === 'preview' ? calculateChangePreview(before, after) : calculateChangedLines(before, after);
    self.postMessage({ result });
  } catch (error: unknown) {
    self.postMessage({ error: error instanceof Error ? error.message : String(error) });
  }
};
