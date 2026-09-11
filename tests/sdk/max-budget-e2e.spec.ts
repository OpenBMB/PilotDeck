import assert from "node:assert/strict";
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createLocalGateway } from "../../src/cli/createLocalGateway.js";
import type { ModelRuntime } from "../../src/model/ModelRuntime.js";
import type {
  CanonicalModelEvent,
  CanonicalModelRequest,
  CanonicalModelResponse,
} from "../../src/model/protocol/canonical.js";
import { DEFAULT_MODEL_CAPABILITIES } from "../../src/model/protocol/capabilities.js";
import type { MultimodalConstraints } from "../../src/model/protocol/multimodal.js";

const TEST_CONFIG = `
schemaVersion: 1
agent:
  model: test/test
  maxContextTokens: 65536
  maxOutputTokens: 8192
router:
  enabled: false
model:
  providers:
    test:
      protocol: openai
      url: http://127.0.0.1:1
      apiKey: test-only
      models:
        test:
          capabilities:
            supportsToolUse: true
            maxContextTokens: 32768
            maxOutputTokens: 8192
`;

class BudgetToolCallModel implements ModelRuntime {
  requests = 0;

  async *stream(_request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
    this.requests += 1;
    yield { type: "request_started", provider: "test", model: "test" };
    yield { type: "message_start", role: "assistant" };
    yield { type: "tool_call_start", id: "write-over-budget", name: "write_file" };
    yield {
      type: "tool_call_end",
      toolCall: {
        id: "write-over-budget",
        name: "write_file",
        input: { file_path: "must-not-be-written.txt", content: "budget must stop first\n" },
      },
    };
    yield { type: "message_end", finishReason: "tool_call" };
  }

  async complete(): Promise<CanonicalModelResponse> {
    return { role: "assistant", content: [], finishReason: "tool_call" };
  }

  getCapabilities() { return DEFAULT_MODEL_CAPABILITIES; }
  getMultimodal(): MultimodalConstraints { return { input: ["text"] }; }
  getProviderProtocol() { return "openai" as const; }
  getProviderBaseUrl() { return undefined; }
}

