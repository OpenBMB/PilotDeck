import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

const entrypoint = join(process.cwd(), "src", "extension", "plugins", "builtin", "funasr", "funasr-local-mcp.mjs");

async function startMcp(projectRoot: string, runtimeRoot: string) {
  const child = spawn(process.execPath, [entrypoint, "--project-root", projectRoot, "--runtime-root", runtimeRoot]);
  child.stdin.setDefaultEncoding("utf8");
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  let pending = "";
  const messages: Array<Record<string, unknown>> = [];
  child.stdout.on("data", (chunk) => {
    pending += chunk;
    const lines = pending.split("\n");
    pending = lines.pop() ?? "";
    for (const line of lines) if (line) messages.push(JSON.parse(line) as Record<string, unknown>);
  });
  const request = async (id: number, method: string, params: Record<string, unknown> = {}) => {
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const found = messages.find((message) => message.id === id);
      if (found) return found;
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    throw new Error(`MCP did not reply to ${method}`);
  };
  return { child, request };
}

async function makeRuntime(root: string, program: string) {
  const platform = `${process.platform}-${process.arch}`;
  const runtimeDir = join(root, "runtime", "v0.2.0", platform);
  const models = join(root, "models");
  await mkdir(runtimeDir, { recursive: true });
  await mkdir(models, { recursive: true });
  const executable = join(runtimeDir, process.platform === "win32" ? "llama-funasr-sensevoice.exe" : "llama-funasr-sensevoice");
  await writeFile(executable, program);
  if (process.platform !== "win32") await chmod(executable, 0o755);
  await writeFile(join(models, "sensevoice-small-q8.gguf"), "model");
  await writeFile(join(models, "fsmn-vad.gguf"), "vad");
}

test("local FunASR MCP handshakes, exposes auto-only schema, and reports missing installation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-funasr-mcp-"));
  try {
    const project = join(root, "project");
    const runtime = join(root, "runtime-cache");
    await mkdir(project);
    await writeFile(join(project, "meeting.wav"), "RIFF");
    const mcp = await startMcp(project, runtime);
    try {
      const initialized = await mcp.request(1, "initialize", { protocolVersion: "2024-11-05" });
      assert.match(JSON.stringify(initialized), /protocolVersion/);
      const tools = await mcp.request(2, "tools/list");
      assert.match(JSON.stringify(tools), /transcribe_audio/);
      assert.match(JSON.stringify(tools), /"auto"/);
      const missing = await mcp.request(3, "tools/call", { name: "transcribe_audio", arguments: { audio_path: "meeting.wav" } });
      assert.match(JSON.stringify(missing), /Run .*install:asr/);
    } finally { mcp.child.kill(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("local FunASR MCP confines paths, invokes CLI with SRT, and returns timestamps", async () => {
  if (process.platform === "win32") return;
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-funasr-mcp-"));
  try {
    const project = join(root, "project");
    const runtime = join(root, "runtime-cache");
    await mkdir(project);
    const audio = join(project, "meeting.wav");
    const outsideAudio = join(root, "outside.wav");
    await writeFile(audio, "RIFF");
    await writeFile(outsideAudio, "RIFF");
    await makeRuntime(runtime, "#!/bin/sh\nprintf '1\\n00:00:00,000 --> 00:00:01,500\\nhello world\\n\\n2\\n00:00:01,500 --> 00:00:02,000\\nsecond line\\n'");
    const mcp = await startMcp(project, runtime);
    try {
      const response = await mcp.request(1, "tools/call", { name: "transcribe_audio", arguments: { audio_path: audio, language: "auto" } });
      const encoded = JSON.stringify(response);
      assert.match(encoded, /hello world/);
      assert.match(encoded, /"start":0/);
      assert.match(encoded, /"end":1.5/);
      const outside = await mcp.request(2, "tools/call", { name: "transcribe_audio", arguments: { audio_path: outsideAudio } });
      assert.match(JSON.stringify(outside), /inside the current project root/);
      const language = await mcp.request(3, "tools/call", { name: "transcribe_audio", arguments: { audio_path: audio, language: "zh" } });
      assert.match(JSON.stringify(language), /only supports/);
    } finally { mcp.child.kill(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
