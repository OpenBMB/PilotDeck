#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const b0Root = process.env.PILOTDECK_B0_ROOT
  ?? "/tmp/pilotdeck-staffdeck-m0.j4voeS/pilotdeck-b0";
const tracePath = process.argv[2];

if (!tracePath) {
  throw new Error("Usage: run-e2e01-native-pilotdeck-b0-replay.mjs <e2e01-native-owner-trace.json>");
}

const trace = JSON.parse(await readFile(tracePath, "utf8"));
assert.equal(trace.scenario, "E2E-01-native-owner");
const calls = ["read_skill", "read_file", "knowledge_query"];
assert.deepEqual(
  toolCalls(trace).slice(0, calls.length).map((call) => call.name),
  calls,
  "saved E2E-01 trace does not preserve the expected native tool order",
);

const fixtureRoot = await mkdtemp(join(tmpdir(), "pilotdeck-e2e01-b0-replay-"));
let report;
let failure;
try {
  const b0 = await import(pathToFileURL(join(b0Root, "dist/src/tool/index.js")).href);
  const skills = await import(pathToFileURL(join(b0Root, "dist/src/extension/skills/SkillManager.js")).href);
  const projectRoot = join(fixtureRoot, "project");
  const pilotHome = join(fixtureRoot, "pilot-home");
  const skillRoot = join(projectRoot, ".pilotdeck", "skills", "approval-guide");
  await mkdir(skillRoot, { recursive: true });
  const skillContent = trace.sideEffects?.projectSkill?.content;
  const fileContent = trace.sideEffects?.readFile?.content;
  const filePath = trace.sideEffects?.readFile?.path;
  assert.equal(typeof skillContent, "string");
  assert.equal(typeof fileContent, "string");
  assert.equal(typeof filePath, "string");
  await writeFile(join(skillRoot, "SKILL.md"), [
    "---",
    "name: approval-guide",
    "description: Approval evidence guide",
    "---",
    "",
    skillContent,
  ].join("\n"), "utf8");
  await writeFile(join(projectRoot, filePath), fileContent, "utf8");

  const manager = new skills.SkillManager({ pilotHome, builtinSkillsRoot: join(fixtureRoot, "builtin") });
  const listed = await manager.list({ projectKey: projectRoot, scope: "project" });
  const skill = await manager.read({ scope: "project", slug: "approval-guide", projectKey: projectRoot });
  assert.equal(listed.project.some((entry) => entry.slug === "approval-guide"), true);
  const skillCall = toolCalls(trace).find((call) => call.name === "read_skill");
  assert.ok(skillCall, "saved E2E-01 trace contains no read_skill call");
  assert.deepEqual(skillCall.input, { skillName: "approval-guide" });
  const readSkillTool = b0.createReadSkillTool({
    loader: async (name) => name === skillCall.input.skillName ? stripFrontmatter(skill.content) : undefined,
    lister: () => listed.project.map((entry) => ({
      name: entry.name,
      description: entry.description,
      path: entry.skillFile,
    })),
  });
  const actualSkillContent = (await readSkillTool.execute(skillCall.input)).content;
  compareReadSkillReplay(skillCall, toolResult(trace, "read_skill"), actualSkillContent, projectRoot);
  if (process.env.PILOTDECK_E2E_REPLAY_INJECT_MISMATCH === "1") {
    const injected = structuredClone(toolResult(trace, "read_skill"));
    injected.content[0].text = "injected read_skill result mismatch";
    injected.raw.content[0].text = "injected read_skill result mismatch";
    compareReadSkillReplay(skillCall, injected, actualSkillContent, projectRoot);
  }

  const registry = new b0.ToolRegistry();
  registry.register(b0.createReadFileTool());
  const runtime = new b0.ToolRuntime(registry, {
    async decide() {
      return { type: "allow", reason: { type: "runtime", message: "E2E-01 B0 replay" } };
    },
  });
  const readCall = toolCalls(trace).find((call) => call.name === "read_file");
  assert.ok(readCall);
  const result = await runtime.execute({
    id: "b0-e2e01-read-file",
    name: "read_file",
    input: readCall.input,
  }, toolContext(projectRoot));
  assert.equal(result.type, "success");
  const actualText = result.content.find((block) => block.type === "text")?.text;
  const expectedText = toolResultText(trace, "read_file");
  assert.equal(actualText, expectedText, "B0 read_file replay differs from the saved candidate call result");

  report = {
    status: "PASS",
    baseline: b0Root,
    trace: tracePath,
    replayed: [
      "native Skill discovery/read and saved read_skill request/result parity with the actual approval-guide fixture",
      "native read_file call, result text, and workspace side effect",
      "saved model tool-call order read_skill -> read_file -> knowledge_query",
    ],
    notCovered: [
      "StaffDeck Knowledge and SOP owner replay",
      "native Context request/automatic compaction replay",
      "Gateway/session entry and persisted automatic-compaction evidence, covered separately by run-e2e01-native-pilotdeck-b0-gateway-session-replay.mjs",
    ],
  };
} catch (error) {
  failure = error;
} finally {
  await rm(fixtureRoot, { recursive: true, force: true });
}
if (failure) {
  process.stderr.write(`${JSON.stringify({
    status: "FAIL",
    baseline: b0Root,
    trace: tracePath,
    error: failure instanceof Error ? failure.message : String(failure),
  }, null, 2)}\n`);
  process.exitCode = 1;
} else {
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

function toolCalls(value) {
  const calls = [];
  for (const request of value.modelRequests ?? []) {
    for (const message of request.messages ?? []) {
      for (const block of message.content ?? []) {
        if (block?.type === "tool_call" && typeof block.name === "string") {
          calls.push({ id: block.id, name: block.name, input: block.input });
        }
      }
    }
  }
  return calls;
}

function toolResult(value, name) {
  for (const request of value.modelRequests ?? []) {
    for (const message of request.messages ?? []) {
      for (const block of message.content ?? []) {
        if (block?.type !== "tool_result" || block?.raw?.toolName !== name) continue;
        if (Array.isArray(block.content) && block.raw && typeof block.raw === "object") {
          return { content: block.content, raw: block.raw };
        }
      }
    }
  }
  throw new Error(`Saved trace contains no ${name} result.`);
}

function toolResultText(value, name) {
  const text = toolResult(value, name).content.find((item) => item?.type === "text")?.text;
  if (typeof text !== "string") throw new Error(`Saved trace contains no ${name} text result.`);
  return text;
}

function compareReadSkillReplay(call, saved, actualContent, projectRoot) {
  assert.equal(saved.raw.type, "success");
  assert.equal(saved.raw.toolCallId, call.id);
  assert.equal(saved.raw.toolName, "read_skill");
  const actual = normalizeSkillContent(actualContent, projectRoot);
  assert.deepEqual(normalizeSkillContent(saved.content, projectRoot), actual, "B0 read_skill result differs from the saved candidate content");
  assert.deepEqual(normalizeSkillContent(saved.raw.content, projectRoot), actual, "B0 read_skill result differs from the saved candidate raw.content");
}

function normalizeSkillContent(content, projectRoot) {
  return content.map((block) => block?.type === "text" && typeof block.text === "string"
    ? { ...block, text: block.text.replaceAll(projectRoot, "<workspace>/project") }
    : block);
}

function stripFrontmatter(content) {
  return content.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n?/, "");
}

function toolContext(cwd) {
  return {
    sessionId: "b0-e2e01-session",
    turnId: "b0-e2e01-turn",
    cwd,
    permissionMode: "bypassPermissions",
    permissionContext: {
      mode: "bypassPermissions",
      cwd,
      additionalWorkingDirectories: [],
      canPrompt: false,
      bypassAvailable: true,
      rules: { allow: [], deny: [], ask: [] },
    },
    readFileState: new Map(),
    writeSnapshots: new Map(),
  };
}
