import { app, BrowserWindow, ipcMain, Menu, shell } from "electron";
import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

type ManagedProcess = {
  name: string;
  child: ChildProcess;
};

type RuntimeInfo = {
  serverPort: number;
  gatewayPort: number;
  gateway: GatewayRuntimeState;
  runtimeRoot: string;
  logPath: string;
};

type GatewayRuntimeState =
  | { state: "stopped" | "starting" | "ready" }
  | { state: "error"; error: string };

type ModelConfigurationState = {
  state: "needs_configuration" | "ready" | "invalid";
  revision?: string;
};

type BundledGitPaths = {
  root: string;
  bash: string;
  git: string;
  pathEntries: string[];
};

type RuntimeStatus = {
  phase: "starting" | "config" | "server" | "awaiting_configuration" | "gateway" | "ready" | "error" | "stopped";
  message: string;
  logPath?: string;
  error?: string;
};

let mainWindow: BrowserWindow | null = null;
let runtime: RuntimeManager | null = null;
let isQuitting = false;
let runtimeStartPromise: Promise<RuntimeInfo> | null = null;
let lastRuntimeStatus: RuntimeStatus | null = null;

const APP_ID = "cn.pilotdeck.desktop";
const EXTERNAL_NAVIGATION_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);
const PLAYWRIGHT_BROWSER_DIR = "playwright-browsers";
const DEFAULT_UPDATE_REPOSITORY = "OpenBMB/PilotDeck";

type BuildMetadata = {
  version?: string;
  buildTime?: string;
  releaseDate?: string;
  commitSha?: string;
  repository?: string;
};

class RuntimeManager {
  private readonly processes: ManagedProcess[] = [];
  private readonly expectedExits = new WeakSet<ChildProcess>();
  private readonly logPath: string;
  private logStream: fs.WriteStream | null = null;
  private info: RuntimeInfo | null = null;
  private serverProcess: ChildProcess | null = null;
  private gatewayProcess: ChildProcess | null = null;
  private gatewayStartPromise: Promise<void> | null = null;
  private gatewayStopPromise: Promise<void> | null = null;
  private commonEnv: NodeJS.ProcessEnv | null = null;
  private pilotHome: string | null = null;
  private gatewayPort: number | null = null;
  private configurationState: ModelConfigurationState | null = null;
  private gatewayState: GatewayRuntimeState = { state: "stopped" };
  private stopping = false;

  constructor(
    private readonly runtimeRoot: string,
    private readonly nodeBinary: string,
  ) {
    app.setAppLogsPath(path.join(app.getPath("userData"), "logs"));
    this.logPath = path.join(app.getPath("logs"), "runtime.log");
  }

  getInfo(): RuntimeInfo | null {
    return this.info;
  }

  getLogPath(): string {
    return this.logPath;
  }

