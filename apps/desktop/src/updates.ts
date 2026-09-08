import { createHash } from "node:crypto";
import { rm } from "node:fs/promises";
import { createReadStream } from "node:fs";
import type { AppUpdater } from "electron-updater";

export type ReleaseAsset = { name: string; size: number; sha256: string; sha512?: string; platform: string; arch: string };
export type Release = { version: string; tagName: string; publishedAt?: string; assets: ReleaseAsset[] };
export type UpdateState = {
  state: "idle" | "checking" | "downloading" | "verifying" | "installing" | "recovering" | "failed" | "cancelled";
  progress: number;
  reason?: string;
  version?: string;
};
const busyStates = new Set(["checking", "downloading", "verifying", "installing", "recovering"]);

export function selectUpdateAssets(release: Release, platform: string, arch: string) {
  if (!((platform === "darwin" && ["arm64", "x64"].includes(arch)) || (platform === "win32" && arch === "x64"))) return null;
  const extension = platform === "darwin" ? ".zip" : "-setup.exe";
  const packages = release.assets.filter((asset) => asset.platform === platform && asset.arch === arch && asset.name.endsWith(extension)
    && /^[a-f0-9]{64}$/.test(asset.sha256) && /^[A-Za-z0-9+/]{86}==$/.test(asset.sha512 || "") && asset.size > 0);
  const feed = `latest-${arch}${platform === "darwin" ? "-mac" : ""}.yml`;
  return packages.length === 1 && release.assets.some((asset) => asset.name === feed) ? { asset: packages[0], feed } : null;
}

// Feed files are generated separately per architecture. Validate every referenced
// payload against the unified manifest before electron-updater downloads anything.
export function validateUpdateInfo(info: { version: string; files: Array<{ url: string; sha512: string; size?: number }>; packages?: unknown }, release: Release, platform: string, arch: string) {
  const selected = selectUpdateAssets(release, platform, arch);
  if (info.packages || !selected || info.version !== release.version || !info.files?.length) throw new Error("invalidUpdateMetadata");
  for (const file of info.files) {
    const asset = release.assets.find((candidate) => candidate.name === file.url);
    if (!asset || asset.platform !== platform || asset.arch !== arch || asset.sha512 !== file.sha512 || asset.size !== file.size) throw new Error("invalidUpdateMetadata");
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
  latestRelease: () => Promise<Release>;
  prepareNetwork?: () => Promise<void>;
  compareVersions: (a: string, b: string) => number;
  prepareToInstall: () => Promise<void>;
  recoverRuntime: () => Promise<void>;
  verifyFile?: typeof verifyDownloadedFile;
}) {
  const { updater } = options;
  updater.autoDownload = false;
  updater.autoInstallOnAppQuit = false;
  updater.autoRunAppAfterInstall = true;
  updater.allowPrerelease = false;
  updater.allowDowngrade = false;
  updater.disableDifferentialDownload = true;
  let state: UpdateState = { state: "idle", progress: 0 };
  let task: Promise<void> | null = null;
  let cancelled = false;
  let cancellationToken: { cancel: () => void } | undefined;
  let installFailed = false;
  const status = () => ({ ...state });
  const failure = (error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    state = { ...state, state: cancelled ? "cancelled" : "failed", reason: cancelled ? "cancelled" : ["checksumMismatch", "invalidUpdateMetadata", "noCompatibleInstaller", "upToDate"].includes(message) ? message : "updateFailed" };
  };
  updater.on("download-progress", (progress) => {
    if (state.state === "downloading") state = { ...state, progress: Math.min(.99, progress.percent / 100) };
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
      const canDownload = hasUpdate && Boolean(selectUpdateAssets(latest, options.platform, options.arch));
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
    checking = performCheck().then(result => { lastCheck = result; return result; }).finally(() => { checking = null; });
    return checking;
  }

  async function run() {
    const checked = await check();
    if (cancelled) throw new Error("cancelled");
    if (!checked.canDownload || !checked.latest) throw new Error(checked.reason || "upToDate");
    const release = checked.latest;
    state = { ...state, version: release.tagName };
    updater.setFeedURL({ provider: "generic", url: `https://github.com/${options.repository}/releases/download/${release.tagName}/`, channel: `latest-${options.arch}`, useMultipleRangeRequest: false });
    const result = await updater.checkForUpdates();
    if (cancelled) throw new Error("cancelled");
    if (!result || !result.isUpdateAvailable) throw new Error("upToDate");
    const asset = validateUpdateInfo(result.updateInfo, release, options.platform, options.arch);
    cancellationToken = result.cancellationToken;
    state = { ...state, state: "downloading" };
    const files = await updater.downloadUpdate(result.cancellationToken);
    if (cancelled) throw new Error("cancelled");
    if (files.length !== 1) throw new Error("invalidUpdateMetadata");
    state = { ...state, state: "verifying", progress: 1 };
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
      updater.quitAndInstall(true, true);
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
      state = { state: "checking", progress: 0 };
      task = run().catch(failure).finally(() => { task = null; cancellationToken = undefined; });
      return status();
    },
    cancel() {
      if (state.state === "checking" || state.state === "downloading") { cancelled = true; cancellationToken?.cancel(); }
      return status();
    },
    wait: () => task,
  };
}
