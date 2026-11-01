import { Worker } from 'node:worker_threads';

export class SearchWorkerClient {
  constructor(options) { this.options = options; this.requests = new Map(); this.sequence = 0; }
  start() {
    if (this.worker) return;
    const worker = new Worker(new URL('./searchWorker.js', import.meta.url), { workerData: this.options, execArgv: [] });
    this.worker = worker;
    worker.on('message', ({ id, event, result, error }) => {
      const request = this.requests.get(id);
      if (!request) return;
      if (event) { request.onUpdate?.(event); return; }
      this.requests.delete(id); request.cleanup();
      if (error) request.reject(Object.assign(new Error(error.message), { status: error.status }));
      else request.resolve(result);
      if (!this.requests.size) worker.unref();
    });
    const failed = error => {
      if (this.worker === worker) this.worker = null;
      for (const request of this.requests.values()) { request.cleanup(); request.reject(error); }
      this.requests.clear();
    };
    worker.on('error', failed);
    worker.on('exit', code => { if (this.worker === worker) failed(new Error('Search worker exited (' + code + ')')); });
    worker.unref();
  }
  call(method, input, { signal, onUpdate } = {}) {
    signal?.throwIfAborted(); this.start();
    const id = ++this.sequence;
    return new Promise((resolve, reject) => {
      const abort = () => {
        this.worker?.postMessage({ id, method: 'cancel' }); this.requests.delete(id);
        signal.removeEventListener('abort', abort);
        reject(signal.reason || new DOMException('Aborted', 'AbortError'));
        if (!this.requests.size) this.worker?.unref();
      };
      const cleanup = () => signal?.removeEventListener('abort', abort);
      this.requests.set(id, { resolve, reject, onUpdate, cleanup });
      signal?.addEventListener('abort', abort, { once: true });
      this.worker.ref(); this.worker.postMessage({ id, method, input });
    });
  }
  async close() {
    if (!this.worker) return;
    const worker = this.worker;
    try { await this.call('close'); } finally { this.worker = null; await worker.terminate(); }
  }
}
