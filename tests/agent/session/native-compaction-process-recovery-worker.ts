import { mkdirSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

import {
  createAgentSessionWithStorage,
  createInitialAgentSessionState,
} from "../../../src/agent/index.js";
import { DefaultContextRuntime } from "../../../src/context/DefaultContextRuntime.js";
import { TokenBudgetManager } from "../../../src/context/budget/TokenBudgetManager.js";
import { AutoCompactionPolicy } from "../../../src/context/compaction/AutoCompactionPolicy.js";
import { CompactionEngine } from "../../../src/context/compaction/CompactionEngine.js";
import { MicroCompactionEngine } from "../../../src/context/compaction/MicroCompactionEngine.js";
import { SnipEngine } from "../../../src/context/compaction/SnipEngine.js";
import type { AgentRuntimeConfig } from "../../../src/agent/runtime/AgentRuntimeConfig.js";
import type { CanonicalModelRequest, CanonicalMessage } from "../../../src/model/index.js";
import { createDefaultPermissionContext } from "../../../src/permission/protocol/types.js";
import { resumeAgentSession } from "../../../src/session/resume/resumeAgentSession.js";
import { createAgentProjectSessionStorage } from "../../../src/session/storage/ProjectSessionStorage.js";
import { readTranscript } from "../../../src/session/transcript/TranscriptReader.js";
import { ToolRegistry } from "../../../src/tool/registry/ToolRegistry.js";

const [mode, suppliedRoot] = process.argv.slice(2);
if ((mode !== "before-commit" && mode !== "after-commit" && mode !== "summary-failure" && mode !== "summary-cancel" && mode !== "recover") || !suppliedRoot) {
  throw new Error("Usage: native-compaction-process-recovery-worker <before-commit|after-commit|summary-failure|summary-cancel|recover> <root>");
}

const root = resolve(suppliedRoot);
const scenario = process.env.PILOTDECK_COMPACTION_RECOVERY_SCENARIO ?? "default";
const sessionId = `native-compaction-process-${scenario}`;
const readyPath = join(root, `${scenario}.${mode}.ready.json`);
const reportPath = join(root, `${scenario}.${mode}.report.json`);

if (mode === "recover") {
  await recover();
} else {
  await compactAndPause(mode);
}

async function compactAndPause(
  phase: "before-commit" | "after-commit" | "summary-failure" | "summary-cancel",
): Promise<void> {
  mkdirSync(root, { recursive: true });
  const storage = createAgentProjectSessionStorage({ projectRoot: root, pilotHome: root, sessionId });
  const history = seedHistory();
  await storage.transcript.recordAcceptedInput(sessionId, "seed", [history[0]!]);
  for (const message of history.slice(1)) {
    await storage.transcript.recordDurableMessage(sessionId, "seed", message);
  }
  await storage.transcript.recordTurnResult(sessionId, "seed", successfulTurn("seed"));

  const tokenBudget = new TokenBudgetManager();
  const cancellation = new AbortController();
  const compactionEngine = new CompactionEngine({
    provider: "test",
    model_: "test-model",
    tokenBudget,
    model: {
      async *stream() {
        if (phase === "summary-failure") {
          yield {
            type: "error" as const,
            error: {
              provider: "test",
              protocol: "openai" as const,
              code: "server_error",
              message: "native summary provider unavailable",
              retryable: true,
            },
          };
          return;
        }
        yield { type: "message_start" as const, role: "assistant" as const };
        if (phase === "summary-cancel") {
          cancellation.abort("cancel_native_summary");
          return;
        }
        yield { type: "text_delta" as const, text: "## Objective\nNative checkpoint from the terminated child process." };
        yield { type: "message_end" as const, finishReason: "stop" as const };
      },
    },
    eventEmitter: (event) => {
      if (phase !== "before-commit" || event.type !== "compact_completed" || event.status !== "success") return;
      // This is emitted only after the native summary stream has completed and
      // the CompactionEngine has assembled its durable replacement result.
      writeFileSync(readyPath, JSON.stringify({ phase, event }), "utf8");
      pauseUntilKilled();
    },
  });
  const context = new DefaultContextRuntime({
    tokenBudget,
    autoCompactionPolicy: new AutoCompactionPolicy({ tokenBudget }),
    compactionEngine,
    microCompaction: new MicroCompactionEngine(),
    snipEngine: new SnipEngine(),
    // The manual path bypasses pressure policy, but the native full-summary
    // planner still retains its tail relative to this real context window.
    // Keep it small enough that the seeded durable history has a summary leg.
    maxContextTokens: 128,
  });
  const initialState = createInitialAgentSessionState(sessionId);
  initialState.messages = structuredClone(history);
  const created = createAgentSessionWithStorage({
    sessionId,
    config: sessionConfig(root),
    storage,
    initialState,
    collectFileArtifacts: false,
    dependencies: sessionDependencies(context),
  });

  const outcome = await created.session.compact({
    turnId: `manual-${phase}`,
    abortSignal: cancellation.signal,
  });
  if (phase === "summary-failure" && outcome.type !== "failed") {
    throw new Error(`Native summary failure did not terminalize as failed: ${JSON.stringify(outcome)}`);
  }
  if (phase === "summary-cancel" && outcome.type !== "aborted") {
    throw new Error(`Native summary cancellation did not terminalize as aborted: ${JSON.stringify(outcome)}`);
  }
  if ((phase === "before-commit" || phase === "after-commit") && outcome.type !== "compacted") {
    throw new Error(`Native manual compaction did not commit: ${JSON.stringify(outcome)}`);
  }
  if (phase === "after-commit") {
    const transcript = await readTranscript(storage.transcriptPath);
    writeFileSync(readyPath, JSON.stringify({
      phase,
      compactBoundaries: compactBoundaryCount(transcript.entries),
      outcome,
    }), "utf8");
    pauseUntilKilled();
  }
  if (phase === "summary-failure" || phase === "summary-cancel") {
    const transcript = await readTranscript(storage.transcriptPath);
    writeFileSync(reportPath, JSON.stringify({
      phase,
      outcome: outcome.type,
      compactBoundaries: compactBoundaryCount(transcript.entries),
      compactionFailures: transcript.entries.filter((entry) => entry.type === "compaction_failed").length,
    }), "utf8");
    await created.handle.dispose();
  }
}

async function recover(): Promise<void> {
  const requests: CanonicalModelRequest[] = [];
  const resumed = await resumeAgentSession({
    sessionId,
    projectStorage: { projectRoot: root, pilotHome: root },
    config: sessionConfig(root),
    collectFileArtifacts: false,
    dependencies: sessionDependencies(new DefaultContextRuntime(), requests),
  });
  try {
    for await (const _event of resumed.session.submit(
      { type: "text", text: "Continue after the child process restart." },
      { turnId: "post-restart", maxTurns: 1 },
    )) {
      // Drain the ordinary native AgentLoop request after durable recovery.
    }
  } finally {
    await resumed.handle.dispose();
  }
  const transcript = await readTranscript(resumed.transcriptPath);
  writeFileSync(reportPath, JSON.stringify({
    diagnostics: resumed.diagnostics,
    compactBoundaries: compactBoundaryCount(transcript.entries),
    compactionStarts: transcript.entries.filter((entry) => entry.type === "compaction_started").length,
    requests: requests.map((request) => structuredClone(request.messages)),
  }), "utf8");
}

function sessionConfig(cwd: string): AgentRuntimeConfig {
  return {
    provider: "test",
    model: "test-model",
    cwd,
    maxContextTokens: 131_072,
    maxOutputTokens: 1_024,
    permissionMode: "bypassPermissions",
    permissionContext: createDefaultPermissionContext({
      cwd,
      mode: "bypassPermissions",
      canPrompt: false,
      bypassAvailable: true,
    }),
  };
}

function sessionDependencies(context: DefaultContextRuntime, requests?: CanonicalModelRequest[]) {
  return {
    router: {} as never,
    context,
    tools: { registry: new ToolRegistry() },
    ports: {
      model: {
        async prepare({ request }: { request: CanonicalModelRequest }) {
          requests?.push(structuredClone(request));
          return { request, provider: request.provider, model: request.model };
        },
        async *stream() {
          yield { type: "message_start" as const, role: "assistant" as const };
          yield { type: "text_delta" as const, text: "Recovered ordinary response." };
          yield { type: "message_end" as const, finishReason: "stop" as const };
        },
      },
    },
  };
}

function seedHistory(): CanonicalMessage[] {
  const history: CanonicalMessage[] = [
    { role: "user", content: [{ type: "text", text: "Original request must survive an uncommitted compaction." }] },
    { role: "assistant", content: [{ type: "text", text: "Original response must survive an uncommitted compaction." }] },
    { role: "user", content: [{ type: "text", text: "Earlier durable planning detail for native summary generation." }] },
    { role: "assistant", content: [{ type: "text", text: "Earlier durable planning response for native summary generation." }] },
  ];
  for (let index = 0; index < 6; index += 1) {
    history.push(
      { role: "user", content: [{ type: "text", text: `Durable history user turn ${index}.` }] },
      { role: "assistant", content: [{ type: "text", text: `Durable history assistant turn ${index}.` }] },
    );
  }
  return history;
}

function successfulTurn(turnId: string) {
  const now = new Date().toISOString();
  return {
    type: "success" as const,
    sessionId,
    turnId,
    stopReason: "completed" as const,
    usage: {},
    permissionDenials: [],
    turns: 1,
    startedAt: now,
    completedAt: now,
  };
}

function compactBoundaryCount(entries: Awaited<ReturnType<typeof readTranscript>>["entries"]): number {
  return entries.filter((entry) => entry.type === "control_boundary"
    && entry.boundary.kind === "compact"
    && entry.boundary.subtype === "compact_boundary").length;
}

function pauseUntilKilled(): never {
  const gate = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(gate, 0, 0, 60_000);
  throw new Error("The recovery worker was not terminated by the parent process.");
}