  async start(): Promise<RuntimeInfo> {
    this.stopping = false;
    fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
    this.logStream = fs.createWriteStream(this.logPath, { flags: "a" });
    publishRuntimeStatus({
      phase: "starting",
      message: "Preparing PilotDeck runtime...",
      logPath: this.logPath,
    });
    this.log(`PilotDeck Desktop runtime starting from ${this.runtimeRoot}`);
    publishRuntimeStatus({
      phase: "config",
      message: "Checking local configuration...",
      logPath: this.logPath,
    });
    const config = ensurePilotHome((message) => this.log(message));

    const serverPort = await findFreePort(3001);
    const gatewayPort = await findFreePort(18789);
    const bundledGit = resolveBundledGitPaths();
    if (bundledGit) {
      this.log(`Bundled Git Bash ready: ${bundledGit.bash}`);
    }
    const playwrightBrowsersPath = resolvePlaywrightBrowsersPath(this.runtimeRoot);
    const buildMetadata = readBuildMetadata();
    this.log(`Playwright browsers path: ${playwrightBrowsersPath}`);
    const commonEnv = withRuntimeCommandPath({
      ...process.env,
      HOME: process.env.HOME || os.homedir(),
      HOST: "127.0.0.1",
      PILOTDECK_RUNTIME_ROOT: this.runtimeRoot,
      PILOTDECK_DESKTOP_RUNTIME_ROOT: this.runtimeRoot,
      PILOT_HOME: config.pilotHome,
      PILOTDECK_CONFIG_DIR: config.pilotHome,
      SERVER_PORT: String(serverPort),
      PILOTDECK_GATEWAY_PORT: String(gatewayPort),
      PILOTDECK_GATEWAY_URL: `ws://127.0.0.1:${gatewayPort}/ws`,
      PILOTDECK_DESKTOP: "1",
      PILOTDECK_DESKTOP_VERSION: app.getVersion(),
      PILOTDECK_VERSION: app.getVersion(),
      PILOTDECK_DESKTOP_BUILD_TIME: buildMetadata.buildTime,
      PILOTDECK_COMMIT_SHA: buildMetadata.commitSha,
      PILOTDECK_GIT_SHA: buildMetadata.commitSha,
      PILOTDECK_UPDATE_REPOSITORY:
        process.env.PILOTDECK_UPDATE_REPOSITORY || buildMetadata.repository || DEFAULT_UPDATE_REPOSITORY,
      PILOTDECK_DISABLE_LOCAL_AUTH: process.env.PILOTDECK_DISABLE_LOCAL_AUTH || "1",
      PILOTDECK_SKIP_BROWSER_OPEN: "1",
      PILOTDECK_SKIP_DEFAULT_PROJECT: "1",
      PILOTDECK_RUNTIME_SUPERVISED: "1",
      PLAYWRIGHT_BROWSERS_PATH: playwrightBrowsersPath,
    }, this.runtimeRoot, this.nodeBinary, bundledGit);
    this.commonEnv = commonEnv;
    this.pilotHome = config.pilotHome;
    this.gatewayPort = gatewayPort;
    this.info = {
      serverPort,
      gatewayPort,
      gateway: this.gatewayState,
      runtimeRoot: this.runtimeRoot,
      logPath: this.logPath,
    };

    publishRuntimeStatus({
      phase: "server",
      message: "Starting Web UI server...",
      logPath: this.logPath,
    });
    const server = this.spawnRuntime(
      "server",
      this.serverCommand(),
      path.join(this.runtimeRoot, "ui"),
      commonEnv,
      { ipc: true, critical: true },
    );
    this.serverProcess = server;
    server.on("message", (message) => this.handleServerMessage(message));
    await waitForPortOrProcessExit(server, "server", serverPort, "127.0.0.1", 90_000, this.logPath);

    this.log(`PilotDeck Web UI ready: http://127.0.0.1:${serverPort}`);
    if (!this.configurationState || this.configurationState.state !== "ready") {
      publishRuntimeStatus({
        phase: "awaiting_configuration",
        message: "PilotDeck is ready for model setup.",
        logPath: this.logPath,
      });
    }
    return this.info;
  }

  async stop(): Promise<void> {
    this.stopping = true;
    await this.gatewayStopPromise?.catch(() => undefined);
    this.serverProcess = null;
    this.gatewayProcess = null;
    this.gatewayStartPromise = null;
    for (const proc of [...this.processes].reverse()) {
      this.expectedExits.add(proc.child);
      await killProcessTree(proc.child).catch((error) => {
        this.log(`Failed to stop ${proc.name}: ${String(error)}`);
      });
    }
    this.processes.length = 0;
    this.log("PilotDeck Desktop runtime stopped");
    this.logStream?.end();
    this.logStream = null;
    this.info = null;
    this.commonEnv = null;
    this.pilotHome = null;
    this.gatewayPort = null;
    this.gatewayStopPromise = null;
    this.configurationState = null;
    this.gatewayState = { state: "stopped" };
    publishRuntimeStatus({
      phase: "stopped",
      message: "PilotDeck runtime stopped.",
      logPath: this.logPath,
    });
  }

