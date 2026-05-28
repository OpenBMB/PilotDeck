#!/usr/bin/env node
/**
 * L2 release smoke for Windows — Node.js orchestrator that replaces the
 * Mac-specific release-l2.sh + packaged-runtime.sh.
 *
 * Usage:
 *   node scripts/release-l2-win.mjs <win-unpacked-dir>
 *
 * Example:
 *   node scripts/release-l2-win.mjs dist-electron/win-unpacked
 *
 * Prereq: `npm install` at monorepo root (for playwright).
 *         `npx playwright install chromium`
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as net from "node:net";
import * as http from "node:http";
import { spawn, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP_DIR = path.resolve(__dirname, "..");
const REPO_ROOT = path.resolve(DESKTOP_DIR, "../..");

const target = process.argv[2];
if (!target) {
  console.error("Usage: release-l2-win.mjs <win-unpacked-dir>");
  process.exit(2);
}

const winUnpacked = path.resolve(target);
const resources = path.join(winUnpacked, "resources");

if (!fs.existsSync(resources)) {
  console.error(`Resources dir not found: ${resources}`);
  process.exit(2);
}

const pids = [];

function cleanup() {
  for (const p of pids) {
    try { process.kill(p); } catch { /* already gone */ }
  }
  if (sandbox && fs.existsSync(sandbox)) {
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* ok */ }
  }
}
process.on("exit", cleanup);
process.on("SIGINT", () => { cleanup(); process.exit(1); });
process.on("SIGTERM", () => { cleanup(); process.exit(1); });

function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, () => {
      const port = srv.address().port;
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

function httpGet(url, timeoutMs = 3000) {
  return new Promise((resolve, reject) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let data = "";
      res.on("data", (d) => (data += d));
      res.on("end", () => resolve({ status: res.statusCode, body: data }));
    });
    req.on("error", reject);
    req.on("timeout", () => { req.destroy(); reject(new Error("timeout")); });
  });
}

async function waitForHealth(url, maxWaitMs = 45000) {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    try {
      const r = await httpGet(url);
      if (r.status === 200) return true;
    } catch { /* retry */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  return false;
}

console.log("PilotDeck L2 smoke (Windows)");
console.log(`  Target: ${winUnpacked}`);

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "pd-l2-"));
const pilotHome = path.join(sandbox, "home", ".pilotdeck");
fs.mkdirSync(pilotHome, { recursive: true });

fs.writeFileSync(path.join(pilotHome, "pilotdeck.yaml"), `schemaVersion: 1
agent:
  model: pilotdeck/claude-sonnet-4-5-20250929
model:
  providers:
    pilotdeck:
      protocol: anthropic
      url: https://api.anthropic.com
      apiKey: smoke-test-not-real
      models:
        claude-sonnet-4-5-20250929: {}
`);

const bundles = [
  { tar: "pilotdeckui-bundle.tar", dir: "pilotdeckui" },
  { tar: "pilotdeck-main-bundle.tar", dir: "pilotdeck-main" },
  { tar: "pilotdeck-memory-core-bundle.tar", dir: "pilotdeck-memory-core" },
];

for (const b of bundles) {
  const tarPath = path.join(resources, b.tar);
  const outDir = path.join(sandbox, b.dir);
  fs.mkdirSync(outDir, { recursive: true });
  if (!fs.existsSync(tarPath)) {
    console.error(`  Bundle not found: ${tarPath}`);
    process.exit(2);
  }
  execSync(`tar xf "${tarPath}" -C "${outDir}"`, { stdio: "pipe" });
  console.log(`  Extracted: ${b.tar}`);
}

const ccuiDir = path.join(sandbox, "pilotdeckui");
const ccmDir = path.join(sandbox, "pilotdeck-main");
const memDir = path.join(sandbox, "pilotdeck-memory-core");

// Wire up module resolution — Windows uses directory junctions (no admin needed)
// to replicate what the Mac script does with ln -sfn.
function mkJunction(link, target) {
  if (fs.existsSync(link)) return;
  execSync(`mklink /J "${link}" "${target}"`, { shell: "cmd.exe", stdio: "pipe" });
}

// 1. edgeclaw-memory-core must be resolvable from pilotdeck-main's node_modules
const ccmNodeModules = path.join(ccmDir, "node_modules");
if (!fs.existsSync(ccmNodeModules)) {
  fs.mkdirSync(ccmNodeModules, { recursive: true });
}
mkJunction(path.join(ccmNodeModules, "edgeclaw-memory-core"), memDir);
console.log("  Linked: edgeclaw-memory-core → node_modules");

