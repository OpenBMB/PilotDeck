#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { createWriteStream, existsSync, readFileSync } from "node:fs";
import {
  chmod, mkdir, rename, rm, stat,
} from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { Readable, Transform } from "node:stream";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import { Agent, EnvHttpProxyAgent, setGlobalDispatcher } from "undici";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const funasrDir = existsSync(join(ROOT, "dist", "src", "extension", "plugins", "builtin", "funasr", "funasr-runtime.mjs"))
  ? join(ROOT, "dist", "src", "extension", "plugins", "builtin", "funasr")
  : join(ROOT, "src", "extension", "plugins", "builtin", "funasr");
const runtime = await import(pathToFileURL(join(funasrDir, "funasr-runtime.mjs")).href);
const entrypoint = join(funasrDir, "funasr-local-mcp.mjs");

const pilotHome = resolve(process.env.PILOT_HOME || join(process.env.HOME || process.env.USERPROFILE || ".", ".pilotdeck"));
const cacheRoot = join(pilotHome, "funasr");
const modelSources = [
  {
    name: "ModelScope",
    url: (repo, revision, file) => `https://www.modelscope.cn/models/${repo}/resolve/${revision}/${file}`,
  },
  {
    name: "Hugging Face",
    url: (repo, revision, file) => `https://huggingface.co/${repo}/resolve/${revision === "master" ? "main" : revision}/${file}`,
  },
];
const models = runtime.FUNASR_MODELS;

export function resolveInstallerProxy({ env = process.env, configText } = {}) {
  const envProxy = env.PILOTDECK_PROXY || env.https_proxy || env.HTTPS_PROXY || env.http_proxy || env.HTTP_PROXY;
  if (envProxy) return { url: envProxy, noProxy: env.no_proxy || env.NO_PROXY || "", source: "env" };
  let config;
  if (configText) {
    try { config = parseYaml(configText); } catch { config = undefined; }
  }
  const proxy = config?.proxy;
  const url = typeof proxy === "string" ? proxy : proxy?.url;
  if (typeof url === "string" && url.trim()) {
    return { url: url.trim(), noProxy: typeof proxy?.noProxy === "string" ? proxy.noProxy : "", source: "config" };
  }
  return undefined;
}

function installInstallerProxy() {
  let configText;
  try { configText = readFileSync(join(pilotHome, "pilotdeck.yaml"), "utf8"); } catch { /* optional */ }
  const proxy = resolveInstallerProxy({ configText });
  const noProxy = [proxy?.noProxy, process.env.no_proxy, process.env.NO_PROXY, "127.0.0.1", "localhost"].filter(Boolean).join(",");
  if (proxy?.url) {
    setGlobalDispatcher(new EnvHttpProxyAgent({ httpProxy: proxy.url, httpsProxy: proxy.url, noProxy }));
    log(`Using ${proxy.source} proxy for downloads (noProxy: ${noProxy || "none"}).`);
  } else {
    setGlobalDispatcher(new Agent({ headersTimeout: 10 * 60_000, bodyTimeout: 10 * 60_000 }));
  }
}

function log(message) { console.log(`[pilotdeck-asr] ${message}`); }
function fail(message) { console.error(`[pilotdeck-asr] ${message}`); }

async function isRegularFile(path) {
  try { return (await stat(path)).isFile(); } catch { return false; }
}

export async function downloadFile(url, destination) {
  const part = `${destination}.${randomUUID()}.part`;
  await mkdir(dirname(destination), { recursive: true });
  try {
    const response = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(10 * 60_000) });
    if (!response.ok || !response.body) throw new Error(`HTTP ${response.status} ${response.statusText}`);
    let bytes = 0;
    await pipeline(
      Readable.fromWeb(response.body),
      new Transform({
        transform(chunk, _encoding, done) {
          bytes += chunk.length;
          done(null, chunk);
        },
      }),
      createWriteStream(part, { mode: 0o600 }),
    );
    await rename(part, destination);
    return { bytes };
  } finally {
    await rm(part, { force: true }).catch(() => undefined);
  }
}

function run(command, args) {
  return new Promise((resolveResult) => {
    const child = spawn(command, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => resolveResult({ code: 127, stdout, stderr: error.message }));
    child.on("close", (code) => resolveResult({ code: code ?? 1, stdout, stderr }));
  });
}

