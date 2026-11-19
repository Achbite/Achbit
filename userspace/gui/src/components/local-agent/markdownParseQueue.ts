import type { Root } from 'mdast';

interface ParseJob {
  text: string;
  decisionProse: boolean;
  resolve(value: Root): void;
  reject(reason: unknown): void;
  dispose(): void;
}

interface ActiveParse { job: ParseJob; worker?: Worker }

const queue: ParseJob[] = [];
let running: ActiveParse | undefined;

function startNext(): void {
  if (running) return;
  const job = queue.shift();
  if (!job) return;
  const turn: ActiveParse = { job };
  running = turn;
  const finish = () => {
    if (running !== turn) return;
    turn.worker?.terminate();
    job.dispose();
    running = undefined;
    startNext();
  };
  const failed = (error: unknown) => { job.reject(error); finish(); };
  // Short conversations never download the background parser.
  void import('./markdownParser.worker?worker&inline').then(({ default: MarkdownWorker }) => {
    if (running !== turn) return;
    const worker = new MarkdownWorker();
    turn.worker = worker;
    worker.onmessage = ({ data }: MessageEvent<{ root: Root } | { error: string }>) => {
      if ('error' in data) job.reject(new Error(data.error));
      else job.resolve(data.root);
      finish();
    };
    worker.onerror = event => failed(new Error(event.message || 'markdown_worker_failed'));
    worker.onmessageerror = () => failed(new Error('markdown_worker_message_invalid'));
    worker.postMessage({ text: job.text, decisionProse: job.decisionProse });
  }).catch(failed);
}

/** Only the active parse owns a worker. Removing a view cancels its queued or running job. */
export function parseMarkdownDocument(text: string, decisionProse: boolean, signal: AbortSignal): Promise<Root> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const job = { text, decisionProse, resolve, reject, dispose: () => signal.removeEventListener('abort', abort) };
    const abort = () => {
      if (running?.job === job) {
        running.worker?.terminate();
        running = undefined;
      } else {
        const index = queue.indexOf(job);
        if (index >= 0) queue.splice(index, 1);
      }
      job.dispose();
      reject(signal.reason);
      startNext();
    };
    signal.addEventListener('abort', abort, { once: true });
    queue.push(job);
    startNext();
  });
}