test("createLocalGateway owns maxBudgetUsd and stops before an over-budget tool side effect", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-budget-e2e-"));
  const projectRoot = join(root, "project");
  const pilotHome = projectRoot;
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(pilotHome, "pilotdeck.yaml"), TEST_CONFIG, "utf8");
  const model = new BudgetToolCallModel();
  const local = createLocalGateway({
    projectRoot,
    pilotHome,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
    __testModelFactory: () => model,
  });

  try {
    const events: any[] = [];
    for await (const event of local.gateway.submitTurn({
      sessionKey: "sdk:budget-e2e",
      channelKey: "test",
      workspaceCwd: projectRoot,
      message: "write a file",
      mode: "bypassPermissions",
      // Default Router pricing charges $0.50 / million input tokens for
      // the test model, so this threshold is crossed by the first response.
      maxBudgetUsd: 0.000_01,
    })) {
      events.push(event);
    }

    assert.equal(model.requests, 1, JSON.stringify(events));
    assert.equal(events.some((event) => event.type === "tool_call_started"), false);
    const error = events.find((event) => event.type === "error");
    assert.equal(error?.code, "agent_max_budget_reached");
    const completed = events.find((event) => event.type === "turn_completed");
    assert.equal(completed?.finishReason, "max_budget");
    assert.ok((completed?.usage?.inputTokens ?? 0) > 0, "budget must use a local token estimate when provider usage is absent");
    await assert.rejects(() => access(join(projectRoot, "must-not-be-written.txt")));
  } finally {
    local.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("createLocalGateway owns taskBudget across turns and blocks the next native model request", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-task-budget-e2e-"));
  const projectRoot = join(root, "project");
  const pilotHome = projectRoot;
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(pilotHome, "pilotdeck.yaml"), TEST_CONFIG, "utf8");
  const model = new BudgetToolCallModel();
  const local = createLocalGateway({
    projectRoot,
    pilotHome,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
    __testModelFactory: () => model,
  });

  try {
    const first: any[] = [];
    for await (const event of local.gateway.submitTurn({
      sessionKey: "sdk:task-budget-e2e",
      channelKey: "test",
      workspaceCwd: projectRoot,
      message: "write a file",
      mode: "bypassPermissions",
      sdkSessionConfig: { taskBudget: { total: 0.000_01 } },
    })) first.push(event);

    assert.equal(model.requests, 1, JSON.stringify(first));
    assert.equal(first.some((event) => event.type === "tool_call_started"), false);
    assert.equal(first.find((event) => event.type === "error")?.code, "agent_task_budget_reached");
    assert.equal(first.find((event) => event.type === "turn_completed")?.finishReason, "task_budget");
    await assert.rejects(() => access(join(projectRoot, "must-not-be-written.txt")));

    const second: any[] = [];
    for await (const event of local.gateway.submitTurn({
      sessionKey: "sdk:task-budget-e2e",
      channelKey: "test",
      workspaceCwd: projectRoot,
      message: "must not start a second model request",
      mode: "bypassPermissions",
      sdkSessionConfig: { taskBudget: { total: 0.000_01 } },
    })) second.push(event);

    assert.equal(model.requests, 1, JSON.stringify(second));
    assert.equal(second[0]?.code, "agent_task_budget_reached");
    assert.equal(second[1]?.finishReason, "task_budget");
  } finally {
    local.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("taskBudget recovers the Gateway-owned durable ledger after restart without Router stats", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-task-budget-restart-"));
  const projectRoot = join(root, "project");
  const pilotHome = projectRoot;
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(pilotHome, "pilotdeck.yaml"), TEST_CONFIG, "utf8");
  const firstModel = new BudgetToolCallModel();
  const firstGateway = createLocalGateway({
    projectRoot,
    pilotHome,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
    __testModelFactory: () => firstModel,
  });

  try {
    const first: any[] = [];
    for await (const event of firstGateway.gateway.submitTurn({
      sessionKey: "sdk:task-budget-restart",
      channelKey: "test",
      workspaceCwd: projectRoot,
      message: "write a file",
      mode: "bypassPermissions",
      sdkSessionConfig: { taskBudget: { total: 0.000_01 } },
    })) first.push(event);
    assert.equal(firstModel.requests, 1, JSON.stringify(first));
    assert.equal(first.find((event) => event.type === "error")?.code, "agent_task_budget_reached");
  } finally {
    firstGateway.dispose();
  }

  const restartedModel = new BudgetToolCallModel();
  const restartedGateway = createLocalGateway({
    projectRoot,
    pilotHome,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
    __testModelFactory: () => restartedModel,
  });

  try {
    const afterRestart: any[] = [];
    for await (const event of restartedGateway.gateway.submitTurn({
      sessionKey: "sdk:task-budget-restart",
      channelKey: "test",
      workspaceCwd: projectRoot,
      message: "must not start after restart",
      mode: "bypassPermissions",
      sdkSessionConfig: { taskBudget: { total: 0.000_01 } },
    })) afterRestart.push(event);

    assert.equal(restartedModel.requests, 0, JSON.stringify(afterRestart));
    assert.equal(afterRestart[0]?.code, "agent_task_budget_reached");
    assert.equal(afterRestart[1]?.finishReason, "task_budget");
  } finally {
    restartedGateway.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("project taskBudget shares one Gateway-owned ceiling across SDK sessions after restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-project-task-budget-"));
  const projectRoot = join(root, "project");
  const pilotHome = projectRoot;
  const compactEnv = {
    ...process.env,
    PILOTDECK_SDK_TASK_BUDGET_LEDGER_COMPACT_AFTER_RECORDS: "2",
  };
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(pilotHome, "pilotdeck.yaml"), TEST_CONFIG, "utf8");
  const firstModel = new BudgetToolCallModel();
  const firstGateway = createLocalGateway({
    projectRoot,
    pilotHome,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
    env: compactEnv,
    __testModelFactory: () => firstModel,
  });

  try {
    const first: any[] = [];
    for await (const event of firstGateway.gateway.submitTurn({
      sessionKey: "sdk:project-budget-first",
      channelKey: "test",
      workspaceCwd: projectRoot,
      message: "write a file",
      mode: "bypassPermissions",
      sdkSessionConfig: { taskBudget: { total: 0.000_01, scope: "project" } },
    })) first.push(event);
    assert.equal(firstModel.requests, 1, JSON.stringify(first));
    assert.equal(first.find((event) => event.type === "error")?.code, "agent_task_budget_reached");
    if (!firstGateway.gateway.deleteSession) {
      throw new Error("createLocalGateway must expose delete_session");
    }
    await firstGateway.gateway.deleteSession({
      sessionKey: "sdk:project-budget-first",
      projectKey: projectRoot,
    });
    const compacted = (await readFile(
      join(pilotHome, "gateway", "sdk-task-budget-ledger.jsonl"),
      "utf8",
    )).trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(compacted.length, 1, JSON.stringify(compacted));
    assert.equal(compacted[0]?.kind, "snapshot");
    assert.equal(compacted[0]?.scope, "project");
    assert.equal(compacted[0]?.totalUsd, 0.000_01);
  } finally {
    firstGateway.dispose();
  }

  const restartedModel = new BudgetToolCallModel();
  const restartedGateway = createLocalGateway({
    projectRoot,
    pilotHome,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
    env: compactEnv,
    __testModelFactory: () => restartedModel,
  });

  try {
    const second: any[] = [];
    for await (const event of restartedGateway.gateway.submitTurn({
      sessionKey: "sdk:project-budget-second",
      channelKey: "test",
      workspaceCwd: projectRoot,
      message: "must not spend the shared project budget",
      mode: "bypassPermissions",
      sdkSessionConfig: { taskBudget: { total: 0.000_01, scope: "project" } },
    })) second.push(event);

    assert.equal(restartedModel.requests, 0, JSON.stringify(second));
    assert.equal(second[0]?.code, "agent_task_budget_reached");
    assert.equal(second[1]?.finishReason, "task_budget");

    const conflicting: any[] = [];
    for await (const event of restartedGateway.gateway.submitTurn({
      sessionKey: "sdk:project-budget-conflict",
      channelKey: "test",
      workspaceCwd: projectRoot,
      message: "must not raise the shared project budget",
      mode: "bypassPermissions",
      sdkSessionConfig: { taskBudget: { total: 1, scope: "project" } },
    })) conflicting.push(event);

    assert.equal(restartedModel.requests, 0, JSON.stringify(conflicting));
    assert.equal(conflicting[0]?.code, "SDK_PROJECT_TASK_BUDGET_TOTAL_CONFLICT");
  } finally {
    restartedGateway.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("project taskBudget retention starts a new Gateway-owned budget period after restart", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-project-task-budget-retention-"));
  const projectRoot = join(root, "project");
  const pilotHome = projectRoot;
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(pilotHome, "pilotdeck.yaml"), TEST_CONFIG, "utf8");
  const retentionMs = 25;
  const firstModel = new BudgetToolCallModel();
  const firstGateway = createLocalGateway({
    projectRoot,
    pilotHome,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
    __testModelFactory: () => firstModel,
  });

  try {
    const first: any[] = [];
    for await (const event of firstGateway.gateway.submitTurn({
      sessionKey: "sdk:project-budget-retention-first",
      channelKey: "test",
      workspaceCwd: projectRoot,
      message: "spend the first project budget period",
      mode: "bypassPermissions",
      sdkSessionConfig: {
        taskBudget: { total: 0.000_01, scope: "project", projectRetentionMs: retentionMs },
      },
    })) first.push(event);
    assert.equal(firstModel.requests, 1, JSON.stringify(first));
    assert.equal(first.find((event) => event.type === "error")?.code, "agent_task_budget_reached");

    const conflictingRetention: any[] = [];
    for await (const event of firstGateway.gateway.submitTurn({
      sessionKey: "sdk:project-budget-retention-conflict",
      channelKey: "test",
      workspaceCwd: projectRoot,
      message: "must reject a second retention contract",
      mode: "bypassPermissions",
      sdkSessionConfig: {
        taskBudget: { total: 0.000_01, scope: "project", projectRetentionMs: retentionMs * 2 },
      },
    })) conflictingRetention.push(event);
    assert.equal(firstModel.requests, 1, JSON.stringify(conflictingRetention));
    assert.equal(conflictingRetention[0]?.code, "SDK_PROJECT_TASK_BUDGET_RETENTION_CONFLICT");
  } finally {
    firstGateway.dispose();
  }

  await new Promise<void>((resolve) => setTimeout(resolve, retentionMs + 25));

  const restartedModel = new BudgetToolCallModel();
  const restartedGateway = createLocalGateway({
    projectRoot,
    pilotHome,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
    __testModelFactory: () => restartedModel,
  });

  try {
    const restarted: any[] = [];
    for await (const event of restartedGateway.gateway.submitTurn({
      sessionKey: "sdk:project-budget-retention-second",
      channelKey: "test",
      workspaceCwd: projectRoot,
      message: "spend a new project budget period",
      mode: "bypassPermissions",
      sdkSessionConfig: {
        taskBudget: { total: 0.000_01, scope: "project", projectRetentionMs: retentionMs },
      },
    })) restarted.push(event);
    assert.equal(restartedModel.requests, 1, JSON.stringify(restarted));
    assert.equal(restarted.find((event) => event.type === "error")?.code, "agent_task_budget_reached");
  } finally {
    restartedGateway.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
