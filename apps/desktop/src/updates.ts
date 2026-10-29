import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { createReadStream } from "node:fs";
import type { AppUpdater } from "electron-updater";

export type ReleaseAsset = { name: string; size: number; sha256: string; sha512?: string; platform: string; arch: string };
export type Release = { version: string; tagName: string; publishedAt?: string; assets: ReleaseAsset[] };
export type UpdateState = {
  state: "idle" | "checking" | "downloading" | "paused" | "cancelling" | "verifying" | "installing" | "recovering" | "failed" | "cancelled";
  progress: number;
  bytesPerSecond?: number;
  transferred?: number;
  total?: number;
  reason?: string;
  version?: string;
};
const busyStates = new Set(["checking", "downloading", "paused", "cancelling", "verifying", "installing", "recovering"]);

export function selectUpdateAssets(release: Release, platform: string, arch: string, linuxPackageType = "deb") {
  if (!((platform === "darwin" && ["arm64", "x64"].includes(arch)) || (platform === "win32" && ["arm64", "x64"].includes(arch))
    || (platform === "linux" && ["arm64", "x64"].includes(arch)))) return null;
  if (platform === "linux" && !["deb", "rpm"].includes(linuxPackageType)) return null;
  const extension = platform === "darwin" ? ".zip" : platform === "linux" ? `.${linuxPackageType}` : "-setup.exe";
  const packages = release.assets.filter((asset) => asset.platform === platform && asset.arch === arch && asset.name.endsWith(extension)
    && (platform !== "linux" || asset.name.endsWith(`-linux-${arch}.${linuxPackageType}`))
    && /^[a-f0-9]{64}$/.test(asset.sha256) && /^[A-Za-z0-9+/]{86}==$/.test(asset.sha512 || "") && asset.size > 0);
  const feed = platform === "linux" ? `latest${linuxPackageType === "rpm" ? "-rpm" : ""}-linux${arch === "arm64" ? "-arm64" : ""}.yml`
    : `latest-${arch}${platform === "darwin" ? "-mac" : ""}.yml`;
  return packages.length === 1 && release.assets.some((asset) => asset.name === feed) ? { asset: packages[0], feed } : null;
}

// Feed files are generated separately per architecture. Validate every referenced
// payload against the unified manifest before electron-updater downloads anything.
export function validateUpdateInfo(info: { version: string; files: Array<{ url: string; sha512: string; size?: number }>; packages?: unknown }, release: Release, platform: string, arch: string, linuxPackageType = "deb") {
  const selected = selectUpdateAssets(release, platform, arch, linuxPackageType);
  if (info.packages || !selected || info.version !== release.version || !info.files?.length) throw new Error("invalidUpdateMetadata");
  for (const file of info.files) {
    const asset = release.assets.find((candidate) => candidate.name === file.url);
    if (!asset || asset.platform !== platform || asset.arch !== arch || asset.sha512 !== file.sha512 || asset.size !== file.size
      || (platform === "linux" && file.url !== selected.asset.name)) throw new Error("invalidUpdateMetadata");
  }
  if (!info.files.some((file) => file.url === selected.asset.name)) throw new Error("invalidUpdateMetadata");
  return selected.asset;
}

export async function verifyDownloadedFile(file: string, asset: ReleaseAsset) {
  const hash = createHash("sha256");
  let size = 0;
  for await (const chunk of createReadStream(file)) { size += chunk.length; hash.update(chunk); }
  if (size !== asset.size || hash.digest("hex") !== asset.sha256) throw new Error("checksumMismatch");
}

