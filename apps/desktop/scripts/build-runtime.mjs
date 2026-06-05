#!/usr/bin/env node
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const desktopRoot = resolve(__dirname, "..");
const repoRoot = resolve(desktopRoot, "..", "..");

function run(command, args, cwd) {
  console.log(`[desktop] ${command} ${args.join(" ")} (${cwd})`);
  const result = spawnSync(command, args, {
    cwd,
    stdio: "inherit",
    shell: process.platform === "win32" && command.endsWith(".cmd"),
    env: process.env,
  });
  if (result.error) {
    throw result.error;
  }
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed`);
  }
}

const npmExecPath = process.env.npm_execpath ?? "";
const isPnpmExecPath = npmExecPath.replaceAll("\\", "/").includes("/pnpm/");
const packageManager = isPnpmExecPath
  ? { command: process.execPath, args: [process.env.npm_execpath] }
  : { command: process.platform === "win32" ? "pnpm.cmd" : "pnpm", args: [] };

function runPnpm(args) {
  run(packageManager.command, [...packageManager.args, ...args], repoRoot);
}

run(process.execPath, [resolve(desktopRoot, "scripts", "download-node.mjs")], desktopRoot);

if (process.env.PILOTDECK_DESKTOP_SKIP_RUNTIME_BUILD !== "1") {
  runPnpm(["--dir", repoRoot, "run", "build"]);
  runPnpm(["--dir", repoRoot, "--filter", "pilotdeck-ui", "run", "build"]);
}

const required = [
  resolve(repoRoot, "dist", "src", "cli", "pilotdeck.js"),
  resolve(repoRoot, "ui", "dist", "index.html"),
  resolve(repoRoot, "ui", "server", "index.js"),
  resolve(repoRoot, "src", "context", "memory", "edgeclaw-memory-core", "lib", "index.js"),
  resolve(repoRoot, "src", "context", "memory", "edgeclaw-memory-core", "ui-source", "index.html"),
];

for (const file of required) {
  if (!existsSync(file)) {
    throw new Error(`Desktop runtime prerequisite missing: ${file}`);
  }
}

console.log("[desktop] runtime prerequisites ready");
