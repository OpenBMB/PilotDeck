import { Transform, type Readable, type TransformCallback } from "node:stream";
import type { IncomingMessage, ClientRequest } from "electron";
import { CancellationToken, type AppUpdater } from "electron-updater";
import { ElectronHttpExecutor } from "electron-updater/out/electronHttpExecutor";

// Hold a chunk's callback to apply backpressure through the existing download
// pipeline. Buffered bytes stay bounded; resuming keeps the same file and hash.
class DownloadGate extends Transform {
  private pending: { chunk: Buffer; callback: TransformCallback } | null = null;
  constructor(private readonly paused: () => boolean, private readonly received: (bytes: number) => void) { super(); }
  override _transform(chunk: Buffer, _encoding: BufferEncoding, callback: TransformCallback) {
    this.received(chunk.length);
    if (this.paused()) this.pending = { chunk, callback };
    else callback(null, chunk);
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
  private received = 0;
  private readonly requests = new Set<ClientRequest>();
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

  cancel() { for (const token of this.metadataTokens) token.cancel(); }

  // Monotonic across attempts: callers take a fresh baseline for each download.
  // Count payload chunks even without Content-Length/download-progress events.
  receivedBytes() { return this.received; }

  pause() { this.paused = true; }
  resume() {
    this.paused = false;
    for (const gate of this.gates) gate.continue();
  }

  override async download(...args: Parameters<ElectronHttpExecutor["download"]>) {
    this.downloading = true;
    const token = args[2].cancellationToken;
    const abort = () => {
      for (const request of this.requests) request.abort();
      for (const gate of this.gates) gate.destroy(new Error("cancelled"));
    };
    token.on("cancel", abort);
    try { return await super.download(...args); }
    finally {
      token.off("cancel", abort);
      this.downloading = false;
      this.paused = false;
      // Also close the transport after failures, before the updater removes its
      // temporary file. A cancelled request must never keep writing in the back.
      abort();
      this.requests.clear();
      this.gates.clear();
    }
  }

  override createRequest(options: Parameters<ElectronHttpExecutor["createRequest"]>[0], callback: (response: IncomingMessage | DownloadGate) => void): ClientRequest {
    // Electron's response implements Readable, although its generated types
    // expose only EventEmitter methods.
    const request = super.createRequest(options, (response: IncomingMessage & Readable) => {
      if (!this.downloading || response.statusCode >= 300) { callback(response); return; }
      const gate = new DownloadGate(() => this.paused, bytes => { this.received += bytes; });
      Object.assign(gate, { statusCode: response.statusCode, statusMessage: response.statusMessage, headers: response.headers });
      this.gates.add(gate);
      gate.once("close", () => this.gates.delete(gate));
      response.on("error", error => gate.destroy(error));
      callback(gate);
      response.pipe(gate);
    });
    if (this.downloading) {
      this.requests.add(request);
      // ClientRequest is Writable: it may close once the request body is sent,
      // before its response has been consumed. Retain it until download settles
      // so cancelling a paused response still aborts the underlying connection.
    }
    return request;
  }
}

export function installUpdateDownloadControl(updater: AppUpdater) {
  const executor = new PausableUpdateHttpExecutor((auth, callback) => updater.emit("login", auth, callback));
  // electron-updater 6 uses this executor for both feed and payload requests.
  // Its declaration omits the field; keep this version-specific hook here and
  // exercise it with the real updater in the transport integration test.
  (updater as AppUpdater & { httpExecutor: ElectronHttpExecutor }).httpExecutor = executor;
  return executor;
}
