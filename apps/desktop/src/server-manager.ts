/**
 * ServerManager — owns the pilotdeckui Express server child process.
 *
 * Adapted from OpenClaw's GatewayManager (apps/electron/src/gateway-manager.ts).
 * Key differences:
 *   - Spawns `node-bin/node pilotdeckui/server/index.js` (instead of entry.js gateway)
 *   - Three tarballs to extract (pilotdeckui/server resolves pilotdeck-memory-core
 *     via `../../../pilotdeck-memory-core/lib/index.js`, so all three must be siblings):
 *       Resources/pilotdeckui-bundle.tar         → Resources/pilotdeckui/
 *       Resources/pilotdeck-main-bundle.tar     → Resources/pilotdeck-main/
 *       Resources/pilotdeck-memory-core-bundle.tar → Resources/edgeclaw-memory-core/
 *   - Sets BUN_BIN, PILOTDECK_MAIN_DIR so the server can spawn `bun` subprocesses
 *   - pilotdeckui /health responds with `{status: "ok", ...}` (not `{ok: true}`)
 */

import { execSync, spawn, type ChildProcess } from "node:child_process";
import { promisify } from "node:util";
import { execFile as execFileCb } from "node:child_process";
const execFile = promisify(execFileCb);
import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";
import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as net from "node:net";
import * as os from "node:os";
import * as path from "node:path";

const DEFAULT_PORT_START = 18790;
const DEFAULT_PORT_END = 18799;
const PROXY_PORT = 18080;
const GATEWAY_PORT = 18789;
const HEALTH_POLL_MS = 1500;
const HEALTH_REQUEST_TIMEOUT_MS = 2000;
const STARTUP_HEALTH_TIMEOUT_MS = 60_000;
const GATEWAY_STARTUP_TIMEOUT_MS = 45_000;
const SHUTDOWN_SIGTERM_WAIT_MS = 5000;
const ORPHAN_TERM_WAIT_MS = 3000;
const STABLE_RUN_RESET_MS = 60_000;
const MAX_RESTART_ATTEMPTS = 3;
const RESTART_BACKOFF_MS = [2000, 4000, 8000] as const;

// Reasoning models (e.g. MiniMax-M2.7-highspeed, DeepSeek-R1) emit large
// <think>/reasoning blocks that consume the output budget BEFORE the actual
// answer. Anthropic SDK's getMaxOutputTokensForModel falls back to 32_000 for
// unknown model names but a downstream GrowthBook gate (tengu_otk_slot_v1) can
// silently cap that to 8_000. 8k is barely enough room for thinking + a short
// answer; 16k leaves headroom without risking provider rejections (MiniMax
// caps at ~64k, OpenAI-compatible Chat caps at 32k for most providers).
//
// User can override via PILOTDECK_MAX_OUTPUT_TOKENS env or
// agents.main.params.maxOutputTokens in ~/.pilotdeck/pilotdeck.yaml (the latter is
// wired up in ui/server/services/pilotdeckConfig.js → buildRuntimeEnv).
const REASONING_FRIENDLY_MAX_OUTPUT_TOKENS = "16000";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function bundledBinary(binDir: string, name: string): string {
  if (process.platform === "win32") {
    const exePath = path.join(binDir, `${name}.exe`);
    if (fsSync.existsSync(exePath)) return exePath;
  }
  return path.join(binDir, name);
}

function linkDirectory(link: string, target: string): void {
  if (fsSync.existsSync(link) || !fsSync.existsSync(target)) return;
  if (process.platform === "win32") {
    fsSync.symlinkSync(target, link, "junction");
  } else {
    fsSync.symlinkSync(target, link);
  }
}

function getPilotDeckDir(): string {
  return path.join(os.homedir(), ".pilotdeck");
}

function getPidFilePath(): string {
  return path.join(getPilotDeckDir(), "desktop.server.pid");
}

async function ensurePilotDeckDir(): Promise<void> {
  await fs.mkdir(getPilotDeckDir(), { recursive: true });
}

/**
 * Per-version runtime extraction root.
 *
 * macOS protects `/Applications/<App>.app/Contents/Resources/` via SIP+TCC
 * (App Management gate, macOS 14+); writing extracted bundles there works on
 * first launch but can be wiped silently on app upgrade and is technically a
 * violation of Apple's "app bundle is read-only after install" guideline.
 *
 * The proper home is `~/Library/Application Support/<App>/runtime/<version>/`,
 * which is per-user, writable, survives macOS upgrades, and is the standard
 * location Electron's `app.getPath('userData')` resolves to.
 *
 * We key on the PilotDeck bundle version so that upgrading the app forces a
 * fresh extraction (otherwise stale source files from the previous version
 * would silently win). Old version dirs are GC'd on next startup via
 * `cleanupStaleRuntimeVersions()`.
 */
function getRuntimeBaseDir(version: string): string {
  return path.join(
    os.homedir(),
    "Library",
    "Application Support",
    "PilotDeck",
    "runtime",
    version,
  );
}

