import { app, BrowserWindow, dialog, ipcMain, shell } from "electron";
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
  runtimeRoot: string;
  logPath: string;
};

let mainWindow: BrowserWindow | null = null;
let runtime: RuntimeManager | null = null;
let isQuitting = false;

class RuntimeManager {
  private readonly processes: ManagedProcess[] = [];
  private readonly logPath: string;
  private logStream: fs.WriteStream | null = null;
  private info: RuntimeInfo | null = null;

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

  async start(): Promise<RuntimeInfo> {
    fs.mkdirSync(path.dirname(this.logPath), { recursive: true });
    this.logStream = fs.createWriteStream(this.logPath, { flags: "a" });
    this.log(`PilotDeck Desktop runtime starting from ${this.runtimeRoot}`);

    const serverPort = await findFreePort(3001);
    const gatewayPort = await findFreePort(18789);
    const commonEnv = {
      ...process.env,
      HOST: "127.0.0.1",
      SERVER_PORT: String(serverPort),
      PILOTDECK_GATEWAY_PORT: String(gatewayPort),
      PILOTDECK_GATEWAY_URL: `ws://127.0.0.1:${gatewayPort}/ws`,
      PILOTDECK_DESKTOP: "1",
      PILOTDECK_SKIP_BROWSER_OPEN: "1",
      PILOTDECK_SKIP_DEFAULT_PROJECT: "1",
    };

    this.spawnRuntime("gateway", this.gatewayCommand(), this.runtimeRoot, commonEnv);
    await waitForPort(gatewayPort, "127.0.0.1", 90_000);

    this.spawnRuntime(
      "server",
      [this.nodeBinary, "--import", "tsx", "server/index.js"],
      path.join(this.runtimeRoot, "ui"),
      commonEnv,
    );
    await waitForPort(serverPort, "127.0.0.1", 90_000);

    this.info = {
      serverPort,
      gatewayPort,
      runtimeRoot: this.runtimeRoot,
      logPath: this.logPath,
    };
    this.log(`PilotDeck Desktop runtime ready: http://127.0.0.1:${serverPort}`);
    return this.info;
  }

  async stop(): Promise<void> {
    for (const proc of [...this.processes].reverse()) {
      await killProcessTree(proc.child).catch((error) => {
        this.log(`Failed to stop ${proc.name}: ${String(error)}`);
      });
    }
    this.processes.length = 0;
    this.log("PilotDeck Desktop runtime stopped");
    this.logStream?.end();
    this.logStream = null;
  }

  private gatewayCommand(): string[] {
    const builtEntry = path.join(this.runtimeRoot, "dist", "src", "cli", "pilotdeck.js");
    if (fs.existsSync(builtEntry)) {
      return [this.nodeBinary, builtEntry, "server"];
    }
    return [this.nodeBinary, "--import", "tsx", path.join("src", "cli", "pilotdeck.ts"), "server"];
  }

  private spawnRuntime(
    name: string,
    command: string[],
    cwd: string,
    env: NodeJS.ProcessEnv,
  ): void {
    const [bin, ...args] = command;
    if (!bin) throw new Error(`Missing command for ${name}`);
    const child = spawn(bin, args, {
      cwd,
      env,
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
    });
    this.processes.push({ name, child });
    this.log(`[${name}] spawn ${bin} ${args.join(" ")}`);

    child.stdout.on("data", (chunk: Buffer) => this.logChunk(name, chunk));
    child.stderr.on("data", (chunk: Buffer) => this.logChunk(name, chunk));
    child.on("exit", (code, signal) => {
      this.log(`[${name}] exited code=${code ?? "null"} signal=${signal ?? "null"}`);
      if (!isQuitting) {
        void dialog.showMessageBox({
          type: "error",
          title: "PilotDeck runtime stopped",
          message: `${name} exited unexpectedly. See runtime log for details.`,
          detail: this.logPath,
        });
      }
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

async function createWindow(): Promise<void> {
  const runtimeRoot = resolveRuntimeRoot();
  const nodeBinary = resolveNodeBinary();
  runtime = new RuntimeManager(runtimeRoot, nodeBinary);
  const info = await runtime.start();

  mainWindow = new BrowserWindow({
    width: 1320,
    height: 900,
    minWidth: 960,
    minHeight: 640,
    title: "PilotDeck",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: "deny" };
  });

  await mainWindow.loadURL(`http://127.0.0.1:${info.serverPort}`);
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
  const binary = process.platform === "win32"
    ? path.join(process.resourcesPath, "node", "node.exe")
    : path.join(process.resourcesPath, "node", "bin", "node");
  if (!fs.existsSync(binary)) {
    throw new Error(`Bundled Node runtime not found: ${binary}`);
  }
  return binary;
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

function killProcessTree(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.killed) return Promise.resolve();
  return new Promise((resolve) => {
    child.once("exit", () => resolve());
    if (process.platform === "win32") {
      spawn("taskkill", ["/pid", String(child.pid), "/t", "/f"], { stdio: "ignore" })
        .once("exit", () => resolve());
      return;
    }
    if (child.pid) {
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {
        child.kill("SIGTERM");
      }
    }
    setTimeout(() => resolve(), 3000);
  });
}

ipcMain.handle("pilotdeck:get-runtime-info", () => runtime?.getInfo());

app.whenReady()
  .then(createWindow)
  .catch((error) => {
    void dialog.showErrorBox("PilotDeck failed to start", error instanceof Error ? error.stack ?? error.message : String(error));
    app.quit();
  });

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", (event) => {
  isQuitting = true;
  if (!runtime) return;
  event.preventDefault();
  const currentRuntime = runtime;
  runtime = null;
  currentRuntime.stop().finally(() => app.exit(0));
});