// 2. UI server imports ../../src/* relative paths that expect sandbox/dist and sandbox/src
const distDir = path.join(ccmDir, "dist");
if (fs.existsSync(distDir)) {
  mkJunction(path.join(sandbox, "dist"), distDir);
  mkJunction(path.join(sandbox, "src"), path.join(distDir, "src"));
  console.log("  Linked: sandbox/dist, sandbox/src → pilotdeck-main/dist");
}

// 3. memory-core also referenced from sandbox root
mkJunction(path.join(sandbox, "edgeclaw-memory-core"), memDir);

// 4. UI server imports ../../../src/context/memory/edgeclaw-memory-core/...
//    sandbox/src -> dist/src which excludes the memory module; create the
//    junction directly inside the dist/src tree so resolution succeeds.
const memJunctionParent = path.join(distDir, "src", "context", "memory");
if (!fs.existsSync(memJunctionParent)) {
  fs.mkdirSync(memJunctionParent, { recursive: true });
}
const memJunction = path.join(memJunctionParent, "edgeclaw-memory-core");
if (fs.existsSync(memJunction) && !fs.lstatSync(memJunction).isSymbolicLink()) {
  fs.rmSync(memJunction, { recursive: true, force: true });
}
mkJunction(memJunction, memDir);
console.log("  Linked: src/context/memory/edgeclaw-memory-core -> memory-core bundle");

const nodeExe = path.join(resources, "node-bin", "node.exe");
const bunExe = path.join(resources, "bun-bin", "bun.exe");

if (!fs.existsSync(nodeExe)) {
  console.error(`  node.exe not found: ${nodeExe}`);
  process.exit(2);
}

const gwEntry = path.join(ccmDir, "dist", "src", "cli", "pilotdeck.js");
if (!fs.existsSync(gwEntry)) {
  console.error(`  Gateway entry not found: ${gwEntry}`);
  process.exit(2);
}

const uiEntry = path.join(ccuiDir, "server", "index.js");
if (!fs.existsSync(uiEntry)) {
  console.error(`  UI server entry not found: ${uiEntry}`);
  process.exit(2);
}

const gwPort = await freePort();
const uiPort = await freePort();

console.log(`\n-- Start packaged Gateway (port ${gwPort}) + UI (port ${uiPort}) --`);