function getCronDaemonSocketPath(): string {
  return path.join(
    process.env.PILOTDECK_CONFIG_DIR || process.env.PILOT_HOME || path.join(os.homedir(), ".pilotdeck"),
    "cron-daemon.sock",
  );
}

async function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", (err: NodeJS.ErrnoException) => {
      if (err.code === "EADDRINUSE") {
        resolve(false);
      } else {
        reject(err);
      }
    });
    server.listen(port, "127.0.0.1", () => {
      server.close(() => resolve(true));
    });
  });
}

async function pickAvailablePort(): Promise<number> {
  for (let port = DEFAULT_PORT_START; port <= DEFAULT_PORT_END; port++) {
    if (await isPortFree(port)) {
      return port;
    }
  }
  throw new Error(
    `No free desktop server port in range ${DEFAULT_PORT_START}-${DEFAULT_PORT_END}`,
  );
}

function getServerLogPath(): string {
  return path.join(os.homedir(), ".pilotdeck", "desktop.server.log");
}

function readTailSafe(filePath: string, maxBytes: number): string {
  try {
    const stat = fsSync.statSync(filePath);
    const fd = fsSync.openSync(filePath, "r");
    try {
      const start = Math.max(0, stat.size - maxBytes);
      const len = stat.size - start;
      const buf = Buffer.alloc(len);
      fsSync.readSync(fd, buf, 0, len, start);
      return buf.toString("utf8");
    } finally {
      fsSync.closeSync(fd);
    }
  } catch {
    return "(no log)";
  }
}

async function readPidFile(): Promise<number | null> {
  try {
    const raw = await fs.readFile(getPidFilePath(), "utf8");
    const n = Number.parseInt(raw.trim(), 10);
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw err;
  }
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ESRCH") return false;
    // On Windows, process.kill(pid, 0) can throw EPERM if the process
    // exists but belongs to another user — treat as "exists".
    if (process.platform === "win32" && (err as NodeJS.ErrnoException).code === "EPERM") return true;
    throw err;
  }
}

function forceKillPid(pid: number): void {
  try {
    if (process.platform === "win32") {
      execSync(`taskkill /F /PID ${pid} /T 2>NUL`, {
        stdio: "ignore",
        timeout: 5000,
        shell: "cmd.exe",
      });
    } else {
      process.kill(pid, "SIGKILL");
    }
  } catch { /* ignore */ }
}

async function waitForProcessExit(pid: number, maxMs: number): Promise<void> {
  const deadline = Date.now() + maxMs;
  while (Date.now() < deadline) {
    if (!processExists(pid)) return;
    await sleep(50);
  }
}

async function cleanupStaleOrOrphanPid(): Promise<void> {
  const pid = await readPidFile();
  if (pid === null) return;
  if (!processExists(pid)) {
    try {
      await fs.unlink(getPidFilePath());
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
    return;
  }
  try {
    process.kill(pid, "SIGTERM");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ESRCH") throw err;
  }
  await waitForProcessExit(pid, SHUTDOWN_SIGTERM_WAIT_MS);
  if (processExists(pid)) {
    forceKillPid(pid);
  }
  try {
    await fs.unlink(getPidFilePath());
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
}

/**
 * Poll http://127.0.0.1:<port>/health until it returns `{status: "ok"}` or
 * we hit the startup timeout.
 *
 * If `child` is provided, we additionally short-circuit the moment the
 * child process exits (exitCode !== null || signalCode !== null). Without
 * this fast-fail, a child that crashes ~10ms after spawn (e.g. because
 * load-env.js threw on missing config) still keeps us polling for the full
 * 60-second deadline before the user sees the error dialog.
 */
async function waitForServerHealth(
  port: number,
  child?: ChildProcess,
): Promise<void> {
  const deadline = Date.now() + STARTUP_HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child && (child.exitCode !== null || child.signalCode !== null)) {
      throw new Error(
        `Server child exited before becoming healthy (code=${
          child.exitCode ?? "null"
        }, signal=${child.signalCode ?? "null"})`,
      );
    }
    try {
      const res = await fetch(`http://127.0.0.1:${port}/health`, {
        signal: AbortSignal.timeout(HEALTH_REQUEST_TIMEOUT_MS),
      });
      if (res.ok) {
        const body = (await res.json()) as { status?: string };
        if (body && body.status === "ok") return;
      }
    } catch {
      /* retry until deadline */
    }
    await sleep(HEALTH_POLL_MS);
  }
  throw new Error(
    `Server health check failed within ${STARTUP_HEALTH_TIMEOUT_MS}ms`,
  );
}

export type ServerManagerOptions = {
  /**
   * When true, spawns from the dev source tree.
   * When false (packaged app), uses `process.resourcesPath` from Electron.
   */
  dev?: boolean;
  /**
   * Repo root (the parent of `pilotdeckui/` and `pilotdeck-main/`).
   * Required when `dev: true`.
   */
  devRepoRoot?: string;
  /**
   * Bundle version (typically `app.getVersion()`). Used to pick the per-version
   * runtime extraction directory under `~/Library/Application Support/PilotDeck/
   * runtime/<version>/`. Required when `dev: false` so that upgrading the app
   * forces a fresh re-extraction of bundled tarballs.
   */
  appVersion?: string;
};