  private gatewayCommand(): string[] {
    const builtEntry = path.join(this.runtimeRoot, "dist", "src", "cli", "pilotdeck.js");
    if (fs.existsSync(builtEntry)) {
      return [this.nodeBinary, builtEntry, "server"];
    }
    if (app.isPackaged || process.env.PILOTDECK_DESKTOP_RUNTIME_ROOT) {
      throw new Error(`Compiled PilotDeck gateway entry not found: ${builtEntry}`);
    }
    return [this.nodeBinary, "--import", "tsx", path.join(this.runtimeRoot, "src", "cli", "pilotdeck.ts"), "server"];
  }

  private serverCommand(): string[] {
    if (app.isPackaged || process.env.PILOTDECK_DESKTOP_RUNTIME_ROOT) {
      return [this.nodeBinary, "server/index.js"];
    }
    return [this.nodeBinary, "--import", "tsx", "server/index.js"];
  }

  private spawnRuntime(
    name: string,
    command: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
    options: { ipc?: boolean; critical?: boolean } = {},
  ): ChildProcess {
    const [bin, ...args] = command;
    if (!bin) throw new Error(`Missing command for ${name}`);
    const child = spawn(bin, args, {
      cwd,
      env,
      stdio: options.ipc
        ? ["ignore", "pipe", "pipe", "ipc"]
        : ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: process.platform === "win32",
    });
    this.processes.push({ name, child });
    this.log(`[${name}] spawn ${bin} ${args.join(" ")}`);

    child.stdout?.on("data", (chunk: Buffer) => this.logChunk(name, chunk));
    child.stderr?.on("data", (chunk: Buffer) => this.logChunk(name, chunk));
    child.on("exit", (code, signal) => {
      const index = this.processes.findIndex((process) => process.child === child);
      if (index >= 0) this.processes.splice(index, 1);
      this.log(`[${name}] exited code=${code ?? "null"} signal=${signal ?? "null"}`);
      if (this.expectedExits.delete(child)) return;
      if (name === "gateway" && this.gatewayProcess === child) {
        this.gatewayProcess = null;
        if (!isQuitting) {
          const detail = `Gateway exited code=${code ?? "null"} signal=${signal ?? "null"}`;
          this.setGatewayState({ state: "error", error: detail });
          publishRuntimeStatus({
            phase: "error",
            message: "Gateway exited unexpectedly. The Web UI is still available.",
            logPath: this.logPath,
            error: detail,
          });
        }
        return;
      }
      if (!isQuitting && this.info && options.critical) {
        publishRuntimeStatus({
          phase: "error",
          message: `${name} exited unexpectedly. See runtime log for details.`,
          logPath: this.logPath,
          error: `${name} exited code=${code ?? "null"} signal=${signal ?? "null"}`,
        });
      }
    });
    return child;
  }

  private handleServerMessage(message: unknown): void {
    if (!message || typeof message !== "object" || !("type" in message)) return;
    const runtimeMessage = message as {
      type?: string;
      configuration?: ModelConfigurationState;
    };
    if (runtimeMessage.type === "pilotdeck:configuration-state" && runtimeMessage.configuration) {
      this.configurationState = runtimeMessage.configuration;
      if (runtimeMessage.configuration.state === "ready") {
        void this.startGateway();
      } else {
        void this.stopGateway();
        publishRuntimeStatus({
          phase: "awaiting_configuration",
          message: runtimeMessage.configuration.state === "invalid"
            ? "Model configuration needs attention."
            : "PilotDeck is ready for model setup.",
          logPath: this.logPath,
        });
      }
      return;
    }
    if (runtimeMessage.type === "pilotdeck:retry-gateway" && this.configurationState?.state === "ready") {
      void this.stopGateway().then(() => this.startGateway());
    }
  }

