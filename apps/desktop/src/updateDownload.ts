import { Transform, type Readable, type TransformCallback } from "node:stream";
import { gunzipSync } from "node:zlib";
import type { IncomingMessage, ClientRequest } from "electron";
import { CancellationToken, type AppUpdater } from "electron-updater";
import { ElectronHttpExecutor } from "electron-updater/out/electronHttpExecutor";

// Hold a chunk's callback to apply backpressure through the existing download
// pipeline. Buffered bytes stay bounded; resuming keeps the same file and hash.
class DownloadGate extends Transform {
  private pending: { chunk: Buffer; callback: TransformCallback } | null = null;
  private bytes = 0;
  constructor(private readonly paused: () => boolean, private readonly received: (bytes: number) => void,
    private readonly expectedBytes?: number, private readonly maxBytes = Infinity) { super(); }
  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
    this.bytes += chunk.length;
    if (this.bytes > (this.expectedBytes ?? this.maxBytes)) { callback(new Error("Update response exceeds expected size")); return; }
    this.received(chunk.length);
    if (this.paused()) this.pending = { chunk, callback };
    else callback(null, chunk);
  }
  override _flush(callback: TransformCallback) {
    callback(this.expectedBytes !== undefined && this.bytes !== this.expectedBytes ? new Error("Truncated update range") : null);
  }
  continue() {
    const pending = this.pending;
    this.pending = null;
    pending?.callback(null, pending.chunk);
  }
  override _destroy(error: Error | null, callback: (error: Error | null) => void) {
    const pending = this.pending;
    this.pending = null;
    pending?.callback(error || new Error("cancelled"));
    callback(error);
  }
}

export class PausableUpdateHttpExecutor extends ElectronHttpExecutor {
  private paused = false;
  private downloading = false;
  private downloadToken?: CancellationToken;
  private received = 0;
  private readonly requests = new Set<ClientRequest>();
  private readonly activeRequests = new Set<ClientRequest>();
  private readonly blockmapRequests = new WeakSet<ClientRequest>();
  private readonly gates = new Set<DownloadGate>();
  private readonly metadataTokens = new Set<CancellationToken>();

  constructor(login: ConstructorParameters<typeof ElectronHttpExecutor>[0], private readonly metadataTimeoutMs = 15_000) {
    super(login);
  }

  // Electron net.request does not expose Node's socket timeout event used by
  // the upstream executor. Bound the entire feed request, including redirects
  // and response bodies, so a stalled feed cannot prevent fallback forever.
  override async request(...args: Parameters<ElectronHttpExecutor["request"]>) {
    const token = new CancellationToken(args[1]);
    this.metadataTokens.add(token);
    const timeout = setTimeout(() => token.cancel(), this.metadataTimeoutMs);
    try { return await super.request(args[0], token, args[2]); }
    finally { clearTimeout(timeout); this.metadataTokens.delete(token); token.dispose(); }
  }

  cancel() { for (const token of this.metadataTokens) token.cancel(); this.downloadToken?.cancel(); }

  // Monotonic across attempts: callers take a fresh baseline for each download.
  // Count payload chunks even without Content-Length/download-progress events.
  receivedBytes() { return this.received; }
  networkActive() { return this.activeRequests.size > 0; }

  pause() { this.paused = true; }
  resume() {
    this.paused = false;
    for (const gate of this.gates) gate.continue();
  }

  override async download(...args: Parameters<ElectronHttpExecutor["download"]>) {
    return this.runDownload(args[2].cancellationToken, () => super.download(...args));
  }

  override async downloadToBuffer(...args: Parameters<ElectronHttpExecutor["downloadToBuffer"]>) {
    const bytes = await super.downloadToBuffer(...args);
    if (args[0].pathname.endsWith('.blockmap')) {
      // Bound expansion before upstream's synchronous, unbounded gunzip/parse.
      const map = JSON.parse(gunzipSync(bytes, { maxOutputLength: 32 * 1024 * 1024 }).toString());
      const file = map.files?.[0];
      if (map.version !== '2' || map.files?.length !== 1 || file?.offset !== 0
        || !Array.isArray(file.sizes) || !Array.isArray(file.checksums) || !file.sizes.length
        || file.sizes.length !== file.checksums.length || !file.sizes.every((size: unknown) => Number.isSafeInteger(size) && Number(size) > 0)
        || !file.checksums.every((hash: unknown) => typeof hash === 'string' && hash.length > 0)
        || !Number.isSafeInteger(file.sizes.reduce((sum: number, size: number) => sum + size, 0))) {
        throw new Error('Invalid update blockmap');
      }
    }
    return bytes;
  }

  // Scope the *whole* updater operation, including blockmaps and direct Range
  // requests. Upstream differential downloads do not call executor.download().
  async runDownload<T>(token: CancellationToken, operation: () => Promise<T>): Promise<T> {
    if (token.cancelled) throw new Error("cancelled");
    if (this.downloading) {
      if (token !== this.downloadToken) throw new Error("Concurrent update download");
      return operation();
    }
    this.downloading = true;
    this.downloadToken = token;
    const abort = () => {
      for (const request of this.requests) request.abort();
      for (const gate of this.gates) gate.destroy(new Error("cancelled"));
    };
    token.on("cancel", abort);
    try { return await operation(); }
    finally {
      token.off("cancel", abort);
      this.downloading = false;
      this.downloadToken = undefined;
      this.paused = false;
      // Also close the transport after failures, before the updater removes its
      // temporary file. A cancelled request must never keep writing in the back.
      abort();
      this.requests.clear();
      this.activeRequests.clear();
      this.gates.clear();
    }
  }

