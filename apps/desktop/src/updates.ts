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
  prepareNetwork?: () => Promise<void>;
  compareVersions: (a: string, b: string) => number;
  prepareToInstall: () => Promise<void>;
  recoverRuntime: () => Promise<void>;
  verifyFile?: typeof verifyDownloadedFile;
  downloadControl?: { pause: () => void; resume: () => void };
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
    // Linux's provider appends -linux[-arm64] to the channel itself.
    updater.setFeedURL({ provider: "generic", url: `https://github.com/${options.repository}/releases/download/${release.tagName}/`, channel: options.platform === "linux" ? (options.linuxPackageType === "rpm" ? "latest-rpm" : "latest") : `latest-${options.arch}`, useMultipleRangeRequest: false });
    const result = await updater.checkForUpdates();
    if (cancelled) throw new Error("cancelled");
    if (!result || !result.isUpdateAvailable) throw new Error("upToDate");
    const asset = validateUpdateInfo(result.updateInfo, release, options.platform, options.arch, options.linuxPackageType);
    cancellationToken = result.cancellationToken;
    state = { ...state, state: "downloading", transferred: 0, total: asset.size, bytesPerSecond: 0 };
    speedSample = { transferred: 0, time: Date.now() };
    const files = await updater.downloadUpdate(result.cancellationToken);
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
    // Once verification starts, Cancel is no longer offered. Installation belongs
    // to Electron, so closing the settings page never interrupts this operation.
    state = { ...state, state: "installing" };
    try {
      await options.prepareToInstall();
      // On Windows, show the installer, upgrade confirmation, progress/details,
      // and finish-page Run choice. Keep macOS's existing silent relaunch flow.
      updater.quitAndInstall(options.platform !== "win32", options.platform !== "win32");
    } catch {
      await recover();
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
      task = run().catch(failure).finally(() => { task = null; cancellationToken = undefined; resumeWaiting = undefined; });
      return status();
    },
    cancel() {
      if (["checking", "downloading", "paused"].includes(state.state)) {
        cancelled = true;
        state = { ...state, state: "cancelling", bytesPerSecond: 0 };
        cancellationToken?.cancel();
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