export type ServerManagerEvents = {
  ready: [port: number];
  error: [error: Error];
  restarting: [attempt: number];
  "max-restarts": [];
  /**
   * Phase-label updates emitted while start() is in flight. Consumed by
   * the splash window so users get visible feedback during the long
   * first-launch tarball extraction. Strings are user-facing Chinese
   * copy — keep them short (≤ 24 chars), end-state-shaped, and
   * deliberately *abstracted* away from internal bundle names: users
   * shouldn't see "pilotdeckui" or "pilotdeck-main", they should see
   * "正在解压应用资源 (1/3)" etc. The internal labels are mapped at the
   * resolvePaths() call site.
   */
  progress: [phase: string];
};

export class ServerManager extends EventEmitter<ServerManagerEvents> {
  private readonly dev: boolean;
  private readonly devRepoRoot: string | undefined;
  private readonly appVersion: string | undefined;

  private child: ChildProcess | null = null;
  private gatewayChild: ChildProcess | null = null;
  private port: number | null = null;
  private stopRequested = false;
  private startPromise: Promise<{ port: number }> | null = null;

  private restartAttempts = 0;
  private stableTimer: ReturnType<typeof setTimeout> | null = null;
  private exitHandlerBound = false;
  /**
   * Set to true while the very first start() is in flight. The exit watchdog
   * checks this and refuses to schedule a restart until the initial start
   * either succeeds or rejects, otherwise an early-crashing child triggers
   * concurrent restart attempts that race against the still-pending health
   * polling loop (and double-emit "error" events).
   */
  private initialStartInFlight = false;

  constructor(options: ServerManagerOptions = {}) {
    super();
    this.dev = options.dev ?? false;
    this.devRepoRoot = options.devRepoRoot;
    this.appVersion = options.appVersion;
  }

  /**
   * Extract a tarball into `<runtimeBaseDir>/<destDirName>/`, idempotent via
   * marker. The marker stores the source tarball mtime+size so that if the
   * bundled tar is updated (e.g. after an in-place reinstall over the same
   * version) we re-extract automatically.
   *
   * Switched from `execSync('tar xf ...')` to `await execFile('tar', ...)`
   * so the Electron main loop can keep handling IPC (in particular the
   * splash window's status-update channel) while the ~700MB total of
   * bundled tarballs is unpacked. Sync extraction blocked the main thread
   * for tens of seconds on cold APFS caches; the splash text would freeze
   * mid-update and users would assume the app crashed.
   */
  private async ensureBundleExtracted(
    tarballSourceDir: string,
    runtimeBaseDir: string,
    tarballName: string,
    destDirName: string,
    progressLabel: string,
  ): Promise<string> {
    const destDir = path.join(runtimeBaseDir, destDirName);
    const tarball = path.join(tarballSourceDir, tarballName);
    const marker = path.join(destDir, ".extracted");

    if (!fsSync.existsSync(tarball)) {
      throw new Error(`Bundle not found: ${tarball}`);
    }

    const tarStat = fsSync.statSync(tarball);
    const expectedMarker = `${tarStat.mtimeMs.toFixed(0)}-${tarStat.size}`;

    if (fsSync.existsSync(marker)) {
      try {
        const recorded = fsSync.readFileSync(marker, "utf8").trim();
        if (recorded === expectedMarker) return destDir;
      } catch {
        /* fall through and re-extract */
      }
    }

    // Single user-visible phase covers both the partial-leftover nuke and
    // the actual tar extraction — users don't care which sub-step we're
    // on, and "正在解压…" stays accurate throughout (cleanup is fast,
    // tar dominates wall-clock).
    this.emit("progress", `${progressLabel}…首次安装可能需要 30 秒`);

    if (fsSync.existsSync(destDir)) {
      // Fresh extract: nuke any partial leftover so we don't merge stale
      // + new payloads (could happen if a previous extraction was
      // interrupted).
      await fs.rm(destDir, { recursive: true, force: true });
    }
    await fs.mkdir(destDir, { recursive: true });

    const tarBin = process.platform === "win32" ? "tar" : "/usr/bin/tar";
    await execFile(tarBin, ["xf", tarball, "-C", destDir], {
      timeout: 180_000,
      maxBuffer: 1024 * 1024,
    });
    await fs.writeFile(marker, expectedMarker);
    return destDir;
  }

