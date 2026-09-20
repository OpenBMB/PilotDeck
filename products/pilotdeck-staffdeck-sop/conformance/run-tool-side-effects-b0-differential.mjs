#!/usr/bin/env node

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

const candidateRoot = process.env.PILOTDECK_CANDIDATE_ROOT
  ?? dirname(dirname(dirname(dirname(new URL(import.meta.url).pathname))));
const b0Root = process.env.PILOTDECK_B0_ROOT
  ?? "/tmp/pilotdeck-staffdeck-m0.j4voeS/pilotdeck-b0";

const expected = await runCase(b0Root);
const actual = await runCase(candidateRoot);
assert.deepEqual(actual.comparable, expected.comparable, "Tool side-effect/result/audit differential mismatch");
assert.deepEqual(actual.auditExtensions.map(({ toolCallId }) => toolCallId), ["read-1", "write-1", "write-2", "read-2", "read-missing", "bash-1"]);
assert.deepEqual(actual.auditExtensions.map(({ operationId, toolCallId }) => operationId === toolCallId), [true, true, true, true, true, true]);

const altered = structuredClone(actual.comparable);
altered.files.existing = "tampered";
assert.notDeepEqual(altered, actual.comparable, "comparator sensitivity fixture did not detect a file side effect change");

process.stdout.write(JSON.stringify({
  status: "PASS",
  baseline: b0Root,
  candidate: candidateRoot,
  compared: ["workspace-write", "read-after-write", "missing-read", "stale-write-protection", "process-side-effect", "audit-records"],
  candidateAuditExtensions: actual.auditExtensions,
}, null, 2) + "\n");

async function runCase(root) {
  const [{ ToolRuntime }, { ToolRegistry }, { createReadFileTool }, { createWriteFileTool }, { createBashTool }] = await Promise.all([
    import(pathToFileURL(join(root, "dist/src/tool/execution/ToolRuntime.js")).href),
    import(pathToFileURL(join(root, "dist/src/tool/registry/ToolRegistry.js")).href),
    import(pathToFileURL(join(root, "dist/src/tool/builtin/readFile.js")).href),
    import(pathToFileURL(join(root, "dist/src/tool/builtin/writeFile.js")).href),
    import(pathToFileURL(join(root, "dist/src/tool/builtin/bash.js")).href),
  ]);

  const workspace = await mkdtemp(join(tmpdir(), "pilotdeck-tool-side-effects-"));
  try {
    const existingPath = join(workspace, "existing.txt");
    const processPath = join(workspace, "process.txt");
    await writeFile(existingPath, "original content\n", "utf8");
    const audit = [];
    const registry = new ToolRegistry();
    registry.register(createReadFileTool());
    registry.register(createWriteFileTool());
    registry.register(createBashTool({ defaultTimeoutMs: 5_000, maxTimeoutMs: 5_000 }));
    const runtime = new ToolRuntime(registry, {
      async decide() {
        return { type: "allow", reason: { type: "runtime", message: "fixture approval" } };
      },
    });
    const context = {
      sessionId: "tool-side-effect-session",
      turnId: "tool-side-effect-turn",
      cwd: workspace,
      permissionMode: "default",
      permissionContext: {
        mode: "default",
        rules: { allow: [], deny: [], ask: [] },
        cwd: workspace,
        additionalWorkingDirectories: [],
        canPrompt: false,
        bypassAvailable: false,
      },
      now: () => new Date("2026-09-19T00:00:00.000Z"),
      readFileState: new Map(),
      writeSnapshots: new Map(),
      auditRecorder: {
        recordPermission: (record) => audit.push({ kind: "permission", ...record }),
        recordTool: (record) => audit.push({ kind: "tool", ...record }),
      },
    };

    const initial = await runtime.execute({
      id: "read-1",
      name: "read_file",
      input: { file_path: "existing.txt" },
    }, context);
    const write = await runtime.execute({
      id: "write-1",
      name: "write_file",
      input: { file_path: "existing.txt", content: "updated by tool\n" },
    }, context);
    const create = await runtime.execute({
      id: "write-2",
      name: "write_file",
      input: { file_path: "created.txt", content: "created by tool\n" },
    }, context);
    const readAfterWrite = await runtime.execute({
      id: "read-2",
      name: "read_file",
      input: { file_path: "existing.txt" },
    }, context);
    const missing = await runtime.execute({
      id: "read-missing",
      name: "read_file",
      input: { file_path: "missing.txt" },
    }, context);
    await writeFile(existingPath, "external edit\n", "utf8");
    const staleWrite = await runtime.execute({
      id: "write-stale",
      name: "write_file",
      input: { file_path: "existing.txt", content: "must not overwrite\n" },
    }, context);
    const process = await runtime.execute({
      id: "bash-1",
      name: "bash",
      input: { command: "printf process-side-effect > process.txt", description: "write process fixture" },
    }, context);

    const files = {
      existing: await readFile(existingPath, "utf8"),
      created: await readFile(join(workspace, "created.txt"), "utf8"),
      process: await readFile(processPath, "utf8"),
      existingKind: (await stat(existingPath)).isFile() ? "file" : "other",
    };
    return {
      comparable: normalize({
      results: { initial, write, create, readAfterWrite, missing, staleWrite, process },
      files,
      // operationId is an additive candidate audit field; it is retained in
      // auditExtensions below rather than silently discarded from evidence.
      audit: audit.map(({ operationId: _operationId, ...record }) => record),
      }, workspace),
      // B0's audit shape predates operationId. Keep this additive field
      // explicit instead of erasing it from the comparison.
      auditExtensions: audit
        .filter((record) => record.operationId !== undefined)
        .map(({ operationId, toolCallId }) => ({ operationId, toolCallId })),
    };
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
}

function normalize(value, workspace) {
  if (typeof value === "string") {
    return value.replaceAll(workspace, "<workspace>");
  }
  if (Array.isArray(value)) return value.map((item) => normalize(item, workspace));
  if (!value || typeof value !== "object") return value;
  const result = {};
  for (const [key, item] of Object.entries(value)) {
    if (key === "durationMs") {
      result[key] = 0;
    } else if (key === "mtimeMs") {
      result[key] = "<mtime>";
    } else {
      result[key] = normalize(item, workspace);
    }
  }
  return result;
}
