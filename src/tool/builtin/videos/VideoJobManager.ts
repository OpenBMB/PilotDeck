import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { PilotDeckToolRuntimeContext } from "../../protocol/types.js";
import { videoApiBaseUrl, type VideoGenerationConfig } from "../../../pilot/config/videoGenerationConfig.js";
import { VideoStore, type GeneratedVideo, type VideoPurpose } from "./VideoStore.js";
import { videoClient, VideoApiError, VIDEO_TIMEOUT_MS, type VideoRequest } from "./openaiVideos.js";
import { outputPath, publish } from "./videoExport.js";

export type VideoJobState = "tracking" | "reconnecting" | "downloading" | "paused" | "completed" | "failed" | "cancelled";
export type VideoJob = {
  id: string; sessionId: string; toolCallId: string; turnId: string; remoteId: string;
  baseUrl: string; model?: string; purpose: VideoPurpose; state: VideoJobState;
  createdAt: number; updatedAt: number; reason?: "network" | "configuration" | "timeout" | "provider";
  video?: GeneratedVideo; exportError?: boolean; outputPath?: string;
  /** Trusted child display scope of a completed task carried by a fork. */
  forkSubagentId?: string;
  context: Pick<PilotDeckToolRuntimeContext, "cwd" | "permissionMode" | "permissionContext" | "messageId">;
};
export const unfinishedVideoJob = (job: VideoJob) => ["tracking", "reconnecting", "downloading"].includes(job.state);
export function videoJobView(job: VideoJob) {
  return { id: job.id, sessionId: job.sessionId, toolCallId: job.toolCallId, purpose: job.purpose,
    state: job.state, reason: job.reason, ...(job.video ? { video: job.video } : {}), exportError: job.exportError };
}
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const uuid = /^[0-9a-f-]{36}$/;
const active = new Map<string, Promise<void>>();
const contexts = new Map<string, PilotDeckToolRuntimeContext>();
type Options = { store: VideoStore; getConfig: () => VideoGenerationConfig | undefined; fetchImpl?: typeof fetch;
  pollMs?: number; retryMs?: number; timeoutMs?: number; requestTimeoutMs?: number; env?: NodeJS.ProcessEnv };

/** The ledger never stores credentials or generation prompts. Only POST submits a
 * job; every recovery operation uses the saved remote ID with GET requests. */