  /**
   * Best-effort cleanup of `~/Library/Application Support/PilotDeck/runtime/`
   * subdirectories belonging to other versions. Called at startup so that
   * upgrading the app reclaims disk (~1GB per stale version).
   */
  private cleanupStaleRuntimeVersions(currentVersion: string): void {
    const runtimeRoot = path.dirname(getRuntimeBaseDir(currentVersion));
    if (!fsSync.existsSync(runtimeRoot)) return;
    let entries: string[];
    try {
      entries = fsSync.readdirSync(runtimeRoot);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry === currentVersion) continue;
      const stalePath = path.join(runtimeRoot, entry);
      try {
        fsSync.rmSync(stalePath, { recursive: true, force: true });
      } catch {
        /* ignore — best-effort GC */
      }
    }
  }

  private async resolvePaths(): Promise<{
    nodeBin: string;
    bunBin: string;
    serverEntry: string;
    serverCwd: string;
    pilotDeckMainDir: string;
  }> {
    if (this.dev) {
      const root = this.devRepoRoot;
      if (!root)
        throw new Error("ServerManager: devRepoRoot is required when dev=true");
      return {
        nodeBin: bundledBinary(
          path.join(root, "apps", "desktop", "resources", "node-bin"),
          "node",
        ),
        bunBin: bundledBinary(
          path.join(root, "apps", "desktop", "resources", "bun-bin"),
          "bun",
        ),
        // Repo UI lives at ui/ (bundle tar extracts as pilotdeckui/ at runtime).
        serverEntry: path.join(root, "ui", "server", "index.js"),
        serverCwd: path.join(root, "ui"),
        pilotDeckMainDir: root,
      };
    }
    const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string })
      .resourcesPath;
    const resources = typeof resourcesPath === "string" ? resourcesPath : "";
    if (!resources) {
      throw new Error(
        "ServerManager: process.resourcesPath unavailable; pass dev/devRepoRoot or run under Electron",
      );
    }
    if (!this.appVersion) {
      throw new Error(
        "ServerManager: appVersion is required for packaged mode (pass app.getVersion() into the constructor)",
      );
    }
    const runtimeBaseDir = getRuntimeBaseDir(this.appVersion);
    fsSync.mkdirSync(runtimeBaseDir, { recursive: true });
    // Stale-version GC runs silently — it only does work on upgrades and
    // there's nothing useful to tell the user about it. Bundling its
    // wall-clock into the next phase keeps the splash sequence shorter.
    this.cleanupStaleRuntimeVersions(this.appVersion);

    // Order matters only for clarity; resolution at runtime is via ../../../
    // path walks so all three must end up as siblings inside runtimeBaseDir.
    // Each ensureBundleExtracted is awaited *sequentially* (not Promise.all)
    // because: (a) tar is single-threaded I/O bound — parallel extraction
    // saturates the disk and gives no wall-clock win; (b) sequential
    // execution means the splash status label tracks reality (one tarball
    // at a time) instead of showing one phase while three race in the
    // background.
    //
    // Progress labels are intentionally generic ("应用资源 (N/3)") rather
    // than naming the internal bundle (memory-core / pilotdeckui /
    // pilotdeck-main) — those names mean nothing to end users and the
    // (N/3) index gives enough sense of "how many steps left".
    await this.ensureBundleExtracted(
      resources,
      runtimeBaseDir,
      "pilotdeck-memory-core-bundle.tar",
      "edgeclaw-memory-core",
      "正在解压应用资源 (1/3)",
    );
    const pilotDeckUiDir = await this.ensureBundleExtracted(
      resources,
      runtimeBaseDir,
      "pilotdeckui-bundle.tar",
      "pilotdeckui",
      "正在解压应用资源 (2/3)",
    );
    const pilotDeckMainDir = await this.ensureBundleExtracted(
      resources,
      runtimeBaseDir,
      "pilotdeck-main-bundle.tar",
      "pilotdeck-main",
      "正在解压应用资源 (3/3)",
    );

    // ui/server/ files import compiled JS via relative paths like
    // `../../dist/src/pilot/index.js`. From pilotdeckui/server/ that
    // resolves to <runtimeBaseDir>/dist/src/..., but the actual dist/
    // tree lives inside <runtimeBaseDir>/pilotdeck-main/dist/. A symlink
    // bridges the gap so all ESM resolve calls succeed at runtime.
    const distLink = path.join(runtimeBaseDir, "dist");
    const distTarget = path.join(pilotDeckMainDir, "dist");
    linkDirectory(distLink, distTarget);

    // edgeclaw-memory-core is a file: dependency in the repo's package.json.
    // The release tar excludes the top-level edgeclaw-memory-core/ (it has
    // its own bundle), which also strips the node_modules/ symlink.
    // Compiled code does `import ... from "edgeclaw-memory-core"` (bare
    // specifier), so Node must find it under pilotdeck-main/node_modules/.
    const memNodeModLink = path.join(
      pilotDeckMainDir,
      "node_modules",
      "edgeclaw-memory-core",
    );
    const memCoreDir = path.join(runtimeBaseDir, "edgeclaw-memory-core");
    linkDirectory(memNodeModLink, memCoreDir);

    // npm hoists shared deps (ws, express, etc.) into the root node_modules/
    // which ends up inside pilotdeck-main-bundle.tar, not pilotdeckui-bundle.tar.
    // ESM resolution walks up the directory tree looking for node_modules/ dirs.
    // A symlink at <runtimeBaseDir>/node_modules → pilotdeck-main/node_modules
    // lets the resolver find hoisted packages after exhausting pilotdeckui's own.
    const hoistedLink = path.join(runtimeBaseDir, "node_modules");
    const hoistedTarget = path.join(pilotDeckMainDir, "node_modules");
    linkDirectory(hoistedLink, hoistedTarget);

    // ui/server/ also imports `../../src/web/server/*.js` etc. In dev
    // mode tsx resolves .js → .ts; in packaged mode we need actual .js
    // files. Point src/ → pilotdeck-main/dist/src/ (compiled output).
    const srcLink = path.join(runtimeBaseDir, "src");
    const srcTarget = path.join(pilotDeckMainDir, "dist", "src");
    linkDirectory(srcLink, srcTarget);

    // pilotdeckui/server/routes/memory.js imports edgeclaw-memory-core
    // via `../../../src/context/memory/edgeclaw-memory-core/lib/index.js`.
    // The src/ symlink points to pilotdeck-main/dist/src/ (compiled TS),
    // which contains an empty edgeclaw-memory-core/src/ stub (no lib/).
    // Replace that stub with a symlink to the real extracted bundle.
    const memSrcLink = path.join(
      runtimeBaseDir,
      "src",
      "context",
      "memory",
      "edgeclaw-memory-core",
    );
    if (fsSync.existsSync(memSrcLink) && !fsSync.lstatSync(memSrcLink).isSymbolicLink()) {
      fsSync.rmSync(memSrcLink, { recursive: true });
    }
    linkDirectory(memSrcLink, memCoreDir);

    return {
      nodeBin: bundledBinary(path.join(resources, "node-bin"), "node"),
      bunBin: bundledBinary(path.join(resources, "bun-bin"), "bun"),
      serverEntry: path.join(pilotDeckUiDir, "server", "index.js"),
      serverCwd: pilotDeckUiDir,
      pilotDeckMainDir,
    };
  }

  // ───────────────────────── Orphan-process cleanup ───────────────────────
  //
  // The pilotdeckui server spawns a Bun "cron daemon" as a *detached* sibling
  // (so multiple UI servers across different windows can share state) AND a
  // Bun "proxy" child that listens on PROXY_PORT. Neither is automatically
  // killed when our top-level Node child dies; both can leak across app
  // restarts.
  //
  // We clean up in two places:
  //   • before each spawn (`cleanupOrphanRuntimeProcesses`) so a fresh start
  //     never silently reuses a stale upstream
  //   • after `stop()` so quitting Electron leaves no background processes
  //
  // Strategy: read the cron-daemon `owner.json` for a recorded processId, and
  // probe PROXY_PORT for whoever is listening. Both go through SIGTERM with a
  // short grace period before SIGKILL.

  private async killPidGracefully(pid: number): Promise<void> {
    if (!processExists(pid)) return;
    try {
      process.kill(pid, "SIGTERM");
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === "ESRCH") return;
    }
    await waitForProcessExit(pid, ORPHAN_TERM_WAIT_MS);
    if (processExists(pid)) {
      forceKillPid(pid);
    }
  }

  /**
   * Politely shut down the bun cron-daemon via its UNIX socket protocol.
   * Returns true if the daemon acknowledged shutdown (or wasn't running).
   *
   * NOTE: owner.json.processId records the *ui-server* PID (the process that
   * spawned the daemon), NOT the daemon's own PID, so we can't just kill it.
   * The daemon listens on `~/.pilotdeck/cron-daemon.sock` and accepts a JSON
   * `{ type: "shutdown" }` request which triggers its own clean exit.
   */
  private async shutdownCronDaemonViaSocket(): Promise<boolean> {
    const socketPath = getCronDaemonSocketPath();
    if (!fsSync.existsSync(socketPath)) return true;
    return await new Promise<boolean>((resolve) => {
      const socket = net.createConnection(socketPath);
      let settled = false;
      let buffer = "";
      const finish = (ok: boolean): void => {
        if (settled) return;
        settled = true;
        socket.destroy();
        resolve(ok);
      };
      socket.setTimeout(2000, () => finish(false));
      socket.once("connect", () => {
        socket.write(JSON.stringify({ type: "shutdown" }) + "\n");
      });
      socket.once("data", (chunk) => {
        buffer += chunk.toString("utf8");
        const nl = buffer.indexOf("\n");
        if (nl < 0) return;
        try {
          const reply = JSON.parse(buffer.slice(0, nl)) as { ok?: boolean };
          finish(Boolean(reply.ok));
        } catch {
          finish(false);
        }
      });
      socket.once("error", () => finish(false));
    });
  }

  /**
   * pgrep-fallback: if the socket-based shutdown fails (daemon hung, socket
   * stale, etc.), find any bun process whose argv contains the unique
   * "daemonMain(['serve'])" snippet and SIGTERM/SIGKILL it.
   */
  private async killOrphanCronDaemonByPgrep(): Promise<void> {
    let out = "";
    try {
      if (process.platform === "win32") {
        // wmic is universally available on Windows; filter by command line.
        out = execSync(
          'wmic process where "CommandLine like \'%daemonMain%serve%\'" get ProcessId /format:list 2>NUL',
          { stdio: ["ignore", "pipe", "ignore"], timeout: 5000, shell: "cmd.exe" },
        ).toString("utf8");
      } else {
        out = execSync(
          `/usr/bin/pgrep -f "daemonMain\\(\\['serve'\\]\\)" || true`,
          { stdio: ["ignore", "pipe", "ignore"], timeout: 3000 },
        ).toString("utf8");
      }
    } catch {
      return;
    }
    const pids = out
      .split("\n")
      .map((s) => Number.parseInt(s.replace(/\D/g, ""), 10))
      .filter((n) => Number.isFinite(n) && n > 0 && n !== process.pid);
    for (const pid of pids) {
      await this.killPidGracefully(pid);
    }
  }

  private async killOrphanCronDaemon(): Promise<void> {
    const ok = await this.shutdownCronDaemonViaSocket();
    if (!ok) {
      await this.killOrphanCronDaemonByPgrep();
    }
  }

  private listenerPidForPort(port: number): number | null {
    try {
      let out: string;
      if (process.platform === "win32") {
        // netstat -ano gives lines like:  TCP  0.0.0.0:18790  0.0.0.0:0  LISTENING  1234
        const raw = execSync(`netstat -ano -p TCP`, {
          stdio: ["ignore", "pipe", "ignore"],
          timeout: 5000,
          shell: "cmd.exe",
        }).toString("utf8");
        const line = raw.split("\n").find(
          (l) => l.includes("LISTENING") && l.includes(`:${port} `),
        );
        if (!line) return null;
        const parts = line.trim().split(/\s+/);
        const pid = Number.parseInt(parts[parts.length - 1] ?? "", 10);
        return Number.isFinite(pid) && pid > 0 ? pid : null;
      }
      out = execSync(`/usr/sbin/lsof -nP -t -i :${port} -sTCP:LISTEN`, {
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 3000,
      })
        .toString("utf8")
        .trim();
      if (!out) return null;
      const first = Number.parseInt(out.split("\n")[0] ?? "", 10);
      return Number.isFinite(first) && first > 0 ? first : null;
    } catch {
      return null;
    }
  }

  private async killOrphanProxy(): Promise<void> {
    const pid = this.listenerPidForPort(PROXY_PORT);
    if (pid === null) return;
    // Avoid suicide: if the listener is the current process tree (shouldn't
    // happen, but be defensive), skip.
    if (pid === process.pid) return;
    await this.killPidGracefully(pid);
  }

  private async cleanupOrphanRuntimeProcesses(): Promise<void> {
    // Order: proxy first (its parent is the cron daemon's child of the
    // previous UI server), then cron daemon, then orphan gateway.
    await this.killOrphanProxy();
    await this.killOrphanCronDaemon();
    await this.killOrphanGateway();
  }

  private async killOrphanGateway(): Promise<void> {
    const pid = this.listenerPidForPort(GATEWAY_PORT);
    if (pid === null) return;
    if (pid === process.pid) return;
    await this.killPidGracefully(pid);
  }

  private clearStableTimer(): void {
    if (this.stableTimer !== null) {
      clearTimeout(this.stableTimer);
      this.stableTimer = null;
    }
  }

  private scheduleStableReset(): void {
    this.clearStableTimer();
    this.stableTimer = setTimeout(() => {
      this.stableTimer = null;
      this.restartAttempts = 0;
    }, STABLE_RUN_RESET_MS);
  }

  private attachExitWatchdog(): void {
    if (!this.child || this.exitHandlerBound) return;
    this.exitHandlerBound = true;
    this.child.once("exit", (code, signal) => {
      this.exitHandlerBound = false;
      this.child = null;
      this.clearStableTimer();

      if (this.stopRequested) return;

      // While the very first start is still pending, let the outer
      // startProcessAndWaitReady -> waitForServerHealth() short-circuit
      // path surface the failure (it already collects the log tail and
      // throws via start() -> caller). Skipping watchdog work here keeps
      // us from emitting a duplicate "error" event before the caller's
      // try/catch attaches its handler, and from spawning concurrent
      // restart attempts that race the still-pending health poll loop.
      if (this.initialStartInFlight) return;

      const err = new Error(
        `Server exited unexpectedly (code=${code ?? "null"}, signal=${signal ?? "null"})`,
      );
      this.emit("error", err);

      if (this.restartAttempts >= MAX_RESTART_ATTEMPTS) {
        this.emit("max-restarts");
        this.port = null;
        return;
      }

      const attempt = this.restartAttempts + 1;
      this.emit("restarting", attempt);
      const delay =
        RESTART_BACKOFF_MS[Math.min(attempt - 1, RESTART_BACKOFF_MS.length - 1)] ??
        RESTART_BACKOFF_MS[RESTART_BACKOFF_MS.length - 1];

      void (async () => {
        await sleep(delay);
        if (this.stopRequested) return;
        this.restartAttempts = attempt;
        try {
          const { port } = await this.startProcessAndWaitReady();
          this.port = port;
          this.emit("ready", port);
          this.scheduleStableReset();
        } catch (e: unknown) {
          this.emit("error", e instanceof Error ? e : new Error(String(e)));
          this.port = null;
        }
      })();
    });
  }

  private async writePidFile(pid: number): Promise<void> {
    await ensurePilotDeckDir();
    await fs.writeFile(getPidFilePath(), `${pid}\n`, "utf8");
  }

  private async removePidFile(): Promise<void> {
    try {
      await fs.unlink(getPidFilePath());
    } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
    }
  }

  private async startProcessAndWaitReady(): Promise<{ port: number }> {
    await cleanupStaleOrOrphanPid();
    // Kill leftover proxy/cron-daemon from a previous (crashed or
    // SIGKILL'd-by-Activity-Monitor) run. ensurePilotDeckProxyRunning() in the
    // ui server otherwise short-circuits when port 18080 is occupied and
    // never gets a chance to attach its stdout pipe, so logs from the stale
    // proxy never reach desktop.server.log.
    await this.cleanupOrphanRuntimeProcesses();

    const chosenPort = await pickAvailablePort();
    // NOTE: proxy port is intentionally NOT overridden here. pilotdeckui
    // spawns proxy.ts as a subprocess (in pilotdeck-main) which loads its
    // own config from ~/.pilotdeck/pilotdeck.yaml. If we set PILOTDECK_PROXY_PORT
    // here, the parent server waits on the new port but the spawned proxy.ts
    // still binds runtime.proxyPort from yaml → mismatch. Leave proxy port
    // to YAML so parent + child agree.
    this.emit("progress", "配置运行环境…");
    const { nodeBin, bunBin, serverEntry, serverCwd, pilotDeckMainDir } =
      await this.resolvePaths();

    if (!fsSync.existsSync(nodeBin)) {
      throw new Error(`Bundled Node not found at ${nodeBin}`);
    }
    if (!fsSync.existsSync(serverEntry)) {
      throw new Error(`Server entry not found at ${serverEntry}`);
    }

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NO_COLOR: "1",
      FORCE_COLOR: "0",
      PILOTDECK_DESKTOP: "1",
      SERVER_PORT: String(chosenPort),
      // Force loopback regardless of what runtime.host says in YAML.
      // pilotdeckui's buildRuntimeEnv now respects pre-set env vars.
      HOST: "127.0.0.1",
      // Ensure spawned `bun` subprocess (pilotdeck-main cli.tsx) finds the bundled bun
      BUN_BIN: bunBin,
      // Tell pilotdeckui where pilotdeck-main lives
      PILOTDECK_MAIN_DIR: pilotDeckMainDir,
      // Prepend bundled Node + Bun to PATH so any indirect lookups resolve our binaries
      PATH: `${path.dirname(nodeBin)}${path.delimiter}${path.dirname(bunBin)}${path.delimiter}${
        process.env.PATH ?? ""
      }`,
      // Reasoning-friendly default. Anything already present (env passthrough
      // from launchctl, user shell, or buildRuntimeEnv() reading
      // agents.main.params.maxOutputTokens) wins via the spread above… except
      // process.env doesn't normally carry this var, so this default applies
      // unless overridden. See REASONING_FRIENDLY_MAX_OUTPUT_TOKENS docstring.
      PILOTDECK_MAX_OUTPUT_TOKENS:
        process.env.PILOTDECK_MAX_OUTPUT_TOKENS ??
        REASONING_FRIENDLY_MAX_OUTPUT_TOKENS,
    };

    // Mirror server stdout/stderr to ~/.pilotdeck/desktop.server.log so failures
    // are diagnosable even when the user launches via Finder/Dock (no terminal).
    await ensurePilotDeckDir();
    const logPath = getServerLogPath();
    const logStream = fsSync.createWriteStream(logPath, { flags: "a" });

    // --- Start the Gateway process (port 18789) BEFORE the UI server ---
    // The UI server's pilotdeck-bridge connects to ws://127.0.0.1:18789/ws
    // within 30s. We must have the gateway listening before the UI server
    // attempts its first WebSocket handshake.
    const gatewayEntry = path.join(
      pilotDeckMainDir,
      "dist",
      "src",
      "cli",
      "pilotdeck.js",
    );
    if (fsSync.existsSync(gatewayEntry)) {
      this.emit("progress", "启动 PilotDeck Gateway…");
      const gwLogStream = fsSync.createWriteStream(logPath, { flags: "a" });
      gwLogStream.write(
        `\n=== ${new Date().toISOString()} spawn gateway ${gatewayEntry} (port=${GATEWAY_PORT}) ===\n`,
      );
      const gwChild = spawn(nodeBin, [gatewayEntry, "server"], {
        stdio: ["ignore", "pipe", "pipe"],
        cwd: pilotDeckMainDir,
        env: {
          ...env,
          PILOTDECK_GATEWAY_PORT: String(GATEWAY_PORT),
        },
        windowsHide: true,
      });
      gwChild.stdout?.pipe(gwLogStream, { end: false });
      gwChild.stderr?.pipe(gwLogStream, { end: false });
      gwChild.once("exit", () => {
        gwLogStream.end();
      });
      this.gatewayChild = gwChild;

      // Wait for gateway to start listening
      const gwDeadline = Date.now() + GATEWAY_STARTUP_TIMEOUT_MS;
      let gwReady = false;
      while (Date.now() < gwDeadline) {
        if (gwChild.exitCode !== null) break;
        const pid = this.listenerPidForPort(GATEWAY_PORT);
        if (pid !== null) {
          gwReady = true;
          break;
        }
        await sleep(HEALTH_POLL_MS);
      }
      if (!gwReady) {
        gwChild.kill("SIGTERM");
        this.gatewayChild = null;
        const tail = readTailSafe(logPath, 4000);
        throw new Error(
          `Gateway failed to start on port ${GATEWAY_PORT} within ${GATEWAY_STARTUP_TIMEOUT_MS}ms\n--- log tail ---\n${tail}`,
        );
      }
    }

    logStream.write(
      `\n=== ${new Date().toISOString()} spawn ${serverEntry} (port=${chosenPort}) ===\n`,
    );

    const child = spawn(nodeBin, [serverEntry], {
      stdio: ["ignore", "pipe", "pipe"],
      cwd: serverCwd,
      env,
      windowsHide: true,
    });

    if (!child.pid) {
      logStream.end();
      throw new Error("Failed to spawn server process");
    }

    child.stdout?.pipe(logStream, { end: false });
    child.stderr?.pipe(logStream, { end: false });
    child.once("exit", () => {
      logStream.end();
    });

    this.child = child;
    this.exitHandlerBound = false;
    this.attachExitWatchdog();

    await this.writePidFile(child.pid);

    this.emit("progress", "启动本地服务…");
    try {
      await waitForServerHealth(chosenPort, child);
    } catch (err) {
      this.stopRequested = true;
      await this.killChildGracefully();
      await this.removePidFile();
      this.child = null;
      this.stopRequested = false;
      const tail = readTailSafe(logPath, 4000);
      throw new Error(
        `${err instanceof Error ? err.message : String(err)}\n--- server log tail (${logPath}) ---\n${tail}`,
      );
    }

    return { port: chosenPort };
  }

  private async killChildGracefully(): Promise<void> {
    const proc = this.child;
    if (!proc || !proc.pid) return;
    const pid = proc.pid;

    try {
      proc.kill("SIGTERM");
    } catch {
      /* ignore */
    }

    const deadline = Date.now() + SHUTDOWN_SIGTERM_WAIT_MS;
    while (Date.now() < deadline) {
      if (!processExists(pid)) return;
      await sleep(50);
    }

    if (processExists(pid)) {
      forceKillPid(pid);
    }
  }

  start(): Promise<{ port: number }> {
    if (this.startPromise) return this.startPromise;

    this.stopRequested = false;
    this.restartAttempts = 0;
    this.initialStartInFlight = true;

    this.startPromise = (async () => {
      try {
        const { port } = await this.startProcessAndWaitReady();
        this.port = port;
        this.initialStartInFlight = false;
        this.emit("ready", port);
        this.scheduleStableReset();
        return { port };
      } catch (e: unknown) {
        this.initialStartInFlight = false;
        const err = e instanceof Error ? e : new Error(String(e));
        this.emit("error", err);
        throw err;
      } finally {
        this.startPromise = null;
      }
    })();

    return this.startPromise;
  }

  async stop(): Promise<void> {
    this.stopRequested = true;
    this.clearStableTimer();
    this.child?.removeAllListeners("exit");

    await this.killChildGracefully();
    this.child = null;
    this.port = null;

    // Stop the gateway process
    await this.killGatewayGracefully();
    this.gatewayChild = null;

    await this.removePidFile();
    // The ui-server's SIGTERM handler stops the proxy and (after our
    // pilotdeckConfig.js patch) the cron daemon. As a belt-and-suspenders
    // safety net — in case the parent died via SIGKILL, hung past the SIGTERM
    // grace, or the user used `kill -9` from Activity Monitor — sweep any
    // remaining orphans now so quitting PilotDeck really leaves zero processes.
    await this.cleanupOrphanRuntimeProcesses();
    this.stopRequested = false;
  }

  private async killGatewayGracefully(): Promise<void> {
    const proc = this.gatewayChild;
    if (!proc || !proc.pid) return;
    const pid = proc.pid;

    try {
      proc.kill("SIGTERM");
    } catch {
      /* ignore */
    }

    const deadline = Date.now() + SHUTDOWN_SIGTERM_WAIT_MS;
    while (Date.now() < deadline) {
      if (!processExists(pid)) return;
      await sleep(50);
    }

    if (processExists(pid)) {
      forceKillPid(pid);
    }
  }

  getPort(): number | null {
    return this.port;
  }

  isRunning(): boolean {
    const c = this.child;
    return c !== null && c.exitCode === null && c.signalCode === null;
  }
}