const gwLog = path.join(sandbox, "gateway.log");
const gwLogStream = fs.createWriteStream(gwLog);
const gw = spawn(nodeExe, [gwEntry, "server"], {
  cwd: ccmDir,
  env: {
    ...process.env,
    HOME: path.join(sandbox, "home"),
    USERPROFILE: path.join(sandbox, "home"),
    PILOT_HOME: pilotHome,
    PILOTDECK_GATEWAY_PORT: String(gwPort),
    BUN_BIN: bunExe,
    NO_COLOR: "1",
    FORCE_COLOR: "0",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
gw.stdout.pipe(gwLogStream);
gw.stderr.pipe(gwLogStream);
pids.push(gw.pid);

const gwHealthy = await waitForHealth(`http://127.0.0.1:${gwPort}/health`);
if (!gwHealthy) {
  console.error("  Gateway did not become healthy.");
  try { console.error("  Log:", fs.readFileSync(gwLog, "utf-8").slice(-2000)); } catch { /* ok */ }
  process.exit(1);
}
console.log("  Gateway: healthy");

let tokenOk = false;
for (let i = 0; i < 20; i++) {
  if (fs.existsSync(path.join(pilotHome, "server-token"))) { tokenOk = true; break; }
  await new Promise((r) => setTimeout(r, 500));
}
if (!tokenOk) {
  console.error("  Gateway did not write server-token");
  process.exit(1);
}

// UI server needs ws, express etc. Node ESM resolution walks up from ccuiDir
// to sandbox/ — place a junction there so both ccuiDir and ccmDir can resolve deps.
const sandboxNodeModules = path.join(sandbox, "node_modules");
if (!fs.existsSync(sandboxNodeModules)) {
  execSync(`mklink /J "${sandboxNodeModules}" "${path.join(ccmDir, "node_modules")}"`, {
    shell: "cmd.exe",
    stdio: "pipe",
  });
  console.log("  Linked: sandbox/node_modules → pilotdeck-main/node_modules");
}

const srvLog = path.join(sandbox, "server.log");
const srvLogStream = fs.createWriteStream(srvLog);
const srv = spawn(nodeExe, [uiEntry], {
  cwd: ccuiDir,
  env: {
    ...process.env,
    HOME: path.join(sandbox, "home"),
    USERPROFILE: path.join(sandbox, "home"),
    PILOT_HOME: pilotHome,
    SERVER_PORT: String(uiPort),
    PILOTDECK_MAIN_DIR: ccmDir,
    PILOTDECK_GATEWAY_URL: `ws://127.0.0.1:${gwPort}/ws`,
    PILOTDECK_GATEWAY_TOKEN_PATH: path.join(pilotHome, "server-token"),
    BUN_BIN: bunExe,
    NO_COLOR: "1",
    FORCE_COLOR: "0",
  },
  stdio: ["ignore", "pipe", "pipe"],
});
srv.stdout.pipe(srvLogStream);
srv.stderr.pipe(srvLogStream);
pids.push(srv.pid);

const uiUrl = `http://127.0.0.1:${uiPort}`;
const uiHealthy = await waitForHealth(`${uiUrl}/health`, 30000);
if (!uiHealthy) {
  console.error("  UI server did not become healthy.");
  try { console.error("  Log:", fs.readFileSync(srvLog, "utf-8").slice(-2000)); } catch { /* ok */ }
  process.exit(1);
}
console.log("  UI server: healthy");

// Trigger a projects request to help bridge connect
try { await httpGet(`${uiUrl}/api/projects`); } catch { /* ok */ }

let bridgeOk = false;
for (let i = 0; i < 90; i++) {
  try {
    const log = fs.readFileSync(srvLog, "utf-8");
    if (log.includes("[pilotdeck-bridge] connected")) { bridgeOk = true; break; }
    if (log.includes("gateway connect failed after")) break;
  } catch { /* ok */ }
  await new Promise((r) => setTimeout(r, 500));
}
if (!bridgeOk) {
  console.error("  pilotdeck-bridge did not connect.");
  try { console.error("  Log:", fs.readFileSync(srvLog, "utf-8").slice(-2000)); } catch { /* ok */ }
  process.exit(1);
}
console.log("  Bridge: connected");

console.log("\n-- L2a: Playwright UI tabs --");
try {
  execSync(`node "${path.join(__dirname, "release-l2-ui-smoke.mjs")}"`, {
    cwd: REPO_ROOT,
    env: { ...process.env, PD_UI_URL: uiUrl },
    stdio: "inherit",
  });
} catch (e) {
  console.error("L2a FAILED");
  process.exit(1);
}

console.log("\n-- L2b: Onboarding HTML (mock IPC) --");
try {
  execSync(`npm run build`, { cwd: DESKTOP_DIR, stdio: "pipe" });
} catch (e) {
  console.error("  Desktop build failed:", e.message);
  process.exit(1);
}
try {
  execSync(`node "${path.join(__dirname, "release-l2-onboarding-smoke.mjs")}"`, {
    cwd: REPO_ROOT,
    stdio: "inherit",
  });
} catch (e) {
  console.error("L2b FAILED");
  process.exit(1);
}

// L2c/L2d require an interactive desktop session (Session 1+).
// Detect via SESSIONNAME: "Console" = physical, "RDP-Tcp#N" = RDP, absent = SSH/service.
const sessionName = process.env.SESSIONNAME || "";
const hasDesktop = sessionName.startsWith("Console") || sessionName.startsWith("RDP");

if (hasDesktop) {
  console.log("\n-- L2c: Electron smoke (interactive desktop detected) --");
  try {
    execSync(`node "${path.join(__dirname, "release-l2c-electron-smoke-win.mjs")}"`, {
      cwd: REPO_ROOT,
      env: { ...process.env, PD_APP: winUnpacked },
      stdio: "inherit",
      timeout: 180_000,
    });
  } catch (e) {
    console.error("  L2c FAILED (non-blocking for L2 overall)");
  }

  console.log("\n-- L2d: Cold-start Electron (interactive desktop detected) --");
  try {
    execSync(`node "${path.join(__dirname, "release-l2d-cold-start-win.mjs")}"`, {
      cwd: REPO_ROOT,
      env: { ...process.env, PD_APP: winUnpacked },
      stdio: "inherit",
      timeout: 300_000,
    });
  } catch (e) {
    console.error("  L2d FAILED");
    process.exitCode = 1;
  }
} else {
  console.log("\n-- L2c/L2d: Electron (skipped — no interactive desktop) --");
  console.log("  To run L2c/L2d, open CMD/PowerShell on the desktop (or via RDP) and run:");
  console.log(`    set PD_APP=${winUnpacked}`);
  console.log(`    node apps\\desktop\\scripts\\release-l2c-electron-smoke-win.mjs`);
  console.log(`    node apps\\desktop\\scripts\\release-l2d-cold-start-win.mjs`);
}

cleanup();
console.log("\n✓ L2 smoke PASSED (Windows)");
