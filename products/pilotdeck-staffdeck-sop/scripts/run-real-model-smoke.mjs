import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import YAML from "yaml";

import { createLocalGateway } from "../../../dist/src/cli/createLocalGateway.js";
import { getPilotProjectChatDir } from "../../../dist/src/pilot/paths.js";
import { readTranscript } from "../../../dist/src/session/index.js";

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
const knowledgeEndpoint = process.env.REAL_MODEL_KNOWLEDGE_ENDPOINT?.trim();
const knowledgeBaseId = process.env.REAL_MODEL_KNOWLEDGE_BASE_ID?.trim();
const knowledgeTenantId = process.env.REAL_MODEL_KNOWLEDGE_TENANT_ID?.trim() ?? "tenant_demo";
const knowledgeActorUserId = process.env.REAL_MODEL_KNOWLEDGE_ACTOR_USER_ID?.trim() ?? "admin";
const skillName = process.env.REAL_MODEL_SKILL_NAME?.trim() ?? "approval-guide";
if (knowledgeEndpoint && !knowledgeBaseId) {
  throw new Error("REAL_MODEL_KNOWLEDGE_BASE_ID is required when REAL_MODEL_KNOWLEDGE_ENDPOINT is set.");
}
if (!selected || !providerId || !provider) {
  throw new Error("The source config must select a string agent.model with a configured provider.");
}

const root = await mkdtemp(join(tmpdir(), "pilotdeck-real-sop-smoke-"));
const projectRoot = join(root, "project");
const sessionKey = "real-model-sop-smoke";
try {
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, "approval-context.txt"), "Real-model business-tool smoke context.\n", "utf8");
  if (knowledgeEndpoint) {
    await mkdir(join(projectRoot, "skills", skillName), { recursive: true });
    await writeFile(
      join(projectRoot, "skills", skillName, "SKILL.md"),
      "# Approval guide\n\nUse the configured knowledge module to verify the approval policy before requesting operator approval.\n",
      "utf8",
    );
  }
  await writeFile(join(projectRoot, "onboarding.yaml"), SOP_DEFINITION, "utf8");
  const modules = {
    agentLoop: { enabled: true, provider: "pilotdeck" },
    modelProvider: { enabled: true, provider: "pilotdeck" },
    tools: { enabled: true, provider: "pilotdeck" },
    ...(knowledgeEndpoint ? {
      skills: { enabled: true, provider: "pilotdeck" },
      knowledge: {
        enabled: true,
        implementationId: "staffdeck.knowledge",
        contract: "staffdeck.knowledge/v1",
        transport: "module-http-v2",
        endpoint: knowledgeEndpoint,
        manifestPath: "/module-manifest",
        callPath: "/v2/module/call",
        methods: ["query", "resolve_citation"],
      },
    } : {}),
    sop: {
      enabled: true,
      provider: "staffdeck",
      endpoint: sopEndpoint,
      definitionsPath: "onboarding.yaml",
      defaultSopId: "real_model_smoke",
      timeoutMs: 30000,
    },
  };
  await writeFile(join(projectRoot, "pilotdeck.yaml"), YAML.stringify({
    schemaVersion: 1,
    agent: {
      model: selected,
      maxContextTokens: 65536,
      maxOutputTokens: 8192,
    },
    model: { providers: { [providerId]: provider } },
    modules,
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
      message: knowledgeEndpoint
        ? `First call read_skill for ${skillName}, then read_file for approval-context.txt, then call knowledge_query with query 'owner approval before release', tenantId '${knowledgeTenantId}', actorUserId '${knowledgeActorUserId}', knowledgeBaseIds ['${knowledgeBaseId}'], queryType 'answer', maxChunks 8, maxBuckets 4, budgetTokens 4000, and needEvidencePack true. After those succeed, call submit_step_result with status handoff and replyFragment 'Waiting for real-model approval.'.`
        : "First call read_file for approval-context.txt. After it succeeds, call submit_step_result with status handoff and replyFragment 'Waiting for real-model approval.'.",
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
    if (knowledgeEndpoint) {
      assert.ok(
        handoffEvents.some((event) => event.type === "tool_call_finished" && event.ok && event.toolName === "read_skill"),
        `the real model did not consume the configured Skill: ${JSON.stringify(handoffEventSummary)}`,
      );
      assert.ok(
        handoffEvents.some((event) => event.type === "tool_call_finished" && event.ok && event.toolName === "knowledge_query"),
        `the real model did not query StaffDeck Knowledge: ${JSON.stringify(handoffEventSummary)}`,
      );
    }
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
    // Build enough real history that manual compaction cannot be a no-op.
    for (let index = 0; index < 3; index += 1) {
      const historyEvents = [];
      for await (const event of local.gateway.submitTurn({
        sessionKey,
        channelKey: "smoke",
        workspaceCwd: projectRoot,
        message: `Record compaction fixture turn ${index + 1}: ${"durable approval context ".repeat(180)}`,
        mode: "bypassPermissions",
      })) historyEvents.push(event);
      assert.equal(historyEvents.some((event) => event.type === "error"), false, JSON.stringify(summarizeEvents(historyEvents)));
    }
    const compactEvents = [];
    for await (const event of local.gateway.submitTurn({
      sessionKey,
      channelKey: "smoke",
      workspaceCwd: projectRoot,
      message: "/compact",
      mode: "bypassPermissions",
    })) compactEvents.push(event);
    const compactStatus = compactEvents.find((event) =>
      event.type === "agent_status" && event.event === "manual_compaction");
    assert.equal(compactStatus?.detail?.outcome, "compacted", `manual compaction did not complete: ${JSON.stringify(compactEvents)}`);
    const compactTurnId = compactStatus?.detail?.turnId;
    assert.equal(typeof compactTurnId, "string", `manual compaction did not expose a turn id: ${JSON.stringify(compactEvents)}`);
    const transcriptPath = join(
      getPilotProjectChatDir(projectRoot, projectRoot),
      `${sessionKey}.jsonl`,
    );
    const transcript = await readTranscript(transcriptPath);
    const compactEntries = transcript.entries.filter((entry) => entry.turnId === compactTurnId);
    const completedCompaction = compactEntries.find((entry) =>
      entry.type === "compaction_completed" && entry.status === "compacted");
    const durableBoundary = compactEntries.find((entry) =>
      entry.type === "control_boundary"
      && entry.boundary.kind === "compact"
      && entry.boundary.subtype === "compact_boundary"
      && entry.boundary.compactMetadata.summaryGenerated === true);
    assert.ok(completedCompaction, `missing durable compaction completion for ${compactTurnId} in ${transcriptPath}`);
    assert.ok(durableBoundary, `missing durable compact boundary for ${compactTurnId} in ${transcriptPath}`);
    console.log(JSON.stringify({
      status: "passed",
      provider: providerId,
      model: selected.slice(providerId.length + 1),
      handoffEventTypes: [...new Set(handoffEvents.map((event) => event.type))],
      completionEventTypes: [...new Set(completionEvents.map((event) => event.type))],
      compactEventTypes: [...new Set(compactEvents.map((event) => event.type))],
      compactStatus: compactStatus.detail.outcome,
      transcriptPath,
      knowledge: Boolean(knowledgeEndpoint),
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
