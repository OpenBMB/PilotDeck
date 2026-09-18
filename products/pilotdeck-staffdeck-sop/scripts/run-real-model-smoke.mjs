import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";

import { createLocalGateway } from "../../../dist/src/cli/createLocalGateway.js";

const SOP_DEFINITION = `sops:
  - id: real_model_smoke
    version: "1"
    name: Real model SOP smoke
    content:
      start_node_id: confirm
      nodes:
        - node_id: confirm
          type: handoff
          instruction: Read approval-context.txt using read_file before submitting this SOP result.
          allowed_actions:
            - "call_tool:read_file"
      terminal_node_ids: [confirm]
`;

const sourcePilotHome = process.env.REAL_MODEL_SOURCE_PILOT_HOME ?? process.env.PILOT_HOME;
const sopEndpoint = process.env.STAFFDECK_SOP_SMOKE_ENDPOINT;
if (!sourcePilotHome || !sopEndpoint) {
  throw new Error("Set REAL_MODEL_SOURCE_PILOT_HOME (or PILOT_HOME) and STAFFDECK_SOP_SMOKE_ENDPOINT.");
}

const sourceConfig = YAML.parse(await readFile(join(sourcePilotHome, "pilotdeck.yaml"), "utf8"));
const selected = process.env.REAL_MODEL_SMOKE_MODEL
  ?? (typeof sourceConfig?.agent?.model === "string" ? sourceConfig.agent.model : undefined);
const [providerId] = selected?.split("/") ?? [];
const provider = providerId ? sourceConfig?.model?.providers?.[providerId] : undefined;
if (!selected || !providerId || !provider) {
  throw new Error("The source config must select a string agent.model with a configured provider.");
}

const root = await mkdtemp(join(tmpdir(), "pilotdeck-real-sop-smoke-"));
const projectRoot = join(root, "project");
const sessionKey = "real-model-sop-smoke";
try {
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, "approval-context.txt"), "Real-model business-tool smoke context.\n", "utf8");
  await writeFile(join(projectRoot, "onboarding.yaml"), SOP_DEFINITION, "utf8");
  await writeFile(join(projectRoot, "pilotdeck.yaml"), YAML.stringify({
    schemaVersion: 1,
    agent: {
      model: selected,
      maxContextTokens: 65536,
      maxOutputTokens: 8192,
    },
    model: { providers: { [providerId]: provider } },
    modules: {
      agentLoop: { enabled: true, provider: "pilotdeck" },
      modelProvider: { enabled: true, provider: "pilotdeck" },
      tools: { enabled: true, provider: "pilotdeck" },
      sop: {
        enabled: true,
        provider: "staffdeck",
        endpoint: sopEndpoint,
        definitionsPath: "onboarding.yaml",
        defaultSopId: "real_model_smoke",
        timeoutMs: 30000,
      },
    },
  }), "utf8");

  const local = createLocalGateway({
    projectRoot,
    pilotHome: projectRoot,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
  });
  try {
    const handoffEvents = [];
    for await (const event of local.gateway.submitTurn({
      sessionKey,
      channelKey: "smoke",
      workspaceCwd: projectRoot,
      message: "First call read_file for approval-context.txt. After it succeeds, call submit_step_result with status handoff and replyFragment 'Waiting for real-model approval.'.",
      mode: "bypassPermissions",
    })) {
      handoffEvents.push(event);
    }
    const failure = handoffEvents.find((event) => event.type === "error");
    assert.equal(failure, undefined, failure ? JSON.stringify(failure) : "unexpected gateway error");
    const handoffEventSummary = summarizeEvents(handoffEvents);
    assert.ok(
      handoffEvents.some((event) =>
        event.type === "tool_call_finished" && event.ok && event.toolName === "read_file"),
      `the real model did not execute the required PilotDeck business tool: ${JSON.stringify(handoffEventSummary)}`,
    );
    const waiting = await local.gateway.sopStatus({ sessionKey, projectKey: projectRoot });
    assert.equal(waiting?.state.status, "handoff", "the real model did not enter the handoff state");
    assert.equal(waiting?.wait?.kind, "handoff");
    const resumed = await local.gateway.resumeSop({
      sessionKey,
      projectKey: projectRoot,
      requestId: "real-model-approval-1",
      waitId: waiting.wait.id,
      source: "human",
      message: "Approval received. Call submit_step_result with status completed and a brief reply.",
      expectedRevision: waiting.revision,
    });
    const completionEvents = [];
    for await (const event of local.gateway.submitTurn({
      sessionKey,
      channelKey: "smoke",
      workspaceCwd: projectRoot,
      message: resumed.message,
      mode: "bypassPermissions",
    })) {
      completionEvents.push(event);
    }
    const completionFailure = completionEvents.find((event) => event.type === "error");
    assert.equal(completionFailure, undefined, completionFailure ? JSON.stringify(completionFailure) : "unexpected gateway error");
    const statePath = join(projectRoot, "sop", "sessions", `${Buffer.from(sessionKey, "utf8").toString("base64url")}.json`);
    const state = JSON.parse(await readFile(statePath, "utf8"));
    assert.equal(state.state.status, "completed", "the real model did not complete the SOP control step");
    console.log(JSON.stringify({
      status: "passed",
      provider: providerId,
      model: selected.slice(providerId.length + 1),
      handoffEventTypes: [...new Set(handoffEvents.map((event) => event.type))],
      completionEventTypes: [...new Set(completionEvents.map((event) => event.type))],
      sopStatus: state.state.status,
    }));
  } finally {
    await local.dispose();
  }
} finally {
  await rm(root, { recursive: true, force: true });
}

function summarizeEvents(events) {
  return events.map((event) => {
    const summary = { type: event.type };
    if (event.type === "tool_call_started") summary.toolName = event.name;
    if (event.type === "tool_call_finished") {
      summary.toolName = event.toolName;
      summary.ok = event.ok;
    }
    if (event.type === "error") summary.code = event.code;
    return summary;
  });
}