export function createUpdateController(options: {
  updater: AppUpdater;
  repository: string;
  platform: string;
  arch: string;
  version: string;
  packaged: boolean;
  linuxPackageType?: string;
  latestRelease: () => Promise<Release>;
  downloadBases?: (release: Release, asset: ReleaseAsset, signal: AbortSignal) => Promise<string[]>;
  downloadSucceeded?: (base: string, release: Release) => void;
  downloadFailed?: (base: string, release: Release) => void;
  prepareNetwork?: () => Promise<void>;
  compareVersions: (a: string, b: string) => number;
  prepareToInstall: () => Promise<void>;
  recoverRuntime: () => Promise<void>;
  verifyFile?: typeof verifyDownloadedFile;
  downloadControl?: { pause: () => void; resume: () => void; cancel?: () => void; receivedBytes?: () => number };
}) {
  const { updater } = options;
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  // The assisted Windows installer offers a Run checkbox on its finish page.
  updater.autoRunAppAfterInstall = options.platform !== "win32";
  updater.allowPrerelease = false;
  updater.allowDowngrade = false;
  updater.disableDifferentialDownload = true;
  let state: UpdateState = { state: "idle", progress: 0 };
  let task: Promise<void> | null = null;
  let cancelled = false;
  let cancellationToken: { cancel: () => void } | undefined;
  let probeAbort: AbortController | undefined;
  let installFailed = false;
  let resumeWaiting: (() => void) | undefined;
  let speedSample: { transferred: number; time: number } | undefined;
  const status = () => ({ ...state });
  const failure = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    state = { ...state, bytesPerSecond: 0, state: cancelled ? "cancelled" : "failed", reason: cancelled ? "cancelled" : ["checksumMismatch", "invalidUpdateMetadata", "noCompatibleInstaller", "upToDate"].includes(message) ? message : "updateFailed" };
  };
  updater.on("download-progress", (progress) => {
    if (state.state !== "downloading") return;
    const transferred = Number.isFinite(progress.transferred) ? Math.max(0, progress.transferred) : state.transferred;
    const total = Number.isFinite(progress.total) && progress.total > 0 ? progress.total : state.total;
    const now = Date.now();
    const speed = transferred !== undefined && speedSample && now > speedSample.time
      ? (transferred - speedSample.transferred) * 1000 / (now - speedSample.time) : progress.bytesPerSecond;
    if (transferred !== undefined) speedSample = { transferred, time: now };
    state = {
      ...state,
      progress: Number.isFinite(progress.percent) ? Math.max(0, Math.min(.99, progress.percent / 100)) : state.progress,
      transferred, total,
      bytesPerSecond: Number.isFinite(speed) ? Math.max(0, speed) : 0,
    };
  });
  const recover = async () => {
    installFailed = true;
    state = { ...state, state: "recovering", reason: "installFailed" };
    try { await options.recoverRuntime(); }
    catch { /* The user must restart the client if runtime recovery also fails. */ }
    finally { state = { ...state, state: "failed", reason: "installFailed" }; }
  };
  updater.on("error", () => {
    // Check/download errors also reject their promise. Native installation errors
    // happen later, after the Web server has stopped, so restore that runtime.
    if (state.state === "installing") void recover().catch(() => {});
  });

  async function performCheck() {
    try {
      if (!options.packaged) throw new Error("development");
      await options.prepareNetwork?.();
      const latest = await options.latestRelease();
      const hasUpdate = options.compareVersions(options.version, latest.version) < 0;
      const canDownload = hasUpdate && Boolean(selectUpdateAssets(latest, options.platform, options.arch, options.linuxPackageType));
      return { current: { version: options.version }, latest, hasUpdate, canDownload,
        checkUnavailable: false, reason: hasUpdate && !canDownload ? "noCompatibleInstaller" : null };
    } catch (error) {
      return { current: { version: options.version }, latest: null, hasUpdate: false, canDownload: false,
        checkUnavailable: true, reason: !options.packaged ? "development" : "checkFailed" };
    }
  }

  type CheckResult = Awaited<ReturnType<typeof performCheck>>;
  let lastCheck: CheckResult | null = null;
  let checking: Promise<CheckResult> | null = null;
  function check(): Promise<CheckResult> {
    if (checking) return checking;
    if (busyStates.has(state.state) && lastCheck) return Promise.resolve(lastCheck);
    checking = performCheck().then(result => {
      // A fresh successful check acknowledges a previous download failure.
      // Native installation failures still require a full client restart.
      lastCheck = installFailed ? { ...result, canDownload: false, reason: "installFailed" } : result;
      if (!task && !installFailed && !result.checkUnavailable && ["failed", "cancelled"].includes(state.state)) {
        state = { state: "idle", progress: 0 };
      }
      return lastCheck;
    }).finally(() => { checking = null; });
    return checking;
  }

  async function run() {
    const checked = await check();
    if (cancelled) throw new Error("cancelled");
    if (!checked.canDownload || !checked.latest) throw new Error(checked.reason || "upToDate");
    const release = checked.latest;
    state = { ...state, version: release.tagName };
    const selected = selectUpdateAssets(release, options.platform, options.arch, options.linuxPackageType)!;
    probeAbort = new AbortController();
    const bases = options.downloadBases
      ? await options.downloadBases(release, selected.asset, probeAbort.signal)
      : [`https://github.com/${options.repository}/releases/download/${release.tagName}/`];
    let lastError: unknown = new Error("updateFailed");
    let verified = false;
    // Try every route before retrying any one route. The release and hashes are
    // pinned for this whole operation, including retries after mirror sync lag.
    for (let round = 0; round < (options.downloadBases ? 2 : 1) && !verified; round++) {
      for (const base of bases) {
        if (cancelled) throw new Error("cancelled");
        state = { state: "checking", progress: 0, version: release.tagName };
        options.downloadControl?.resume();
        try {
          await downloadAndVerify(base, release, round === 0 && bases.length > 1);
          try { options.downloadSucceeded?.(base, release); } catch { /* Route history is optional. */ }
          verified = true;
          break;
        } catch (error) {
          if (state.state === "paused") await new Promise<void>(resolve => { resumeWaiting = resolve; });
          if (cancelled) throw new Error("cancelled");
          try { options.downloadFailed?.(base, release); } catch { /* Route history is optional. */ }
          lastError = error;
        } finally { cancellationToken = undefined; }
      }
    }
    if (!verified) throw lastError;
    state = { ...state, state: "installing" };
    try {
      await options.prepareToInstall();
      updater.quitAndInstall(options.platform !== "win32", options.platform !== "win32");
    } catch {
      await recover();
    }
  }

  async function downloadAndVerify(base: string, release: Release, allowSlowSwitch: boolean) {
    // Linux's provider appends -linux[-arm64] to the channel itself.
    updater.setFeedURL({ provider: "generic", url: base, channel: options.platform === "linux" ? (options.linuxPackageType === "rpm" ? "latest-rpm" : "latest") : `latest-${options.arch}`, useMultipleRangeRequest: false });
    const result = await updater.checkForUpdates();
    if (cancelled) throw new Error("cancelled");
    if (!result || !result.isUpdateAvailable) throw new Error("invalidUpdateMetadata");
    const asset = validateUpdateInfo(result.updateInfo, release, options.platform, options.arch, options.linuxPackageType);
    cancellationToken = result.cancellationToken;
    state = { ...state, state: "downloading", transferred: 0, total: asset.size, bytesPerSecond: 0 };
    speedSample = { transferred: 0, time: Date.now() };
    // A connection can stay open without making useful progress. Treat a
    // 30-second window below 32 KiB/s as a reason to try another route. On the
    // final round accept slow progress, so a slow local network can still update.
    // Upstream emits download-progress only with Content-Length. Use actual
    // transport bytes, never UI progress, to detect chunked download stalls.
    let windowStarted = Date.now(), windowBytes = options.downloadControl?.receivedBytes?.() ?? 0;
    const watchdog = setInterval(() => {
      const now = Date.now();
      const transferred = options.downloadControl?.receivedBytes?.();
      // Adapters without transport telemetry cannot establish a stall safely.
      if (transferred === undefined) return;
      if (state.state !== "downloading") { windowStarted = now; windowBytes = transferred; return; }
      if (now - windowStarted < 30_000) return;
      const bytes = transferred - windowBytes;
      if (bytes <= 0 || (allowSlowSwitch && bytes * 1000 / (now - windowStarted) < 32 * 1024)) result.cancellationToken?.cancel();
      windowStarted = now; windowBytes = transferred;
    }, 1000);
    let files: string[];
    try { files = await updater.downloadUpdate(result.cancellationToken); }
    finally { clearInterval(watchdog); }
    // A cached/just-completed payload can finish while Pause is being clicked.
    // Keep the same task and never advance to verification/install while paused.
    if (state.state === "paused") await new Promise<void>(resolve => { resumeWaiting = resolve; });
    if (cancelled) throw new Error("cancelled");
    if (files.length !== 1) throw new Error("invalidUpdateMetadata");
    state = { ...state, state: "verifying", progress: 1, transferred: asset.size, bytesPerSecond: 0 };
    try {
      await (options.verifyFile || verifyDownloadedFile)(files[0], asset);
    } catch (error) {
      await rm(files[0], { force: true });
      throw error;
    }
  }

  return {
    check, status,
    start() {
      if (task || busyStates.has(state.state) || installFailed) return status();
      lastCheck = null;
      cancelled = false;
      cancellationToken = undefined;
      options.downloadControl?.resume();
      speedSample = undefined;
      state = { state: "checking", progress: 0 };
      task = run().catch(failure).finally(() => { task = null; cancellationToken = undefined; probeAbort = undefined; resumeWaiting = undefined; });
      return status();
    },
    cancel() {
      if (["checking", "downloading", "paused"].includes(state.state)) {
        cancelled = true;
        state = { ...state, state: "cancelling", bytesPerSecond: 0 };
        cancellationToken?.cancel();
        options.downloadControl?.cancel?.();
        probeAbort?.abort();
        resumeWaiting?.();
      }
      return status();
    },
    pause() {
      if (state.state === "downloading") {
        options.downloadControl?.pause();
        state = { ...state, state: "paused", bytesPerSecond: 0 };
      }
      return status();
    },
    resume() {
      if (state.state === "paused") {
        state = { ...state, state: "downloading", bytesPerSecond: 0 };
        speedSample = { transferred: state.transferred || 0, time: Date.now() };
        options.downloadControl?.resume();
        resumeWaiting?.();
        resumeWaiting = undefined;
      }
      return status();
    },
    wait: () => task,
  };
}
