import { markdownGrammar, displayMathFences, formatDecisionProse } from './markdownGrammar';

self.onmessage = ({ data }: MessageEvent<{ text: string; decisionProse: boolean }>) => {
  try {
    const text = data.decisionProse ? formatDecisionProse(data.text) : data.text;
    self.postMessage({ root: markdownGrammar.parse(displayMathFences(text)) });
  } catch (reason) {
    self.postMessage({ error: reason instanceof Error ? reason.message : String(reason) });
  }
};