export async function installRuntime({ platform = process.platform, arch = process.arch } = {}) {
  const asset = runtime.resolveRuntimeAsset(platform, arch);
  const target = runtime.runtimeDirectory(cacheRoot, platform, arch);
  if (runtime.findSenseVoiceBinary(cacheRoot, platform, arch)) {
    log(`Runtime ${runtime.FUNASR_RUNTIME_VERSION} (${asset.key}) is already installed.`);
    return target;
  }
  const staging = `${target}.staging-${randomUUID()}`;
  const archive = join(cacheRoot, "downloads", asset.file);
  await rm(staging, { recursive: true, force: true });
  try {
    log(`Downloading ${asset.file} from the fixed FunASR release...`);
    await downloadFile(asset.url, archive);
    await mkdir(staging, { recursive: true });
    let unpack;
    if (asset.format === "tar.gz") {
      unpack = await run("tar", ["-xzf", archive, "-C", staging]);
    } else {
      const shell = process.env.ComSpec || "powershell.exe";
      unpack = await run(shell, ["-NoProfile", "-NonInteractive", "-Command", `Expand-Archive -LiteralPath '${archive.replaceAll("'", "''")}' -DestinationPath '${staging.replaceAll("'", "''")}' -Force`]);
    }
    if (unpack.code !== 0) throw new Error(`unpack failed: ${unpack.stderr.trim() || unpack.stdout.trim()}`);
    const binary = runtime.findSenseVoiceBinaryIn(staging, platform);
    if (!binary) throw new Error("unpack completed but llama-funasr-sensevoice was not found");
    if (platform !== "win32") await chmod(binary, 0o755);
    await mkdir(dirname(target), { recursive: true });
    if (!existsSync(target)) await rename(staging, target);
    return target;
  } catch (error) {
    throw new Error(`Runtime stage failed (${asset.url}): ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => undefined);
  }
}

export async function installModel(model) {
  const destination = join(runtime.modelDirectory(cacheRoot), model.file);
  if (await isRegularFile(destination) && (await stat(destination)).size > 0) {
    log(`Model ${model.file} is already installed.`);
    return destination;
  }
  await rm(destination, { force: true }).catch(() => undefined);
  const errors = [];
  for (const source of modelSources) {
    const url = source.url(model.repo, model.revision, model.file);
    try {
      log(`Downloading ${model.file} from ${source.name}...`);
      const downloaded = await downloadFile(url, destination);
      log(`Downloaded ${model.file} (${downloaded.bytes} bytes).`);
      return destination;
    } catch (error) {
      errors.push(`${source.name}: ${error instanceof Error ? error.message : String(error)}`);
      await rm(destination, { force: true }).catch(() => undefined);
    }
  }
  throw new Error(`Model download failed for ${model.file}. ${errors.join("; ")}`);
}

export function runMcpSmoke({ projectRoot = process.cwd(), runtimeRoot = cacheRoot } = {}) {
  return new Promise((resolveResult) => {
    const child = spawn(process.execPath, [entrypoint, "--project-root", projectRoot, "--runtime-root", runtimeRoot], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      child.kill();
      resolveResult(value);
    };
    const timeout = setTimeout(() => finish({ code: 124, stdout, stderr }), 30_000);
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      if (stdout.includes('"protocolVersion"') && stdout.includes('"transcribe_audio"')) finish({ code: 0, stdout, stderr });
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => finish({ code: 127, stdout, stderr: error.message }));
    child.on("close", (code) => finish({ code: code ?? 1, stdout, stderr }));
    child.stdin.end(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2024-11-05", capabilities: {}, clientInfo: { name: "pilotdeck-asr-installer", version: "0.2.0" } } })}\n${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
  });
}

async function main() {
  log(`Installing local FunASR llama.cpp runtime into ${cacheRoot}`);
  installInstallerProxy();
  let asset;
  try {
    asset = runtime.resolveRuntimeAsset();
    log(`Platform: ${asset.key}; CPU local runtime; no Docker or Python required.`);
    await installRuntime();
    for (const model of models) await installModel(model);
    log("Running local MCP initialize/tools/list smoke test...");
    const smoke = await runMcpSmoke();
    if (smoke.code !== 0) throw new Error(`MCP smoke failed: ${smoke.stderr.trim() || smoke.stdout.trim()}`);
    log(`FunASR is ready. Runtime and models are cached in ${cacheRoot}.`);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