  private startGateway(): Promise<void> {
    if (this.stopping || this.configurationState?.state !== "ready") return Promise.resolve();
    if (this.gatewayStopPromise) {
      return this.gatewayStopPromise.then(() => this.startGateway());
    }
    if (this.gatewayProcess && this.gatewayProcess.exitCode === null) return Promise.resolve();
    if (this.gatewayStartPromise) return this.gatewayStartPromise;

    this.gatewayStartPromise = this.launchGateway().finally(() => {
      this.gatewayStartPromise = null;
      if (
        this.configurationState?.state === "ready"
        && this.gatewayState.state === "stopped"
        && !this.gatewayProcess
      ) {
        void this.startGateway();
      }
    });
    return this.gatewayStartPromise;
  }

  private async launchGateway(): Promise<void> {
    if (!this.commonEnv || !this.pilotHome || !this.gatewayPort) return;
    this.setGatewayState({ state: "starting" });
    publishRuntimeStatus({
      phase: "gateway",
      message: "Starting local gateway...",
      logPath: this.logPath,
    });

    let gateway: ChildProcess | null = null;
    try {
      gateway = this.spawnRuntime(
        "gateway",
        this.gatewayCommand(),
        this.pilotHome,
        this.commonEnv,
      );
      this.gatewayProcess = gateway;
      await waitForPortOrProcessExit(
        gateway,
        "gateway",
        this.gatewayPort,
        "127.0.0.1",
        90_000,
        this.logPath,
      );
      if (this.gatewayProcess !== gateway) return;
      this.setGatewayState({ state: "ready" });
      publishRuntimeStatus({
        phase: "ready",
        message: "PilotDeck is ready.",
        logPath: this.logPath,
      });
    } catch (error) {
      if (gateway && this.gatewayProcess !== gateway) return;
      if (gateway && this.gatewayProcess === gateway) {
        this.gatewayProcess = null;
        this.expectedExits.add(gateway);
        await killProcessTree(gateway).catch(() => undefined);
      }
      const detail = error instanceof Error ? error.message : String(error);
      this.log(`Gateway failed to start: ${detail}`);
      this.setGatewayState({ state: "error", error: detail });
      publishRuntimeStatus({
        phase: "error",
        message: "Gateway failed to start. The Web UI is still available.",
        logPath: this.logPath,
        error: detail,
      });
    }
  }

  private async stopGateway(): Promise<void> {
    if (this.gatewayStopPromise) return this.gatewayStopPromise;
    const gateway = this.gatewayProcess;
    this.gatewayProcess = null;
    this.gatewayStopPromise = (async () => {
      if (gateway) {
        this.expectedExits.add(gateway);
        await killProcessTree(gateway).catch(() => undefined);
      }
      this.setGatewayState({ state: "stopped" });
    })().finally(() => {
      this.gatewayStopPromise = null;
    });
    return this.gatewayStopPromise;
  }

  private setGatewayState(state: GatewayRuntimeState): void {
    this.gatewayState = state;
    if (this.info) this.info.gateway = state;
    const server = this.serverProcess;
    if (!server || !server.connected) return;
    server.send({
      type: "pilotdeck:gateway-state",
      ...state,
    }, (error) => {
      if (error) this.log(`Failed to publish Gateway state: ${error.message}`);
    });
  }

  private logChunk(name: string, chunk: Buffer): void {
    const text = chunk.toString("utf8");
    for (const line of text.split(/\r?\n/)) {
      if (line.trim()) this.log(`[${name}] ${line}`);
    }
  }

  private log(message: string): void {
    const line = `${new Date().toISOString()} ${message}${os.EOL}`;
    this.logStream?.write(line);
    if (!app.isPackaged) process.stdout.write(line);
  }
}

async function ensureRuntime(): Promise<RuntimeInfo> {
  if (runtime?.getInfo()) {
    return runtime.getInfo()!;
  }
  if (runtimeStartPromise) {
    return runtimeStartPromise;
  }
  const runtimeRoot = resolveRuntimeRoot();
  const nodeBinary = resolveNodeBinary();
  runtime = new RuntimeManager(runtimeRoot, nodeBinary);
  runtimeStartPromise = runtime.start().finally(() => {
    runtimeStartPromise = null;
  });
  return runtimeStartPromise;
}

