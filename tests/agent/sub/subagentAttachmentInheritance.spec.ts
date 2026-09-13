import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { AgentLoop } from "../../../src/agent/loop/AgentLoop.js";
import type { AgentRuntimeDependencies } from "../../../src/agent/runtime/AgentRuntimeDependencies.js";
import type { AgentEvent } from "../../../src/agent/protocol/events.js";
import type { CanonicalModelEvent } from "../../../src/model/index.js";
import { PermissionRuntime, createDefaultPermissionContext } from "../../../src/permission/index.js";
import { ToolRegistry } from "../../../src/tool/index.js";
import { ToolRuntime } from "../../../src/tool/execution/ToolRuntime.js";
import { ConcurrentToolScheduler } from "../../../src/tool/scheduler/ConcurrentToolScheduler.js";
import { createAgentTool } from "../../../src/tool/builtin/agent.js";
import { createReadFileTool } from "../../../src/tool/builtin/readFile.js";

async function inspectAttachment(registered: boolean, parentReadsFirst = false) {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-child-attachment-"));
  const cwd = join(root, "project");
  mkdirSync(cwd);
  const attachment = join(root, "uploaded.txt");
  writeFileSync(attachment, "UPLOADED_CONTENT_713");
  const events: AgentEvent[] = [];
  const registry = new ToolRegistry();
  registry.register(createAgentTool());
  registry.register(createReadFileTool());
  let parentTurns = 0;
  let childTurns = 0;
  const dependencies: AgentRuntimeDependencies = {
    tools: { registry, scheduler: new ConcurrentToolScheduler(new ToolRuntime(registry, new PermissionRuntime()), registry) },
    eventEmitter: e => { events.push(e); },
    router: {
      decide: async ({ request }) => ({ provider: request.provider, model: request.model,
        scenarioType: "default", isSubagent: Boolean(request.metadata?.subagentId),
        orchestrating: false, resolvedFrom: "fallback", mutations: {} }),
      execute: async function* (_decision, request): AsyncIterable<CanonicalModelEvent> {
        const child = Boolean(request.metadata?.subagentId);
        const turn = child ? childTurns++ : parentTurns++;
        if (!child && parentReadsFirst && turn === 0) {
          yield { type: "tool_call_end", toolCall: { id: "parent-read", name: "read_file", input: { file_path: attachment } } };
        } else if (turn === (child || !parentReadsFirst ? 0 : 1)) {
          yield { type: "tool_call_end", toolCall: child
            ? { id: "read", name: "read_file", input: { file_path: attachment } }
            : { id: "delegate", name: "agent", input: { description: "Read attachment", prompt: `Read ${attachment}`, subagent_type: "explore" } } };
        } else {
          yield { type: "text_delta", text: "Scope: attachment\nResult: done\nKey files: none\nFiles changed: none\nIssues: none" };
        }
        yield { type: "message_end", finishReason: "stop" };
      },
      stream: async function* () { throw new Error("Unexpected legacy call"); },
    },
  };
  try {
    const loop = new AgentLoop({ provider: "test", model: "text", cwd, runMode: "agent", permissionMode: "default",
      permissionContext: createDefaultPermissionContext({ cwd, mode: "default", canPrompt: false, bypassAvailable: false }),
    }, dependencies);
    const g = loop.run({ sessionId: "parent", turnId: "t1", maxTurns: 4,
      allowedReadFiles: registered ? [attachment] : [],
      messages: [{ role: "user", content: [{ type: "text", text: "Inspect the attachment" }] }],
    });
    while (!(await g.next()).done) { /* consume real agent/tool loop */ }
    return events.filter((e): e is Extract<AgentEvent, { type: "subagent_tool_result" }> => e.type === "subagent_tool_result")
      .map(e => e.result).find(r => r.toolName === "read_file");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test("subagents can read an attachment explicitly registered by their parent", async () => {
  const result = await inspectAttachment(true);
  assert.equal(result?.type, "success");
  assert.match(JSON.stringify(result?.content), /UPLOADED_CONTENT_713/);
});

test("subagents do not gain read access to unregistered files outside the project", async () => {
  const result = await inspectAttachment(false);
  assert.equal(result?.type, "error");
  assert.doesNotMatch(JSON.stringify(result?.content), /UPLOADED_CONTENT_713/);
});

test("a child receives file contents even when the parent has already read the file", async () => {
  const result = await inspectAttachment(true, true);
  assert.equal(result?.type, "success");
  assert.match(JSON.stringify(result?.content), /UPLOADED_CONTENT_713/);
});
