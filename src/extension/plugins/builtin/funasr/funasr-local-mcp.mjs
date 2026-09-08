#!/usr/bin/env node

import { spawn } from "node:child_process";
import { realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";
import readline from "node:readline";
import { runtimePaths } from "./funasr-runtime.mjs";

const args = parseArgs(process.argv.slice(2));
const projectRootArg = args["project-root"];
const runtimeRoot = args["runtime-root"];
const installCommand = args["install-command"] || "npm run install:asr";

function parseArgs(values) {
  const out = {};
  for (let i = 0; i < values.length; i += 1) {
    if (values[i].startsWith("--") && values[i + 1]) out[values[i].slice(2)] = values[i + 1];
  }
  return out;
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function result(id, value) {
  send({ jsonrpc: "2.0", id, result: value });
}

function rpcError(id, code, message) {
  send({ jsonrpc: "2.0", id, error: { code, message } });
}

const tool = {
  name: "transcribe_audio",
  description: "Transcribe a project-local audio file with the local FunASR SenseVoice runtime. Returns transcript text and timestamped segments.",
  inputSchema: {
    type: "object",
    additionalProperties: false,
    required: ["audio_path"],
    properties: {
      audio_path: { type: "string", description: "Absolute or project-relative path to an audio file inside the current project." },
      language: { type: "string", enum: ["auto"], default: "auto", description: "SenseVoice local CLI detects language automatically." },
    },
  },
};

async function resolveProjectAudio(audioPath) {
  if (typeof audioPath !== "string" || audioPath.trim() === "") {
    throw new Error("audio_path must be a non-empty local file path");
  }
  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(audioPath)) {
    throw new Error("audio_path must be a local project file, not a URL");
  }
  if (!projectRootArg) throw new Error("FunASR MCP is missing its project root configuration");
  const projectRoot = await realpath(projectRootArg);
  const requested = isAbsolute(audioPath) ? audioPath : resolve(projectRoot, audioPath);
  let audio;
  try {
    audio = await realpath(requested);
  } catch {
    throw new Error(`audio file does not exist or is inaccessible: ${audioPath}`);
  }
  const rel = relative(projectRoot, audio);
  if (rel === "" || rel === ".." || rel.startsWith(`..${process.platform === "win32" ? "\\" : "/"}`) || isAbsolute(rel)) {
    throw new Error("audio_path must resolve inside the current project root");
  }
  const info = await stat(audio);
  if (!info.isFile()) throw new Error("audio_path must resolve to a regular file");
  return audio;
}

function toolError(message) {
  return { content: [{ type: "text", text: message }], isError: true };
}

async function runTranscription(input) {
  if (!runtimeRoot) return toolError(`FunASR local runtime is not configured. Run ${installCommand}, then retry this tool.`);
  if (input?.language !== undefined && input.language !== "auto") {
    return toolError('language only supports "auto" for the local SenseVoice runtime.');
  }
  let audio;
  try {
    audio = await resolveProjectAudio(input?.audio_path);
  } catch (error) {
    return toolError(error instanceof Error ? error.message : String(error));
  }
  let paths;
  try {
    paths = runtimePaths(runtimeRoot);
  } catch (error) {
    return toolError(error instanceof Error ? error.message : String(error));
  }
  if (!paths.binary || !(await fileExists(paths.model)) || !(await fileExists(paths.vad))) {
    return toolError(`FunASR local runtime or models are not installed. Run ${installCommand}, then retry mcp__funasr__transcribe_audio in this session.`);
  }
  const commandArgs = ["-m", paths.model, "--vad", paths.vad, "-a", audio, "--srt"];
  const completed = await run(paths.binary, commandArgs);
  if (completed.code !== 0) {
    const diagnostic = completed.stderr.trim().slice(-4000) || completed.stdout.trim().slice(-1000) || "no CLI diagnostic";
    return toolError(`FunASR transcription failed (exit ${completed.code}): ${diagnostic}`);
  }
  const segments = parseSrt(completed.stdout);
  if (segments.length === 0) {
    return toolError(`FunASR completed but did not produce SRT segments. ${completed.stderr.trim().slice(-1000)}`.trim());
  }
  const text = segments.map((segment) => segment.text).join("\n");
  return {
    content: [{ type: "text", text: `${text}\n\nTimestamped segments:\n${segments.map((s) => `[${s.start.toFixed(3)} - ${s.end.toFixed(3)}] ${s.text}`).join("\n")}` }],
    structuredContent: { text, segments },
  };
}

async function fileExists(path) {
  try { return (await stat(path)).isFile(); } catch { return false; }
}

function run(command, commandArgs) {
  return new Promise((resolveResult) => {
    const child = spawn(command, commandArgs, { windowsHide: true });
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

export function parseSrt(output) {
  const normalized = output.replaceAll("\r\n", "\n");
  const segments = [];
  const blocks = normalized.split(/\n\s*\n/u);
  for (const block of blocks) {
    const lines = block.split("\n").map((line) => line.trim()).filter(Boolean);
    const timestampIndex = lines.findIndex((line) => line.includes("-->"));
    if (timestampIndex < 0) continue;
    const match = /^(\d{2}:\d{2}:\d{2}[,.]\d{1,3})\s+-->\s+(\d{2}:\d{2}:\d{2}[,.]\d{1,3})/u.exec(lines[timestampIndex]);
    if (!match) continue;
    const text = lines.slice(timestampIndex + 1).join(" ").trim();
    if (text) segments.push({ start: srtTimeToSeconds(match[1]), end: srtTimeToSeconds(match[2]), text });
  }
  return segments;
}

function srtTimeToSeconds(value) {
  const [hours, minutes, seconds] = value.replace(",", ".").split(":");
  return Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
}

const reader = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
reader.on("line", async (line) => {
  let request;
  try { request = JSON.parse(line); } catch { return; }
  if (!request || request.jsonrpc !== "2.0" || !request.method) return;
  try {
    if (request.method === "initialize") {
      result(request.id, {
        protocolVersion: request.params?.protocolVersion ?? "2024-11-05",
        capabilities: { tools: {} },
        serverInfo: { name: "pilotdeck-funasr-local", version: "0.2.0" },
        instructions: "Use transcribe_audio only with an audio path inside the active PilotDeck project.",
      });
    } else if (request.method === "tools/list") {
      result(request.id, { tools: [tool] });
    } else if (request.method === "tools/call") {
      const name = request.params?.name;
      if (name !== "transcribe_audio") result(request.id, toolError(`Unknown tool: ${String(name)}`));
      else result(request.id, await runTranscription(request.params?.arguments ?? {}));
    } else if (request.id !== undefined) {
      rpcError(request.id, -32601, `Method not found: ${request.method}`);
    }
  } catch (error) {
    if (request.id !== undefined) rpcError(request.id, -32603, error instanceof Error ? error.message : String(error));
  }
});
