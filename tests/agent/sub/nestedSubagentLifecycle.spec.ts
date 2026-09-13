import assert from "node:assert/strict";
import test from "node:test";
import { AgentLoop } from "../../../src/agent/loop/AgentLoop.js";
import type { AgentRuntimeDependencies } from "../../../src/agent/runtime/AgentRuntimeDependencies.js";
import type { AgentEvent } from "../../../src/agent/protocol/events.js";
import type { CanonicalModelEvent } from "../../../src/model/index.js";
import { resolveSubagentProfiles } from "../../../src/agent/sub/subagentProfiles.js";
import { PermissionRuntime, createDefaultPermissionContext } from "../../../src/permission/index.js";
import { ToolRegistry } from "../../../src/tool/index.js";
import { ToolRuntime } from "../../../src/tool/execution/ToolRuntime.js";
import { ConcurrentToolScheduler } from "../../../src/tool/scheduler/ConcurrentToolScheduler.js";
import { createAgentTool } from "../../../src/tool/builtin/agent.js";

async function runNested(cancelLeaf: boolean) {
  const controller = new AbortController();
  const events: AgentEvent[] = [];
  const started: Array<{ sessionId: string; subagentSessionId?: string; subagentType: string }> = [];
  const completed: Array<{ subagentType: string; errored?: boolean }> = [];
  const turns = new Map<string, number>();
  const routes: Array<{ role: string; provider: string; model: string }> = [];
  const registry = new ToolRegistry();
  registry.register(createAgentTool());
  const dependencies: AgentRuntimeDependencies = {
    tools: { registry, scheduler: new ConcurrentToolScheduler(new ToolRuntime(registry, new PermissionRuntime()), registry) },
    eventEmitter: event => { events.push(event); },
    getSubagentModels: () => [{ id: "specialist/reviewer", provider: "specialist", model: "reviewer",
      description: "Review evidence", modelMultimodal: { input: ["text"] }, maxContextTokens: 16000, maxOutputTokens: 2000 }],
    subagentTranscript: {
      recordSubagentStarted: async entry => { started.push(entry); },
      recordSubagentCompleted: async entry => { completed.push(entry); },
    },
    router: {
      decide: async ({ request }) => ({ provider: request.provider, model: request.model,
        scenarioType: "default", isSubagent: Boolean(request.metadata?.subagentId),
        orchestrating: false, resolvedFrom: "fallback", mutations: {} }),
      execute: async function* (_decision, request): AsyncIterable<CanonicalModelEvent> {
        const role = String(request.metadata?.subagentType ?? "parent");
        routes.push({ role, provider: request.provider, model: request.model });
        const turn = turns.get(role) ?? 0;
        turns.set(role, turn + 1);
        if (role === "leaf" && cancelLeaf) {
          controller.abort();
          return;
        }
        if (turn === 0 && role !== "leaf") {
          const child = role === "parent" ? "dispatcher" : "leaf";
          yield { type: "tool_call_end", toolCall: { id: `call-${child}`, name: "agent",
            input: { description: `Run ${child}`, prompt: "Report the evidence.", subagent_type: child } } };
        } else {
          yield { type: "text_delta", text: "Scope: inspection\nResult: evidence\nKey files: none\nFiles changed: none\nIssues: none" };
        }
        yield { type: "message_end", finishReason: "stop" };
      },
      stream: async function* () { throw new Error("Unexpected legacy call"); },
    },
  };
  const cwd = process.cwd();
  const generator = new AgentLoop({ provider: "test", model: "text", cwd,
    runMode: "agent", permissionMode: "default", maxSubagentDepth: 2,
    permissionContext: createDefaultPermissionContext({ cwd, mode: "default", canPrompt: false, bypassAvailable: false }),
    subagentProfiles: resolveSubagentProfiles({
      dispatcher: { description: "Delegate inspection", tools: ["agent"], readOnly: true },
      leaf: { description: "Inspect evidence", model: "specialist/reviewer", tools: [], readOnly: true },
    }),
  }, dependencies).run({ sessionId: "root-session", turnId: "root-turn", maxTurns: 4,
    abortSignal: controller.signal,
    messages: [{ role: "user", content: [{ type: "text", text: "Delegate an inspection" }] }],
  });
  let result;
  while (true) {
    const next = await generator.next();
    if (next.done) { result = next.value; break; }
  }
  return { events, started, completed, result, routes };
}

test("nested lifecycle reaches the root while transcripts retain their parent session", async () => {
  const { events, started, completed, routes } = await runNested(false);
  assert.equal(started.length, 2);
  assert.equal(completed.length, 2);
  assert.ok(completed.every(entry => !entry.errored));
  assert.equal(started[0]?.sessionId, "root-session");
  assert.equal(started[1]?.sessionId, started[0]?.subagentSessionId);
  const lifecycle = events.filter(event => event.type === "subagent_started" || event.type === "subagent_completed");
  assert.equal(lifecycle.length, 4);
  assert.ok(lifecycle.every(event => event.sessionId === "root-session" && event.turnId === "root-turn"));
  const leafStart = lifecycle.find(event => event.type === "subagent_started" && event.subagentType === "leaf");
  assert.ok(leafStart && "subagentId" in leafStart);
  assert.ok(events.some(event => event.type === "subagent_model_event" && event.subagentId === leafStart.subagentId));
  // Child-only setup events must not create unknown sessions in the host stream.
  const instructionEvents = events.filter(event => event.type === "instructions_loaded");
  assert.ok(instructionEvents.length > 0);
  assert.ok(instructionEvents.every(event => event.sessionId === "root-session"));
  assert.deepEqual(routes.filter(route => route.role === "leaf"), [{ role: "leaf", provider: "specialist", model: "reviewer" }]);
});

test("cancelling nested work stops both child levels and records failure", async () => {
  const { events, started, completed, result } = await runNested(true);
  assert.equal(started.length, 2);
  assert.equal(result.result.type, "aborted");
  assert.equal(completed.length, 2);
  assert.ok(completed.every(entry => entry.errored));
  const stopped = events.filter(event => event.type === "subagent_completed");
  assert.equal(stopped.length, 2);
  assert.ok(stopped.every(event => !event.success && event.aborted));
});