async function createOrShowWindow(): Promise<void> {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.show();
    mainWindow.focus();
    return;
  }

  const icon = resolveAppIcon();

  if (process.platform === "win32") {
    Menu.setApplicationMenu(null);
  }

  mainWindow = new BrowserWindow({
    width: 1320,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    title: "PilotDeck",
    ...(icon ? { icon } : {}),
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    openExternalNavigation(url);
    return { action: "deny" };
  });

  mainWindow.webContents.on("will-navigate", (event, url) => {
    if (!shouldOpenInSystemBrowser(url)) return;
    event.preventDefault();
    openExternalNavigation(url);
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });

  await mainWindow.webContents.session.clearCache();
  await mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(renderLoadingHtml())}`);
  if (lastRuntimeStatus) {
    sendRuntimeStatus(lastRuntimeStatus);
  }
}

async function loadRuntimeUrl(info: RuntimeInfo): Promise<void> {
  if (!mainWindow || mainWindow.isDestroyed()) {
    await createOrShowWindow();
  }
  if (!mainWindow || mainWindow.isDestroyed()) return;
  await mainWindow.loadURL(`http://127.0.0.1:${info.serverPort}`);
}

function publishRuntimeStatus(status: RuntimeStatus): void {
  lastRuntimeStatus = status;
  sendRuntimeStatus(status);
}

function sendRuntimeStatus(status: RuntimeStatus): void {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  mainWindow.webContents.send("pilotdeck:runtime-status", status);
}

function shouldOpenInSystemBrowser(rawUrl: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return false;
  }

  if (!EXTERNAL_NAVIGATION_PROTOCOLS.has(parsed.protocol)) {
    return false;
  }

  const info = runtime?.getInfo();
  const isLoopbackHost =
    parsed.hostname === "127.0.0.1" ||
    parsed.hostname === "localhost" ||
    parsed.hostname === "[::1]" ||
    parsed.hostname === "::1";
  if (info && isLoopbackHost && parsed.port === String(info.serverPort)) {
    return false;
  }

  return true;
}

function openExternalNavigation(rawUrl: string): boolean {
  if (!shouldOpenInSystemBrowser(rawUrl)) {
    return false;
  }
  void shell.openExternal(rawUrl);
  return true;
}

async function startRuntimeAndLoad(): Promise<void> {
  try {
    const info = await ensureRuntime();
    await loadRuntimeUrl(info);
  } catch (error) {
    const detail = error instanceof Error ? error.stack ?? error.message : String(error);
    publishRuntimeStatus({
      phase: "error",
      message: "PilotDeck failed to start.",
      logPath: runtime?.getLogPath(),
      error: detail,
    });
  }
}