  override createRequest(options: Parameters<ElectronHttpExecutor["createRequest"]>[0], callback: (response: IncomingMessage | DownloadGate) => void): ClientRequest {
    if (this.downloadToken?.cancelled) throw new Error("cancelled");
    const rangeHeader = options.headers?.range ?? options.headers?.Range;
    const range = typeof rangeHeader === 'string' ? /^bytes=(\d+)-(\d+)$/.exec(rangeHeader) : null;
    if (range) options = { ...options, headers: { ...options.headers, 'Accept-Encoding': 'identity' } };
    // Electron's response implements Readable, although its generated types
    // expose only EventEmitter methods.
    const request = super.createRequest(options, (response: IncomingMessage & Readable) => {
      const finish = () => { this.activeRequests.delete(request); this.requests.delete(request); };
      response.once('end', finish);
      response.once('error', finish);
      if (!this.downloading || (!range && response.statusCode >= 300)) { callback(response); return; }
      const expected = range ? Number(range[2]) - Number(range[1]) + 1 : undefined;
      const gate = new DownloadGate(() => this.paused, bytes => { this.received += bytes; }, expected,
        options.path?.split('?')[0].endsWith('.blockmap') ? 8 * 1024 * 1024 : Infinity);
      Object.assign(gate, { statusCode: response.statusCode, statusMessage: response.statusMessage, headers: response.headers });
      this.gates.add(gate);
      gate.once("close", () => this.gates.delete(gate));
      response.on("error", error => gate.destroy(error));
      response.on("aborted", () => gate.destroy(new Error("Update response aborted")));
      gate.once('error', () => request.abort());
      callback(gate);
      if (range) {
        const actual = /^bytes (\d+)-(\d+)\/(\d+)$/.exec(String(response.headers['content-range']));
        if (response.statusCode !== 206 || !actual || actual[1] !== range[1] || actual[2] !== range[2]
          || Number(actual[3]) <= Number(range[2]) || (response.headers['content-encoding'] && response.headers['content-encoding'] !== 'identity')) {
          gate.destroy(new Error("Server did not honor update Range"));
          return;
        }
      }
      response.pipe(gate);
    });
    if (this.downloading) {
      if (options.path?.split('?')[0].endsWith('.blockmap')) this.blockmapRequests.add(request);
      this.requests.add(request);
      this.activeRequests.add(request);
      request.once('abort', () => { this.activeRequests.delete(request); this.requests.delete(request); });
      request.once('error', () => { this.activeRequests.delete(request); this.requests.delete(request); });
      // ClientRequest is Writable: it may close once the request body is sent,
      // before its response has been consumed. Retain it until download settles
      // so cancelling a paused response still aborts the underlying connection.
    }
    return request;
  }

  override addErrorAndTimeoutHandlers(request: ClientRequest, reject: (error: Error) => void): void {
    super.addErrorAndTimeoutHandlers(request, reject);
    const token = this.downloadToken;
    if (!token) return;
    let lastActivity = Date.now();
    let previousTick = lastActivity, elapsed = 0;
    let response: IncomingMessage | undefined;
    const refresh = () => { lastActivity = Date.now(); };
    const stop = () => {
      clearInterval(timer);
      token.off('cancel', cancel);
      request.off('response', onResponse);
      request.off('abort', stop);
      request.off('error', stop);
      response?.off('data', refresh);
      response?.off('end', stop);
      response?.off('error', stop);
    };
    const fail = (error: Error) => { stop(); reject(error); request.abort(); };
    const cancel = () => fail(new Error('cancelled'));
    const onResponse = (incoming: IncomingMessage) => {
      response = incoming;
      refresh();
      incoming.on('data', refresh);
      incoming.once('end', stop);
      incoming.once('error', stop);
    };
    const timer = setInterval(() => {
      const now = Date.now();
      if (!this.paused) elapsed += now - previousTick;
      previousTick = now;
      if (this.paused) refresh();
      else if (now - lastActivity >= this.metadataTimeoutMs
        || (this.blockmapRequests.has(request) && elapsed >= this.metadataTimeoutMs)) fail(new Error('Update connection timed out'));
    }, Math.min(250, this.metadataTimeoutMs));
    token.once('cancel', cancel);
    request.once('response', onResponse);
    request.once('abort', stop);
    request.once('error', stop);
    if (token.cancelled) cancel();
  }
}

export function installUpdateDownloadControl(updater: AppUpdater) {
  const executor = new PausableUpdateHttpExecutor((auth, callback) => updater.emit("login", auth, callback));
  // electron-updater 6 uses this executor for both feed and payload requests.
  // Its declaration omits the field; keep this version-specific hook here and
  // exercise it with the real updater in the transport integration test.
  (updater as AppUpdater & { httpExecutor: ElectronHttpExecutor }).httpExecutor = executor;
  const download = updater.downloadUpdate.bind(updater);
  updater.downloadUpdate = (token = new CancellationToken()) => executor.runDownload(token, () => download(token));
  return executor;
}