export class VideoJobManager {
  readonly root: string;
  constructor(readonly options: Options) { this.root = join(options.store.root, "jobs"); }
  private directory(sessionId: string) { return join(this.root, hash(sessionId)); }
  private file(sessionId: string, id: string) {
    if (!uuid.test(id)) throw new Error("Invalid video task ID.");
    return join(this.directory(sessionId), id + ".json");
  }
  private async write(job: VideoJob) {
    const file = this.file(job.sessionId, job.id);
    await mkdir(this.directory(job.sessionId), { recursive: true, mode: 0o700 });
    const temporary = file + "." + randomUUID() + ".tmp";
    try { await writeFile(temporary, JSON.stringify({ ...job, updatedAt: Date.now() }), { mode: 0o600, flag: "wx" }); await rename(temporary, file); }
    finally { await unlink(temporary).catch(() => {}); }
  }
  async get(sessionId: string, id: string): Promise<VideoJob> {
    const job = JSON.parse(await readFile(this.file(sessionId, id), "utf8")) as VideoJob;
    if (job.sessionId !== sessionId || job.id !== id) throw new Error("Video task does not belong to this session.");
    return job;
  }
  async list(sessionId: string): Promise<VideoJob[]> {
    let files: string[];
    try { files = await readdir(this.directory(sessionId)); } catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") return []; throw e; }
    return (await Promise.all(files.filter(f => uuid.test(f.slice(0, -5)) && f.endsWith(".json"))
      .map(f => this.get(sessionId, f.slice(0, -5)).catch(() => undefined)))).filter((j): j is VideoJob => Boolean(j));
  }
  async forCall(sessionId: string, toolCallId: string, turnId?: string) {
    const matches = (job: VideoJob) => job.toolCallId === toolCallId && (!turnId || job.turnId === turnId);
    // Forked child ledgers share the root directory, but retain a distinct scope.
    const direct = (await this.list(sessionId)).filter(job => !job.forkSubagentId && matches(job)).sort((a, b) => b.createdAt - a.createdAt)[0];
    if (direct) return direct;
    // Child detail frames use the parent's display scope; resolve it only
    // through a relationship registered by the runtime, never by global ID.
    const split = sessionId.lastIndexOf("::sub::");
    if (split < 0) return;
    const parent = sessionId.slice(0, split), suffix = sessionId.slice(split);
    const carried = (await this.list(parent)).filter(job => job.forkSubagentId === suffix.slice(7) && matches(job));
    if (carried.length === 1) return carried[0];
    for (const name of await readdir(join(this.root, "parents")).catch(() => [])) {
      const relation = JSON.parse(await readFile(join(this.root, "parents", name), "utf8"));
      if (relation.parent === parent && relation.child.endsWith(suffix)) {
        return (await this.list(relation.child)).find(job => !job.forkSubagentId && matches(job));
      }
    }
  }
  async contextForSession(sessionId: string) {
    const jobs = (await this.list(sessionId)).sort((a, b) => b.createdAt - a.createdAt).slice(0, 10);
    const inherited = (await this.options.store.list(sessionId).catch(() => []))
      .filter(video => !jobs.some(job => job.video?.videoId === video.videoId)).slice(0, 10);
    if (!jobs.length && !inherited.length) return;
    const summaries = jobs.map(job => ({ tool_call_id: job.toolCallId, state: job.state, purpose: job.purpose,
      ...(job.video ? { video_id: job.video.videoId, attachment_path: job.video.path, saved_to: job.video.savedTo } : {}) }));
    return `<session-video-status>\nHost status of previously submitted videos (may finish after an interrupted turn). `
      + `Do not regenerate an accepted task just to recover it. The host tracks it; paused tasks can be resumed from their card. `
      + `Completed video_ids can be passed to save_generated_video.\n${JSON.stringify([...summaries, ...inherited.map(video => ({ state: "completed", video_id: video.videoId, purpose: video.purpose, attachment_path: video.path }))])}\n</session-video-status>`;
  }
  async submit(config: VideoGenerationConfig, input: VideoRequest & { purpose: VideoPurpose; output_path?: string }, context: PilotDeckToolRuntimeContext) {
    if (input.output_path) outputPath(input.output_path, context);
    if (context.currentToolCallId) {
      const accepted = await this.forCall(context.sessionId, context.currentToolCallId, context.turnId);
      if (accepted) return accepted;
    }
    context.abortSignal?.throwIfAborted();
    const status = await videoClient(config, { signal: context.abortSignal, env: context.env, fetchImpl: this.options.fetchImpl }).submit(input);
    // No await between receiving the ID and recording ownership, before the first GET.
    const job: VideoJob = { id: randomUUID(), sessionId: context.sessionId, toolCallId: context.currentToolCallId ?? randomUUID(),
      turnId: context.turnId, remoteId: status.id, baseUrl: videoApiBaseUrl(config.baseUrl), model: config.model,
      purpose: input.purpose, state: "tracking", createdAt: Date.now(), updatedAt: Date.now(), outputPath: input.output_path,
      context: { cwd: context.cwd, permissionMode: context.permissionMode, messageId: context.messageId,
        permissionContext: { ...context.permissionContext, rules: { allow: [], deny: [], ask: [] } } } };
    await this.write(job);
    return job;
  }
  private async lease(job: VideoJob): Promise<(() => Promise<void>) | undefined> {
    const file = this.file(job.sessionId, job.id) + ".lease";
    const owner = { pid: process.pid, nonce: randomUUID() };
    const temporary = file + "." + owner.nonce;
    await writeFile(temporary, JSON.stringify(owner), { flag: "wx", mode: 0o600 });
    try {
      try { await link(temporary, file); }
      catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
        const previous = JSON.parse(await readFile(file, "utf8"));
        try { process.kill(previous.pid, 0); return; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") return; }
        // Never reclaim a live process's lease, including while downloading.
        const current = JSON.parse(await readFile(file, "utf8"));
        if (current.nonce !== previous.nonce) return;
        await unlink(file); try { await link(temporary, file); } catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") return; throw error; }
      }
      return async () => { const current = JSON.parse(await readFile(file, "utf8").catch(() => "{}")); if (current.nonce === owner.nonce) await unlink(file).catch(() => {}); };
    } finally { await unlink(temporary).catch(() => {}); }
  }
  start(job: VideoJob) {
    const key = this.file(job.sessionId, job.id);
    if (active.has(key)) return active.get(key)!;
    // A local/disk failure leaves the accepted record intact. The next scan
    // can recover it; never mutate a record outside its process lease.
    const work = this.track(job).catch(() => {}).finally(() => active.delete(key));
    active.set(key, work); return work;
  }
  private async track(original: VideoJob) {
    const release = await this.lease(original); if (!release) return;
    let job = await this.get(original.sessionId, original.id);
    const deadline = Date.now() + (this.options.timeoutMs ?? VIDEO_TIMEOUT_MS);
    let failures = 0;
    try {
      while (unfinishedVideoJob(job)) {
        if (Date.now() >= deadline) { job = { ...job, state: "paused", reason: "timeout" }; await this.write(job); break; }
        const config = this.options.getConfig();
        // Disabling hides tools, but does not discard previously accepted jobs.
        if (!config?.apiKey || videoApiBaseUrl(config.baseUrl) !== job.baseUrl) {
          job = { ...job, state: "paused", reason: "configuration" }; await this.write(job); break;
        }
        try {
          let video: GeneratedVideo | undefined;
          try { video = await this.options.store.get(job.sessionId, job.id); } catch (e) { if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e; }
          if (!video) {
            const remaining = deadline - Date.now();
            const signal = AbortSignal.timeout(Math.max(1, Math.min(this.options.requestTimeoutMs ?? 60_000, remaining)));
            const client = videoClient({ ...config, baseUrl: job.baseUrl }, { signal, env: this.options.env, fetchImpl: this.options.fetchImpl });
            const status = await client.status(job.remoteId);
            if (["failed", "cancelled"].includes(status.status)) {
              job = { ...job, state: status.status, reason: "provider" }; await this.write(job); break;
            }
            if (status.status !== "completed") {
              if (!["queued", "pending", "in_progress", "processing"].includes(status.status)) {
                job = { ...job, state: "paused", reason: "provider" }; await this.write(job); break;
              }
              job = { ...job, state: "tracking", reason: undefined }; failures = 0; await this.write(job);
              await delay(this.options.pollMs ?? 2000); continue;
            }
            job = { ...job, state: "downloading", reason: undefined }; await this.write(job);
            // Large media downloads may take much longer than a status GET.
            // Keep streaming bounded by the tracking window, not its 60s probe.
            const downloadSignal = AbortSignal.timeout(Math.max(1, deadline - Date.now()));
            const downloadClient = videoClient({ ...config, baseUrl: job.baseUrl }, { signal: downloadSignal, env: this.options.env, fetchImpl: this.options.fetchImpl });
            video = await this.options.store.save(job.sessionId, await downloadClient.content(job.remoteId), downloadSignal, job.purpose, job.id);
          }
          if (job.outputPath) {
            try {
              const live = contexts.get(this.file(job.sessionId, job.id));
              const context = live && !live.abortSignal?.aborted ? live : { ...job.context, sessionId: job.sessionId, turnId: job.turnId };
              // Re-check workspace boundaries at publication, and never overwrite.
              video.savedTo = await publish(video, job.outputPath, context);
            } catch { job.exportError = true; }
          }
          await this.deliverToParents(job, video);
          job = { ...job, state: "completed", video, reason: undefined }; await this.write(job); break;
        } catch (error) {
          if (error instanceof Error && /invalid MP4|exceeds the 512 MB/.test(error.message)) {
            job = { ...job, state: "paused", reason: "provider" }; await this.write(job); break;
          }
          if (error instanceof VideoApiError && !error.retryable) {
            job = { ...job, state: "paused", reason: error.status === 401 || error.status === 403 ? "configuration" : "provider" }; await this.write(job); break;
          }
          job = { ...job, state: "reconnecting", reason: "network" }; await this.write(job);
          await delay(Math.min(this.options.retryMs ?? 30_000, (this.options.pollMs ?? 2000) * 2 ** Math.min(failures++, 4), Math.max(1, deadline - Date.now())));
        }
      }
    } finally { await release(); }
  }
  async wait(job: VideoJob, context: PilotDeckToolRuntimeContext): Promise<VideoJob> {
    const key = this.file(job.sessionId, job.id); contexts.set(key, context);
    void this.start(job);
    try {
      while (true) {
        context.abortSignal?.throwIfAborted();
        const current = await this.get(job.sessionId, job.id);
        if (!unfinishedVideoJob(current)) return current;
        await delay(this.options.pollMs ?? 1000, undefined, { signal: context.abortSignal });
        // An exited worker's lease may have belonged to another process.
        if (!active.has(key)) void this.start(current);
      }
    } finally { contexts.delete(key); }
  }
  async resume(sessionId: string, id: string) {
    const job = await this.get(sessionId, id);
    if (job.state !== "paused") return job;
    const release = await this.lease(job); if (!release) return job;
    try { job.state = "tracking"; job.reason = undefined; await this.write(job); } finally { await release(); }
    void this.start(job); return job;
  }
  /** Register the fork's completed attachment without creating another remote
   * task. The caller owns the copied file; this rollback removes only its ledger. */
  async inheritCompleted(job: VideoJob, video: GeneratedVideo, subagentId?: string): Promise<() => Promise<void>> {
    if (job.state !== "completed" || job.video?.videoId !== video.videoId || job.video.sessionId !== job.sessionId || job.sessionId === video.sessionId) {
      throw new Error("Only completed video tasks can be inherited by another session.");
    }
    const inherited = { ...job, sessionId: video.sessionId, video, forkSubagentId: subagentId ?? job.forkSubagentId };
    await this.write(inherited);
    return () => unlink(this.file(inherited.sessionId, inherited.id)).catch(() => {});
  }
  private async hasLiveLease(job: VideoJob): Promise<boolean> {
    try {
      const owner = JSON.parse(await readFile(this.file(job.sessionId, job.id) + ".lease", "utf8"));
      try { process.kill(owner.pid, 0); return true; }
      catch (error) { return (error as NodeJS.ErrnoException).code !== "ESRCH"; }
    } catch { return false; }
  }
  /** Run in the Web host, even if no chat or Agent turn is open. Cross-process
   * leases prevent racing the Gateway's original serial tool invocation. */
  startRecovery(intervalMs = 5000) {
    let stopped = false, scanning = false;
    const running = new Set<string>();
    const scan = async () => {
      if (stopped || scanning) return; scanning = true;
      try {
        const directories = await readdir(this.root).catch(() => []);
        const jobs: VideoJob[] = [];
        for (const directory of directories.filter(d => /^[a-f0-9]{64}$/.test(d))) {
          for (const name of await readdir(join(this.root, directory))) if (uuid.test(name.slice(0, -5)) && name.endsWith(".json")) {
            try { const job = JSON.parse(await readFile(join(this.root, directory, name), "utf8")) as VideoJob;
              if (unfinishedVideoJob(job) && this.file(job.sessionId, job.id) === join(this.root, directory, name)) jobs.push(job);
            } catch { /* Ignore an invalid record, without querying any service. */ }
          }
        }
        // Only scanning holds this guard. Long-running polls must not block the
        // next scan from filling slots vacated by completed jobs. Skip work
        // already owned by the Gateway or another Web process.
        for (const job of jobs) {
          if (stopped || running.size >= 4) break;
          const key = this.file(job.sessionId, job.id);
          if (running.has(key) || active.has(key) || await this.hasLiveLease(job)) continue;
          running.add(key);
          void this.start(job).finally(() => running.delete(key));
        }
      } finally { scanning = false; }
    };
    const timer = setInterval(() => { void scan().catch(() => {}); }, intervalMs); timer.unref(); void scan().catch(() => {});
    return () => { stopped = true; clearInterval(timer); };
  }
  async registerParent(parent: string, child: string) {
    await mkdir(join(this.root, "parents"), { recursive: true, mode: 0o700 });
    const file = join(this.root, "parents", hash(child) + ".json");
    try { await writeFile(file, JSON.stringify({ parent, child }), { flag: "wx", mode: 0o600 }); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e; }
  }
  private async deliverToParents(job: VideoJob, video: GeneratedVideo) {
    let child = job.sessionId; const visited = new Set([child]);
    for (let depth = 0; depth < 16; depth++) {
      let relation: { parent: string; child: string };
      try { relation = JSON.parse(await readFile(join(this.root, "parents", hash(child) + ".json"), "utf8")); }
      catch (e) { if ((e as NodeJS.ErrnoException).code === "ENOENT") break; throw e; }
      if (relation.child !== child || visited.has(relation.parent)) break;
      await this.options.store.inheritOnce(job.sessionId, video.videoId, relation.parent);
      child = relation.parent; visited.add(child);
    }
  }
}