async function retryRuntime(): Promise<void> {
  const currentRuntime = runtime;
  runtime = null;
  runtimeStartPromise = null;
  if (currentRuntime) {
    await currentRuntime.stop().catch(() => undefined);
  }
  if (!mainWindow || mainWindow.isDestroyed()) {
    await createOrShowWindow();
  } else {
    await mainWindow.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(renderLoadingHtml())}`);
  }
  await startRuntimeAndLoad();
}

function renderLoadingHtml(): string {
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>PilotDeck</title>
  <style>
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      display: grid;
      place-items: center;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: #0e1116;
      color: #eef2f8;
    }
    main {
      width: min(520px, calc(100vw - 48px));
      display: grid;
      gap: 18px;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 12px;
      font-size: 22px;
      font-weight: 650;
      letter-spacing: 0;
    }
    .mark {
      width: 34px;
      height: 34px;
      border-radius: 8px;
      display: grid;
      place-items: center;
      background: #f2f6ff;
      color: #0e1116;
      font-weight: 800;
    }
    .panel {
      border: 1px solid rgba(255,255,255,0.14);
      border-radius: 8px;
      padding: 22px;
      background: rgba(255,255,255,0.045);
      box-shadow: 0 18px 60px rgba(0,0,0,0.35);
    }
    .row {
      display: flex;
      align-items: center;
      gap: 12px;
    }
    .spinner {
      width: 18px;
      height: 18px;
      border: 2px solid rgba(255,255,255,0.25);
      border-top-color: #eef2f8;
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
      flex: 0 0 auto;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    #message {
      margin: 0;
      font-size: 15px;
      line-height: 1.45;
      color: #d8dee9;
    }
    #detail {
      display: none;
      margin: 14px 0 0;
      padding: 12px;
      max-height: 180px;
      overflow: auto;
      white-space: pre-wrap;
      border-radius: 6px;
      background: rgba(0,0,0,0.32);
      color: #f4c7c7;
      font: 12px/1.45 ui-monospace, SFMono-Regular, Consolas, monospace;
    }
    #log {
      margin-top: 12px;
      color: #9ca8b8;
      font-size: 12px;
      word-break: break-all;
    }
    .actions {
      display: none;
      gap: 10px;
      margin-top: 16px;
    }
    button {
      appearance: none;
      border: 1px solid rgba(255,255,255,0.18);
      border-radius: 7px;
      padding: 8px 12px;
      background: #f2f6ff;
      color: #0e1116;
      font: inherit;
      font-size: 13px;
      cursor: pointer;
    }
    button.secondary {
      background: transparent;
      color: #eef2f8;
    }
    .error .spinner { display: none; }
    .error #detail,
    .error .actions { display: flex; }
    .error #detail { display: block; }
  </style>
</head>
<body>
  <main>
    <div class="brand"><div class="mark">P</div><div>PilotDeck</div></div>
    <section class="panel" id="panel">
      <div class="row">
        <div class="spinner" aria-hidden="true"></div>
        <p id="message">Preparing PilotDeck runtime...</p>
      </div>
      <pre id="detail"></pre>
      <div id="log"></div>
      <div class="actions">
        <button id="retry">Retry</button>
        <button id="openLog" class="secondary">Open Log</button>
      </div>
    </section>
  </main>
  <script>
    const panel = document.getElementById("panel");
    const message = document.getElementById("message");
    const detail = document.getElementById("detail");
    const log = document.getElementById("log");
    const retry = document.getElementById("retry");
    const openLog = document.getElementById("openLog");

    window.pilotdeckDesktop?.onRuntimeStatus((status) => {
      message.textContent = status.message || "Starting PilotDeck...";
      log.textContent = status.logPath ? "Log: " + status.logPath : "";
      if (status.phase === "error") {
        panel.classList.add("error");
        detail.textContent = status.error || status.message || "Unknown startup error.";
      } else {
        panel.classList.remove("error");
        detail.textContent = "";
      }
    });
    retry.addEventListener("click", () => window.pilotdeckDesktop?.retryRuntime());
    openLog.addEventListener("click", () => window.pilotdeckDesktop?.openRuntimeLog());
  </script>
</body>
</html>`;
}

function resolveRuntimeRoot(): string {
  if (process.env.PILOTDECK_DESKTOP_RUNTIME_ROOT) {
    return path.resolve(process.env.PILOTDECK_DESKTOP_RUNTIME_ROOT);
  }
  if (app.isPackaged) {
    return path.join(process.resourcesPath, "runtime");
  }
  return path.resolve(__dirname, "..", "..", "..");
}

function resolveNodeBinary(): string {
  if (process.env.PILOTDECK_DESKTOP_NODE) {
    return process.env.PILOTDECK_DESKTOP_NODE;
  }
  if (!app.isPackaged) {
    return process.platform === "win32" ? "node.exe" : "node";
  }
  const nodeRoot = path.join(process.resourcesPath, "node");
  const binary = process.platform === "win32"
    ? path.join(nodeRoot, "node.exe")
    : path.join(nodeRoot, "bin", "node");
  if (!fs.existsSync(binary)) {
    throw new Error(`Bundled Node runtime not found: ${binary}`);
  }
  return binary;
}

