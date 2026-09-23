import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { ProjectMemoryBundle } from "../../src/cli/ProjectMemoryBundle.js";
import { createLocalGateway } from "../../src/cli/createLocalGateway.js";
import type { EdgeClawMemoryProvider, MemoryResolver } from "../../src/context/index.js";
import type { EdgeClawMemoryService } from "edgeclaw-memory-core";
import type {
  CanonicalModelEvent,
  CanonicalModelRequest,
  CanonicalModelResponse,
  ModelRuntime,
  MultimodalConstraints,
} from "../../src/model/index.js";
import { DEFAULT_MODEL_CAPABILITIES } from "../../src/model/protocol/capabilities.js";

test("project memory bundle passes project composition into its provider and closes the exact created service once", async () => {
  const calls: string[] = [];
  const service = {
    close() { calls.push("close"); },
  } as unknown as EdgeClawMemoryService;
  const provider = {} as EdgeClawMemoryProvider;
  const bundle = new ProjectMemoryBundle({
    config: {
      enabled: true,
      provider: "edgeclaw",
      captureStrategy: "last_turn",
      includeAssistant: false,
    },
    modelConfig: { providers: {} },
    agentModel: "test/model",
    projectRoot: "/project",
    now: () => new Date(0),
    createProvider: (input) => {
      calls.push(`${input.projectRoot}:${input.agentModel}`);
      return { provider, service };
    },
  });

  assert.deepEqual(bundle.stage(), { memory: provider, memoryService: service, memoryManagement: service });
  const first = bundle.dispose();
  const second = bundle.dispose();
  assert.equal(first, second);
  await first;
  assert.deepEqual(calls, ["/project:test/model", "close"]);
});

test("project memory bundle preserves an explicitly disabled memory profile without a service", async () => {
  let created = 0;
  const bundle = new ProjectMemoryBundle({
    config: { enabled: false, provider: "edgeclaw", captureStrategy: "last_turn", includeAssistant: false },
    projectRoot: "/project",
    createProvider: () => {
      created += 1;
      return undefined;
    },
  });

  assert.deepEqual(bundle.stage(), {});
  await bundle.dispose();
  assert.equal(created, 1);
});

test("local gateway composes and consumes an application-selected memory provider", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-memory-composition-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "pilotdeck.yaml"), [
    "schemaVersion: 1",
    "agent:",
    "  model: test/test",
    "  maxContextTokens: 128000",
    "  maxOutputTokens: 1024",
    "router:",
    "  enabled: false",
    "model:",
    "  providers:",
    "    test:",
    "      protocol: openai",
    "      url: http://127.0.0.1:1",
    "      apiKey: test-only",
    "      models:",
    "        test: {}",
    "",
  ].join("\n"));

  const retrieved: string[] = [];
  const captured: string[] = [];
  const memoryWipes: string[] = [];
  let disposed = 0;
  const model = new MemoryInspectingModel();
  const memory: MemoryResolver = {
    async retrieve(input) {
      retrieved.push(`${input.sessionId}:${input.query}`);
      return { systemContext: "selected memory provider", diagnostics: [] };
    },
    async captureTurn(input) {
      captured.push(input.sessionId);
    },
  };
  const local = createLocalGateway({
    projectRoot: root,
    pilotHome: root,
    env: { PILOT_HOME: root },
    __testModelFactory: () => model,
    memoryProviderFactory: () => ({
      memory,
      management: {
        list: () => [],
        clear: () => undefined as never,
        clearSession: (sessionKey) => { memoryWipes.push(sessionKey); return undefined as never; },
      },
      dispose: () => { disposed += 1; },
    }),
  });
  try {
    for await (const _event of local.gateway.submitTurn({
      sessionKey: "memory-composition-session",
      channelKey: "test",
      projectKey: root,
      message: "Recall the selected memory.",
    })) {
      // Consuming the stream drives the real session/context composition.
    }

    assert.ok(retrieved.length > 0, "the context consumer should call the selected memory provider");
    assert.ok(retrieved.every((entry) => entry.startsWith("memory-composition-session:Recall the selected memory.")));
    assert.deepEqual(captured, ["memory-composition-session"]);
    assert.ok(model.requests.length > 0, "the real session should reach the selected model provider");
    if (!local.gateway.managerSessions) throw new Error("manager_sessions was not composed");
    const managed = await local.gateway.managerSessions({ projectKey: root });
    assert.ok(managed.items.some((item) => (item as { sessionId?: string }).sessionId === "memory-composition-session"));
    if (!local.gateway.memoryWipe) throw new Error("memory_wipe was not composed");
    assert.deepEqual(await local.gateway.memoryWipe({
      projectKey: root,
      sessionKey: "memory-composition-session",
      scope: "session",
    }), { wiped: true, scope: "session" });
    assert.deepEqual(memoryWipes, ["memory-composition-session"]);
  } finally {
    await local.dispose();
  }
  assert.equal(disposed, 1);
});

test("local Gateway enforces configured native archive artifact retention", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-archive-retention-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await writeFile(join(root, "pilotdeck.yaml"), [
    "schemaVersion: 1",
    "agent:",
    "  model: test/test",
    "  maxContextTokens: 128000",
    "  maxOutputTokens: 1024",
    "  router:",
    "    enabled: false",
    "model:",
    "  providers:",
    "    test:",
    "      protocol: openai",
    "      url: http://127.0.0.1:1",
    "      apiKey: test-only",
    "      models:",
    "        test: {}",
    "",
  ].join("\n"));
  const now = new Date(10_000);
  const local = createLocalGateway({
    projectRoot: root,
    pilotHome: root,
    env: { PILOT_HOME: root },
    now: () => now,
    nativeArchiveRetentionMs: 1_000,
    __testModelFactory: () => new MemoryInspectingModel(),
  });
  try {
    const storage = local.registry.createPersistentSessionStorage(root, "archive-session", () => now);
    await mkdir(storage.toolResultsDir, { recursive: true });
    const artifactPath = join(storage.toolResultsDir, "old.txt");
    await writeFile(artifactPath, "expired");
    await utimes(artifactPath, new Date(0), new Date(0));
    if (!local.gateway.nativeArchiveArtifact) throw new Error("native archive artifact was not composed");
    await assert.rejects(
      () => local.gateway.nativeArchiveArtifact!({ sessionKey: "archive-session", projectKey: root, artifactName: "old.txt" }),
      (error: unknown) => error instanceof Error
        && "code" in error
        && (error as { code?: string }).code === "ARCHIVE_ARTIFACT_EXPIRED",
    );
  } finally {
    await local.dispose();
  }
});

class MemoryInspectingModel implements ModelRuntime {
  readonly requests: CanonicalModelRequest[] = [];

  async *stream(request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
    this.requests.push(request);
    yield { type: "request_started", provider: request.provider, model: request.model };
    yield { type: "message_start", role: "assistant" };
    yield { type: "text_delta", text: "memory consumed" };
    yield { type: "message_end", finishReason: "stop" };
  }

  async complete(): Promise<CanonicalModelResponse> {
    return { role: "assistant", content: [], finishReason: "stop" };
  }

  getCapabilities() {
    return { ...DEFAULT_MODEL_CAPABILITIES, maxContextTokens: 128_000, maxOutputTokens: 1_024 };
  }

  getMultimodal(): MultimodalConstraints {
    return { input: ["text"] };
  }

  getProviderProtocol() {
    return "openai" as const;
  }

  getProviderBaseUrl() {
    return undefined;
  }
}