function resolveBundledGitPaths(): BundledGitPaths | undefined {
  if (process.platform !== "win32") {
    return undefined;
  }

  const configuredRoot = process.env.PILOTDECK_DESKTOP_GIT_ROOT
    ? path.resolve(process.env.PILOTDECK_DESKTOP_GIT_ROOT)
    : undefined;
  const root = configuredRoot
    ?? (app.isPackaged
      ? path.join(process.resourcesPath, "git")
      : path.resolve(__dirname, "..", "resources", "git"));
  const bash = path.join(root, "bin", "bash.exe");
  const git = path.join(root, "cmd", "git.exe");

  if (!fs.existsSync(bash) || !fs.existsSync(git)) {
    if (configuredRoot || app.isPackaged) {
      throw new Error(`Bundled Git Bash not found under ${root}`);
    }
    return undefined;
  }

  return {
    root,
    bash,
    git,
    pathEntries: [
      path.join(root, "cmd"),
      path.join(root, "bin"),
      path.join(root, "usr", "bin"),
      path.join(root, "mingw64", "bin"),
    ],
  };
}

function resolveAppIcon(): string | undefined {
  const fileName = process.platform === "win32" ? "icon.ico" : "icon.png";
  const iconPath = app.isPackaged
    ? path.join(process.resourcesPath, "icons", fileName)
    : path.resolve(__dirname, "..", "resources", "icons", fileName);
  return fs.existsSync(iconPath) ? iconPath : undefined;
}

function resolvePlaywrightBrowsersPath(runtimeRoot: string): string {
  if (hasBundledPlaywrightBrowser(runtimeRoot)) {
    return "0";
  }
  const browsersPath = path.join(app.getPath("userData"), PLAYWRIGHT_BROWSER_DIR);
  fs.mkdirSync(browsersPath, { recursive: true });
  return browsersPath;
}

function hasBundledPlaywrightBrowser(runtimeRoot: string): boolean {
  const browsersRoot = path.join(runtimeRoot, "node_modules", "playwright-core", ".local-browsers");
  let entries: string[];
  try {
    entries = fs.readdirSync(browsersRoot);
  } catch {
    return false;
  }
  return entries.some((entry) => {
    if (!/^chromium(?:-|_)/u.test(entry)) return false;
    return fs.existsSync(path.join(browsersRoot, entry, "INSTALLATION_COMPLETE"));
  });
}

function getPathEnvKey(env: NodeJS.ProcessEnv): string {
  if (process.platform !== "win32") return "PATH";
  return Object.keys(env).find((key) => key.toLowerCase() === "path") ?? "Path";
}

function withRuntimeCommandPath(
  env: NodeJS.ProcessEnv,
  runtimeRoot: string,
  nodeBinary: string,
  bundledGit?: BundledGitPaths,
): NodeJS.ProcessEnv {
  const pathKey = getPathEnvKey(env);
  const currentPath = env[pathKey] || "";
  const entries = [
    path.dirname(nodeBinary),
    ...(bundledGit?.pathEntries ?? []),
    path.join(runtimeRoot, "node_modules", ".bin"),
    currentPath,
  ].filter(Boolean);
  const nextEnv: NodeJS.ProcessEnv = {
    ...env,
    [pathKey]: entries.join(path.delimiter),
  };
  if (bundledGit) {
    nextEnv.PILOTDECK_GIT_BASH_PATH = bundledGit.bash;
    nextEnv.PILOTDECK_GIT_PATH = bundledGit.git;
    nextEnv.CHERE_INVOKING = nextEnv.CHERE_INVOKING || "1";
    nextEnv.MSYSTEM = nextEnv.MSYSTEM || "MINGW64";
  }
  return nextEnv;
}

function readBuildMetadata(): BuildMetadata {
  const metadataPath = app.isPackaged
    ? path.join(process.resourcesPath, "build-metadata.json")
    : path.resolve(__dirname, "..", "resources", "build-metadata.json");
  try {
    return JSON.parse(fs.readFileSync(metadataPath, "utf8")) as BuildMetadata;
  } catch {
    return {};
  }
}

function ensurePilotHome(log: (message: string) => void): { pilotHome: string } {
  const pilotHome = process.env.PILOT_HOME
    ? path.resolve(process.env.PILOT_HOME)
    : path.join(os.homedir(), ".pilotdeck");
  fs.mkdirSync(pilotHome, { recursive: true });
  log(`PilotDeck home ready at ${pilotHome}`);
  return { pilotHome };
}

function findFreePort(preferred: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", () => {
      const fallback = 20000 + Math.floor(Math.random() * 40000);
      findFreePort(fallback).then(resolve, reject);
    });
    server.once("listening", () => {
      const address = server.address();
      server.close(() => {
        resolve(typeof address === "object" && address ? address.port : preferred);
      });
    });
    server.listen(preferred, "127.0.0.1");
  });
}

function waitForPort(port: number, host: string, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const socket = net.createConnection({ host, port });
      socket.once("connect", () => {
        socket.end();
        resolve();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() - startedAt > timeoutMs) {
          reject(new Error(`Timed out waiting for ${host}:${port}`));
          return;
        }
        setTimeout(attempt, 250);
      });
    };
    attempt();
  });
}

function waitForPortOrProcessExit(
  child: ChildProcess,
  name: string,
  port: number,
  host: string,
  timeoutMs: number,
  logPath: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback: () => void) => {
      if (settled) return;
      settled = true;
      child.off("exit", onExit);
      callback();
    };
    const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
      finish(() => {
        reject(new Error(`${name} exited before it was ready (code=${code ?? "null"} signal=${signal ?? "null"}). See runtime log: ${logPath}`));
      });
    };
    child.once("exit", onExit);
    waitForPort(port, host, timeoutMs)
      .then(() => finish(resolve))
      .catch((error) => finish(() => reject(error)));
  });
}

function killProcessTree(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    let forceTimer: NodeJS.Timeout | undefined;
    let forceExitTimer: NodeJS.Timeout | undefined;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (forceTimer) clearTimeout(forceTimer);
      if (forceExitTimer) clearTimeout(forceExitTimer);
      resolve();
    };
    child.once("exit", finish);
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], {
        stdio: "ignore",
        windowsHide: true,
      })
        .once("exit", finish);
      return;
    }
    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    }
    forceTimer = setTimeout(() => {
      if (child.exitCode === null && child.pid) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          child.kill("SIGKILL");
        }
      }
      forceExitTimer = setTimeout(finish, 1000);
    }, 3000);
  });
}

ipcMain.handle("pilotdeck:get-runtime-info", () => runtime?.getInfo());
ipcMain.handle("pilotdeck:retry-runtime", () => retryRuntime());
ipcMain.handle("pilotdeck:open-runtime-log", async () => {
  const logPath = runtime?.getLogPath() ?? lastRuntimeStatus?.logPath;
  if (logPath) {
    await shell.openPath(logPath);
  }
});

if (process.platform === "win32") {
  app.setAppUserModelId(APP_ID);
}

app.whenReady()
  .then(createOrShowWindow)
  .then(startRuntimeAndLoad)
  .catch(async (error) => {
    const detail = error instanceof Error ? error.stack ?? error.message : String(error);
    await runtime?.stop().catch(() => undefined);
    publishRuntimeStatus({
      phase: "error",
      message: "PilotDeck failed to start.",
      logPath: runtime?.getLogPath(),
      error: detail,
    });
    app.quit();
  });

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("activate", () => {
  if (mainWindow === null || mainWindow.isDestroyed()) {
    createOrShowWindow()
      .then(startRuntimeAndLoad)
      .catch((error) => {
        const detail = error instanceof Error ? error.stack ?? error.message : String(error);
        publishRuntimeStatus({
          phase: "error",
          message: "PilotDeck failed to restore window.",
          logPath: runtime?.getLogPath(),
          error: detail,
        });
      });
  }
});

app.on("before-quit", (event) => {
  isQuitting = true;
  if (!runtime) return;
  event.preventDefault();
  const currentRuntime = runtime;
  runtime = null;
  currentRuntime.stop().finally(() => app.exit(0));
});
