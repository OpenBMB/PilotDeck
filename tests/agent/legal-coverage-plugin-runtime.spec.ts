import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { createLocalGateway } from "../../src/cli/createLocalGateway.js";
import type { CanonicalMessage, CanonicalModelRequest, ModelRuntime } from "../../src/model/index.js";
import { DEFAULT_MODEL_CAPABILITIES } from "../../src/model/protocol/capabilities.js";
import { DEFAULT_MULTIMODAL_CONSTRAINTS } from "../../src/model/protocol/multimodal.js";
import { readObservationEvents } from "../../src/observability/index.js";
import { createAgentProjectSessionStorage } from "../../src/session/index.js";

const PLUGIN_ROOT = resolve("products/legal/plugins/legal-coverage");
const STATE_ROOT = join(".pilotdeck", "work", "legal-coverage");
const REQUIRED_MATRIX_IDS = [
  "equity-capital-timeline",
  "holding-platform-special-rights",
  "governance-personnel-timeline",
  "contract-key-terms",
  "debt-collateral-liquidity",
  "employment-ip-timeline",
  "legal-authority",
];

test("real gateway drives legal plugin milestones through bounded artifact correction", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-legal-gateway-"));
  const projectRoot = join(root, "project");
  const pilotHome = join(root, "home");
  const installedPlugin = join(projectRoot, ".pilotdeck", "plugins", "legal-coverage");
  const requests: CanonicalModelRequest[] = [];
  await mkdir(projectRoot, { recursive: true });
  await mkdir(pilotHome, { recursive: true });
  await cp(PLUGIN_ROOT, installedPlugin, { recursive: true });
  await writeFile(join(pilotHome, "pilotdeck.yaml"), TEST_CONFIG);

  const runtime = createLocalGateway({
    projectRoot,
    fallbackProjectRoot: projectRoot,
    pilotHome,
    env: { ...process.env, PILOT_HOME: pilotHome },
    __testModelFactory: () => fakeModelRuntime(requests, projectRoot),
  });
  try {
    const events = [];
    for await (const event of runtime.gateway.submitTurn({
      sessionKey: "legal-runtime-session",
      channelKey: "test",
      projectKey: projectRoot,
      message: "Conduct legal due diligence and produce a legal opinion.",
      canPrompt: false,
    })) {
      events.push(event);
    }

    const agentRequests = requests.filter((request) => !messageText(request.messages).includes("Summarize the conversation so far"));
    assert.equal(agentRequests.length, 2, JSON.stringify(events));
    assert.match(messageText(agentRequests[0]?.messages ?? []), /Legal coverage controls are active/u);
    assert.match(messageText(agentRequests[0]?.messages ?? []), /completion-proof\.json/u);
    assert.match(messageText(agentRequests[0]?.messages ?? []), /<legal_coverage_state>/u);
    assert.match(messageText(agentRequests[0]?.messages ?? []), /"milestone": "INIT"/u);
    assert.match(messageText(agentRequests[1]?.messages ?? []), /Artifact validation failed/u);
    assert.match(messageText(agentRequests[1]?.messages ?? []), /"milestone": "COMPLETE"/u);
    assert.equal(agentRequests[1]?.metadata?.legalCoverageState, "validated");
    assert.equal(events.some((event) => event.type === "turn_completed" && event.finishReason === "completed"), true);

    const proof = JSON.parse(await readFile(join(projectRoot, STATE_ROOT, "completion-proof.json"), "utf8")) as { stateHash: string };
    assert.match(proof.stateHash, /^[a-f0-9]{64}$/u);
    assert.equal((await stat(join(projectRoot, "deliverables", "opinion.md"))).size > 0, true);
  } finally {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("real gateway blocks completion when the legal Stop hook cannot read session state", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-legal-stop-failure-"));
  const projectRoot = join(root, "project");
  const pilotHome = join(root, "home");
  const installedPlugin = join(projectRoot, ".pilotdeck", "plugins", "legal-coverage");
  const requests: CanonicalModelRequest[] = [];
  await mkdir(projectRoot, { recursive: true });
  await mkdir(pilotHome, { recursive: true });
  await cp(PLUGIN_ROOT, installedPlugin, { recursive: true });
  await writeFile(join(pilotHome, "pilotdeck.yaml"), TEST_CONFIG);

  const runtime = createLocalGateway({
    projectRoot,
    fallbackProjectRoot: projectRoot,
    pilotHome,
    env: { ...process.env, PILOT_HOME: pilotHome },
    __testModelFactory: () => fakeModelRuntime(requests, projectRoot, { corruptSessionStateAfterProof: true }),
  });
  try {
    const events = [];
    for await (const event of runtime.gateway.submitTurn({
      sessionKey: "legal-stop-failure-session",
      channelKey: "test",
      projectKey: projectRoot,
      message: "Conduct legal due diligence and produce a legal opinion.",
      canPrompt: false,
    })) {
      events.push(event);
    }

    const agentRequests = requests.filter((request) => !isCompactionRequest(request));
    assert.equal(agentRequests.length, 2, JSON.stringify(events));
    assert.equal(events.some((event) => event.type === "error"
      && /Legal coverage Stop hook failed closed/u.test(event.message)), true);
    assert.equal(events.some((event) => event.type === "turn_completed" && event.finishReason === "tool_error"), true);
    assert.equal(events.some((event) => event.type === "turn_completed" && event.finishReason === "completed"), false);
  } finally {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("real gateway executes the state-bound legal authority closure with complete O1 evidence", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-legal-authority-gateway-"));
  const projectRoot = join(root, "project");
  const pilotHome = join(root, "home");
  const installedPlugin = join(projectRoot, ".pilotdeck", "plugins", "legal-coverage");
  const requests: CanonicalModelRequest[] = [];
  await mkdir(projectRoot, { recursive: true });
  await mkdir(pilotHome, { recursive: true });
  await cp(PLUGIN_ROOT, installedPlugin, { recursive: true });
  await writeFile(join(pilotHome, "pilotdeck.yaml"), AUTHORITY_CLOSURE_TEST_CONFIG);
  await writeAuthorityClosureState(projectRoot);

  const runtime = createLocalGateway({
    projectRoot,
    fallbackProjectRoot: projectRoot,
    pilotHome,
    env: { ...process.env, PILOT_HOME: pilotHome, PILOTDECK_BUILD_SHA: "authority-closure-test" },
    __testModelFactory: () => authorityClosureModelRuntime(requests),
  });
  try {
    const events = [];
    for await (const event of runtime.gateway.submitTurn({
      sessionKey: "legal-authority-closure-session",
      channelKey: "test",
      projectKey: projectRoot,
      message: "Continue the configured legal due diligence review.",
      canPrompt: false,
      timeoutMs: 60_000,
    })) {
      events.push(event);
    }

    const agentRequests = requests.filter((request) => !isCompactionRequest(request));
    assert.equal(agentRequests.length, 3, JSON.stringify(events));
    assert.match(messageText(agentRequests[0]?.messages ?? []), /"group": "authority-closure-propose"/u);
    assert.match(messageText(agentRequests[0]?.messages ?? []), /"factId": "F-001"/u);
    assert.match(messageText(agentRequests[1]?.messages ?? []), /"group": "authority-closure-apply"/u);
    assert.match(messageText(agentRequests[1]?.messages ?? []), /authority-closure-apply/u);
    assert.match(messageText(agentRequests[2]?.messages ?? []), /"milestone": "COMPLETE"/u);
    assert.equal(events.some((event) => event.type === "turn_completed" && event.finishReason === "completed"), true);

    const decisions = events.flatMap((event) =>
      event.type === "agent_status" && event.event === "progress_lease_evaluated"
        ? [[event.detail?.decision, event.detail?.progressOrdinal, event.detail?.handoffOrdinal]]
        : []
    );
    assert.deepEqual(decisions, [
      ["baseline", 0, 0],
      ["handoff_grace", 0, 1],
      ["completed", 1, 1],
    ]);

    const stateRoot = join(projectRoot, STATE_ROOT);
    const proof = JSON.parse(await readFile(join(stateRoot, "completion-proof.json"), "utf8")) as { stateHash: string };
    assert.match(proof.stateHash, /^[a-f0-9]{64}$/u);
    const issues = JSON.parse(await readFile(join(stateRoot, "issues.json"), "utf8")) as { issues: Array<{ authorityIds: string[] }> };
    const authorities = JSON.parse(await readFile(join(stateRoot, "authorities.json"), "utf8")) as { authorities: Array<{ id: string; supportedIssueIds: string[] }> };
    assert.deepEqual(issues.issues[0]?.authorityIds, ["A-LEGAL"]);
    assert.deepEqual(authorities.authorities.map((authority) => ({ id: authority.id, supportedIssueIds: authority.supportedIssueIds })), [
      { id: "A-LEGAL", supportedIssueIds: ["I-001"] },
    ]);

    const storage = createAgentProjectSessionStorage({
      projectRoot,
      pilotHome,
      sessionId: "legal-authority-closure-session",
    });
    const observationPath = join(storage.observabilityDir, "observations.jsonl");
    const observations = await readObservationEvents(observationPath);
    const rawObservations = await readFile(observationPath, "utf8");
    const integrity = JSON.parse(await readFile(join(storage.observabilityDir, "integrity.json"), "utf8"));
    assert.equal(integrity.status, "complete");
    assert.equal(integrity.checks.modelRequestsPaired, true);
    assert.equal(integrity.checks.toolCallsPaired, true);
    assert.equal(integrity.checks.turnsPaired, true);
    assert.equal(integrity.recorder.droppedEvents, 0);
    assert.equal(observations.filter((event) => event.type === "tool.call.started").length, 2);
    assert.equal(observations.filter((event) => event.type === "tool.call.completed").length, 2);
    assert.doesNotMatch(rawObservations, /Synthetic transactions act/u);
    assert.doesNotMatch(rawObservations, /test-key/u);
  } finally {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("real gateway hands off a validated ordinary source proposal before renewing from its durable receipt", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-legal-source-apply-gateway-"));
  const projectRoot = join(root, "project");
  const pilotHome = join(root, "home");
  const installedPlugin = join(projectRoot, ".pilotdeck", "plugins", "legal-coverage");
  const requests: CanonicalModelRequest[] = [];
  await mkdir(projectRoot, { recursive: true });
  await mkdir(pilotHome, { recursive: true });
  await cp(PLUGIN_ROOT, installedPlugin, { recursive: true });
  await writeFile(join(pilotHome, "pilotdeck.yaml"), SOURCE_APPLY_TEST_CONFIG);
  await writeSourceApplyState(projectRoot);

  const runtime = createLocalGateway({
    projectRoot,
    fallbackProjectRoot: projectRoot,
    pilotHome,
    env: { ...process.env, PILOT_HOME: pilotHome, PILOTDECK_BUILD_SHA: "source-apply-test" },
    __testModelFactory: () => sourceApplyModelRuntime(requests, projectRoot),
  });
  try {
    const events = [];
    for await (const event of runtime.gateway.submitTurn({
      sessionKey: "legal-source-apply-session",
      channelKey: "test",
      projectKey: projectRoot,
      message: "Continue the configured legal source review.",
      canPrompt: false,
      timeoutMs: 60_000,
    })) {
      events.push(event);
    }

    const agentRequests = requests.filter((request) => !isCompactionRequest(request));
    assert.equal(agentRequests.length, 4, JSON.stringify(events));
    assert.match(messageText(agentRequests[0]?.messages ?? []), /"group": "source-fragment-propose"/u);
    assert.doesNotMatch(messageText(agentRequests[0]?.messages ?? []), /sourceMergeApplyCommand/u);
    assert.match(messageText(agentRequests[1]?.messages ?? []), /"group": "source-fragment-apply"/u);
    assert.match(messageText(agentRequests[1]?.messages ?? []), /source-merge-apply/u);
    assert.match(messageText(agentRequests[2]?.messages ?? []), /"appliedSource":/u);
    assert.match(messageText(agentRequests[3]?.messages ?? []), /"milestone": "COMPLETE"/u);

    const convergence = agentRequests.map((request) => request.metadata?.pilotdeckConvergence as {
      progressOrdinal?: number;
      handoffOrdinal?: number;
    } | undefined);
    assert.deepEqual(convergence.map((item) => item?.progressOrdinal), [0, 0, 1, 2]);
    assert.deepEqual(convergence.map((item) => item?.handoffOrdinal), [0, 1, 1, 1]);
    const decisions = events.flatMap((event) =>
      event.type === "agent_status" && event.event === "progress_lease_evaluated"
        ? [[event.detail?.decision, event.detail?.progressOrdinal, event.detail?.handoffOrdinal]]
        : []
    );
    assert.deepEqual(decisions, [
      ["baseline", 0, 0],
      ["handoff_grace", 0, 1],
      ["renewed", 1, 1],
      ["completed", 2, 1],
    ]);
    assert.equal(events.some((event) => event.type === "turn_completed" && event.finishReason === "completed"), true);
    assert.equal(events.some((event) => event.type === "agent_status"
      && event.event === "progress_lease_evaluated"
      && event.detail?.decision === "fail_closed"), false);

    const storage = createAgentProjectSessionStorage({
      projectRoot,
      pilotHome,
      sessionId: "legal-source-apply-session",
    });
    const observations = await readObservationEvents(join(storage.observabilityDir, "observations.jsonl"));
    const integrity = JSON.parse(await readFile(join(storage.observabilityDir, "integrity.json"), "utf8"));
    assert.equal(integrity.status, "complete");
    assert.equal(integrity.checks.modelRequestsPaired, true);
    assert.equal(integrity.checks.toolCallsPaired, true);
    assert.equal(integrity.checks.turnsPaired, true);
    assert.equal(integrity.recorder.droppedEvents, 0);
    assert.equal(observations.filter((event) => event.type === "tool.call.started").length, 2);
    assert.equal(observations.filter((event) => event.type === "tool.call.completed").length, 2);
  } finally {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("real gateway applies an immutable source repair before renewing legal progress", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-legal-source-repair-gateway-"));
  const projectRoot = join(root, "project");
  const pilotHome = join(root, "home");
  const installedPlugin = join(projectRoot, ".pilotdeck", "plugins", "legal-coverage");
  const requests: CanonicalModelRequest[] = [];
  await mkdir(projectRoot, { recursive: true });
  await mkdir(pilotHome, { recursive: true });
  await cp(PLUGIN_ROOT, installedPlugin, { recursive: true });
  await writeFile(join(pilotHome, "pilotdeck.yaml"), SOURCE_REPAIR_TEST_CONFIG);
  const fixture = await writeSourceRepairState(projectRoot);

  const runtime = createLocalGateway({
    projectRoot,
    fallbackProjectRoot: projectRoot,
    pilotHome,
    env: { ...process.env, PILOT_HOME: pilotHome, PILOTDECK_BUILD_SHA: "source-repair-test" },
    __testModelFactory: () => sourceRepairModelRuntime(requests, projectRoot),
  });
  try {
    const events = [];
    for await (const event of runtime.gateway.submitTurn({
      sessionKey: "legal-source-repair-session",
      channelKey: "test",
      projectKey: projectRoot,
      message: "Continue the configured legal source review.",
      canPrompt: false,
      timeoutMs: 60_000,
    })) {
      events.push(event);
    }

    const agentRequests = requests.filter((request) => !isCompactionRequest(request));
    assert.equal(agentRequests.length, 4, JSON.stringify(events));
    assert.match(messageText(agentRequests[0]?.messages ?? []), /"group": "source-fragment-repair"/u);
    assert.match(messageText(agentRequests[0]?.messages ?? []), /Do not read or overwrite the rejected proposal/u);
    assert.match(messageText(agentRequests[1]?.messages ?? []), /"group": "source-fragment-repair-apply"/u);
    assert.match(messageText(agentRequests[1]?.messages ?? []), /source-repair-apply/u);
    assert.match(messageText(agentRequests[2]?.messages ?? []), /"appliedRepair":/u);
    assert.match(messageText(agentRequests[3]?.messages ?? []), /"milestone": "COMPLETE"/u);
    const convergence = agentRequests.map((request) => request.metadata?.pilotdeckConvergence as {
      progressOrdinal?: number;
      repairPreparationOrdinal?: number;
    } | undefined);
    assert.deepEqual(convergence.map((item) => item?.progressOrdinal), [0, 0, 1, 2]);
    assert.deepEqual(convergence.map((item) => item?.repairPreparationOrdinal), [0, 1, 1, 1]);
    assert.equal(events.some((event) => event.type === "agent_status"
      && event.event === "progress_lease_evaluated"
      && event.detail?.decision === "fail_closed"), false);
    assert.equal(events.some((event) => event.type === "turn_completed" && event.finishReason === "completed"), true);

    assert.deepEqual(await readFile(join(projectRoot, fixture.proposalPath)), fixture.proposalBytes);
    const sources = JSON.parse(await readFile(join(projectRoot, STATE_ROOT, "sources.json"), "utf8")) as {
      sources: Array<{ status: string }>;
    };
    const facts = JSON.parse(await readFile(join(projectRoot, STATE_ROOT, "facts.json"), "utf8")) as {
      facts: Array<{ missingTimeReason?: string }>;
    };
    assert.equal(sources.sources.length, 5);
    assert.equal(sources.sources.every((source) => source.status === "reviewed"), true);
    assert.equal(facts.facts.length, 4);
    assert.equal(facts.facts.slice(0, 2).every((fact) => typeof fact.missingTimeReason === "string"), true);
    assert.equal((await stat(join(projectRoot, fixture.repairPath))).size > 0, true);
    assert.equal((await stat(join(projectRoot, fixture.appliedReceiptPath))).size > 0, true);

    const storage = createAgentProjectSessionStorage({
      projectRoot,
      pilotHome,
      sessionId: "legal-source-repair-session",
    });
    const observationPath = join(storage.observabilityDir, "observations.jsonl");
    const observations = await readObservationEvents(observationPath);
    const integrity = JSON.parse(await readFile(join(storage.observabilityDir, "integrity.json"), "utf8"));
    assert.equal(integrity.status, "complete");
    assert.equal(integrity.checks.modelRequestsPaired, true);
    assert.equal(integrity.checks.toolCallsPaired, true);
    assert.equal(integrity.checks.turnsPaired, true);
    assert.equal(integrity.recorder.droppedEvents, 0);
    assert.equal(observations.filter((event) => event.type === "tool.call.started").length, 2);
    assert.equal(observations.filter((event) => event.type === "tool.call.completed").length, 2);
  } finally {
    await runtime.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

function sourceApplyModelRuntime(
  requests: CanonicalModelRequest[],
  projectRoot: string,
): ModelRuntime {
  return {
    async *stream(request) {
      if (isCompactionRequest(request)) {
        yield { type: "message_start", role: "assistant" };
        yield { type: "text_delta", text: "Continue the validated ordinary source apply." };
        yield { type: "message_end", finishReason: "stop" };
        return;
      }
      requests.push(request);
      const envelope = legalEnvelopeFromMessages(request.messages);
      yield { type: "message_start", role: "assistant" };
      if (envelope?.workItems?.group === "source-fragment-propose") {
        const proposal = {
          ...envelope.workItems.proposal.template,
          facts: envelope.workItems.preparedSlice.sources.map((source: any) => ({
            subject: source.sourceId,
            predicate: "contains reviewed evidence",
            value: source.facts[0].statement,
            missingTimeReason: "The reviewed synthetic source contains no usable date.",
            sourceRefs: [{ sourceId: source.sourceId, locator: source.facts[0].locator }],
            evidenceClass: source.evidenceClass,
            verificationStatus: "verified",
            conflictStatus: "none",
            material: false,
            critical: false,
          })),
          noMaterialFacts: [],
        };
        const toolCall = {
          id: "source-proposal-write",
          name: "write_file",
          input: {
            file_path: envelope.workItems.proposal.path,
            content: `${JSON.stringify(proposal, null, 2)}\n`,
          },
        };
        yield { type: "tool_call_start", id: toolCall.id, name: toolCall.name };
        yield { type: "tool_call_end", toolCall };
        yield { type: "message_end", finishReason: "tool_call" };
        return;
      }
      if (envelope?.workItems?.group === "source-fragment-apply") {
        const toolCall = {
          id: "source-proposal-apply",
          name: "bash",
          input: { command: envelope.sourceMergeApplyCommand },
        };
        yield { type: "tool_call_start", id: toolCall.id, name: toolCall.name };
        yield { type: "tool_call_end", toolCall };
        yield { type: "message_end", finishReason: "tool_call" };
        return;
      }
      await writeCompletedSourceRepairState(projectRoot);
      yield { type: "text_delta", text: "The validated source apply is durable and the synthetic review is complete." };
      yield { type: "usage", usage: { inputTokens: 40, outputTokens: 10, totalTokens: 50 } };
      yield { type: "message_end", finishReason: "stop" };
    },
    async complete() {
      return { role: "assistant", content: [{ type: "text", text: '{"title":"Ordinary source apply QA"}' }], finishReason: "stop" };
    },
    getCapabilities: () => ({ ...DEFAULT_MODEL_CAPABILITIES, maxContextTokens: 1_048_576 }),
    getMultimodal: () => DEFAULT_MULTIMODAL_CONSTRAINTS,
    getProviderProtocol: () => "openai",
    getProviderBaseUrl: () => "https://example.invalid",
  };
}

async function writeSourceApplyState(workspace: string): Promise<void> {
  const stateRoot = join(workspace, STATE_ROOT);
  const sourceRoot = join(workspace, "source-room");
  await mkdir(sourceRoot, { recursive: true });
  await mkdir(join(workspace, "deliverables"), { recursive: true });
  await mkdir(stateRoot, { recursive: true });
  await writeFile(join(workspace, "deliverables", "opinion.md"), "# Draft legal review\n");
  const sources = [];
  for (let index = 1; index <= 5; index += 1) {
    const id = `S-${String(index).padStart(3, "0")}`;
    const path = `source-room/source-${index}.txt`;
    const content = `Reviewed synthetic source ${index}.\n`;
    await writeFile(join(workspace, path), content);
    sources.push({ id, path, content });
  }
  await writeJson(join(stateRoot, "config.json"), {
    schemaVersion: 1,
    enabled: true,
    jurisdiction: "Synthetic jurisdiction",
    basisDate: "Synthetic review date",
    allowNoMaterialFacts: false,
    inputRoots: ["source-room"],
    deliverables: [{ id: "opinion", path: "deliverables/opinion.md", required: true }],
  });
  await writeJson(join(stateRoot, "sources.json"), {
    schemaVersion: 1,
    sources: sources.map((source) => ({
      id: source.id,
      path: source.path,
      sha256: sha256(source.content),
      status: "pending",
    })),
  });
  await writeJson(join(stateRoot, "facts.json"), { schemaVersion: 1, facts: [] });
  await writeJson(join(stateRoot, "matrices.json"), {
    schemaVersion: 1,
    matrices: REQUIRED_MATRIX_IDS.map((id) => ({ id, status: "pending", entries: [] })),
  });
  await writeJson(join(stateRoot, "issues.json"), { schemaVersion: 1, issues: [] });
  await writeJson(join(stateRoot, "authorities.json"), { schemaVersion: 1, authorities: [] });
  await writeJson(join(stateRoot, "coverage.json"), {
    schemaVersion: 1,
    deliverables: [],
    sources: [],
    facts: [],
    issues: [],
    authorities: [],
  });

  const legal = await import(pathToFileURL(join(PLUGIN_ROOT, "scripts", "lib", "legal-coverage.mjs")).href) as any;
  const delegated = await legal.pendingSourceReviewPlan(workspace);
  assert.equal(delegated.group, "pending-source-review");
  assert.equal(delegated.batches.length, 1);
  const batch = delegated.batches[0];
  await mkdir(join(workspace, STATE_ROOT, "fragments"), { recursive: true });
  await writeJson(join(workspace, batch.fragmentPath), {
    schemaVersion: 1,
    fragmentType: "legal-evidence-source-batch-review",
    fragmentId: batch.id,
    assignedSourceIds: batch.sourceIds,
    sources: sources.map((source) => ({
      sourceId: source.id,
      sourcePath: source.path,
      inspectionMethod: "plain-text inspection",
      facts: [{ locator: "line 1", statement: source.content.trim() }],
      evidenceClass: "other",
      verificationState: "verified",
      conflicts: [],
      unresolvedItems: [],
      proposedMateriality: "non-material",
    })),
  });
  const merge = await legal.pendingSourceReviewPlan(workspace);
  assert.equal(merge.group, "source-fragment-merge");
  await legal.prepareSourceMergeProposal(workspace, {
    readinessPath: merge.readiness.path,
    expectedStateHash: merge.proposal.expectedStateHash,
    fragmentPath: merge.proposal.fragmentPath,
    receiptSha256: merge.proposal.receiptSha256,
    sourceIds: merge.proposal.sourceIds,
    maxRecords: 4,
    maxSerializedBytes: 24576,
  });
  assert.equal((await legal.pendingSourceReviewPlan(workspace)).group, "source-fragment-propose");
}

function sourceRepairModelRuntime(
  requests: CanonicalModelRequest[],
  projectRoot: string,
): ModelRuntime {
  return {
    async *stream(request) {
      if (isCompactionRequest(request)) {
        yield { type: "message_start", role: "assistant" };
        yield { type: "text_delta", text: "Continue the immutable legal source repair." };
        yield { type: "message_end", finishReason: "stop" };
        return;
      }
      requests.push(request);
      const envelope = legalEnvelopeFromMessages(request.messages);
      yield { type: "message_start", role: "assistant" };
      if (envelope?.workItems?.group === "source-fragment-repair") {
        const template = structuredClone(envelope.workItems.repair.template);
        template.operations = template.operations.map((operation: any) => {
          const fact = { ...operation.fact };
          delete fact.dateOrPeriod;
          fact.missingTimeReason = "The reviewed synthetic source contains no usable date.";
          return { ...operation, fact };
        });
        const toolCall = {
          id: "source-repair-write",
          name: "write_file",
          input: {
            file_path: envelope.workItems.repair.path,
            content: `${JSON.stringify(template, null, 2)}\n`,
          },
        };
        yield { type: "tool_call_start", id: toolCall.id, name: toolCall.name };
        yield { type: "tool_call_end", toolCall };
        yield { type: "message_end", finishReason: "tool_call" };
        return;
      }
      if (envelope?.workItems?.group === "source-fragment-repair-apply") {
        const toolCall = {
          id: "source-repair-apply",
          name: "bash",
          input: { command: envelope.sourceMergeRepairApplyCommand },
        };
        yield { type: "tool_call_start", id: toolCall.id, name: toolCall.name };
        yield { type: "tool_call_end", toolCall };
        yield { type: "message_end", finishReason: "tool_call" };
        return;
      }
      await writeCompletedSourceRepairState(projectRoot);
      yield { type: "text_delta", text: "The immutable source repair is applied and the synthetic review is complete." };
      yield { type: "usage", usage: { inputTokens: 40, outputTokens: 10, totalTokens: 50 } };
      yield { type: "message_end", finishReason: "stop" };
    },
    async complete() {
      return { role: "assistant", content: [{ type: "text", text: '{"title":"Immutable source repair QA"}' }], finishReason: "stop" };
    },
    getCapabilities: () => ({ ...DEFAULT_MODEL_CAPABILITIES, maxContextTokens: 1_048_576 }),
    getMultimodal: () => DEFAULT_MULTIMODAL_CONSTRAINTS,
    getProviderProtocol: () => "openai",
    getProviderBaseUrl: () => "https://example.invalid",
  };
}

async function writeSourceRepairState(workspace: string): Promise<{
  proposalPath: string;
  proposalBytes: Buffer;
  repairPath: string;
  appliedReceiptPath: string;
}> {
  const stateRoot = join(workspace, STATE_ROOT);
  const sourceRoot = join(workspace, "source-room");
  const deliverablePath = join(workspace, "deliverables", "opinion.md");
  await mkdir(sourceRoot, { recursive: true });
  await mkdir(join(workspace, "deliverables"), { recursive: true });
  await mkdir(stateRoot, { recursive: true });
  await writeFile(deliverablePath, "# Draft legal review\n");
  const sources = [];
  for (let index = 1; index <= 5; index += 1) {
    const id = `S-${String(index).padStart(3, "0")}`;
    const path = `source-room/source-${index}.txt`;
    const content = `Reviewed synthetic source ${index}.\n`;
    await writeFile(join(workspace, path), content);
    sources.push({ id, path, content });
  }
  await writeJson(join(stateRoot, "config.json"), {
    schemaVersion: 1,
    enabled: true,
    jurisdiction: "Synthetic jurisdiction",
    basisDate: "Synthetic review date",
    allowNoMaterialFacts: false,
    inputRoots: ["source-room"],
    deliverables: [{ id: "opinion", path: "deliverables/opinion.md", required: true }],
  });
  await writeJson(join(stateRoot, "sources.json"), {
    schemaVersion: 1,
    sources: sources.map((source) => ({
      id: source.id,
      path: source.path,
      sha256: sha256(source.content),
      status: "pending",
    })),
  });
  await writeJson(join(stateRoot, "facts.json"), { schemaVersion: 1, facts: [] });
  await writeJson(join(stateRoot, "matrices.json"), {
    schemaVersion: 1,
    matrices: REQUIRED_MATRIX_IDS.map((id) => ({ id, status: "pending", entries: [] })),
  });
  await writeJson(join(stateRoot, "issues.json"), { schemaVersion: 1, issues: [] });
  await writeJson(join(stateRoot, "authorities.json"), { schemaVersion: 1, authorities: [] });
  await writeJson(join(stateRoot, "coverage.json"), {
    schemaVersion: 1,
    deliverables: [],
    sources: [],
    facts: [],
    issues: [],
    authorities: [],
  });

  const legal = await import(pathToFileURL(join(PLUGIN_ROOT, "scripts", "lib", "legal-coverage.mjs")).href) as any;
  const delegated = await legal.pendingSourceReviewPlan(workspace);
  assert.equal(delegated.group, "pending-source-review");
  assert.equal(delegated.batches.length, 1);
  const batch = delegated.batches[0];
  await mkdir(join(workspace, STATE_ROOT, "fragments"), { recursive: true });
  await writeJson(join(workspace, batch.fragmentPath), {
    schemaVersion: 1,
    fragmentType: "legal-evidence-source-batch-review",
    fragmentId: batch.id,
    assignedSourceIds: batch.sourceIds,
    sources: sources.map((source) => ({
      sourceId: source.id,
      sourcePath: source.path,
      inspectionMethod: "plain-text inspection",
      facts: [{ locator: "line 1", statement: source.content.trim() }],
      evidenceClass: "other",
      verificationState: "verified",
      conflicts: [],
      unresolvedItems: [],
      proposedMateriality: "non-material",
    })),
  });
  const merge = await legal.pendingSourceReviewPlan(workspace);
  assert.equal(merge.group, "source-fragment-merge");
  await legal.prepareSourceMergeProposal(workspace, {
    readinessPath: merge.readiness.path,
    expectedStateHash: merge.proposal.expectedStateHash,
    fragmentPath: merge.proposal.fragmentPath,
    receiptSha256: merge.proposal.receiptSha256,
    sourceIds: merge.proposal.sourceIds,
    maxRecords: 4,
    maxSerializedBytes: 24576,
  });
  const propose = await legal.pendingSourceReviewPlan(workspace);
  assert.equal(propose.group, "source-fragment-propose");
  const selectedSources = sources.filter((source) => propose.proposal.sourceIds.includes(source.id));
  const proposal = {
    schemaVersion: 1,
    phase: "sources",
    group: "source-fragment-merge",
    expectedStateHash: propose.proposal.expectedStateHash,
    fragmentPath: propose.proposal.fragmentPath,
    receiptSha256: propose.proposal.receiptSha256,
    sourceIds: propose.proposal.sourceIds,
    facts: selectedSources.map((source, index) => ({
      subject: source.id,
      predicate: "contains reviewed evidence",
      value: source.content.trim(),
      ...(index < 2
        ? { dateOrPeriod: null }
        : { missingTimeReason: "The reviewed synthetic source contains no usable date." }),
      sourceRefs: [{ sourceId: source.id, locator: "line 1" }],
      evidenceClass: "other",
      verificationStatus: "verified",
      conflictStatus: "none",
      material: false,
      critical: false,
    })),
    noMaterialFacts: [],
  };
  const proposalPath = propose.proposal.path;
  await writeJson(join(workspace, proposalPath), proposal);
  const proposalBytes = await readFile(join(workspace, proposalPath));
  const repair = await legal.pendingSourceReviewPlan(workspace);
  assert.equal(repair.group, "source-fragment-repair");
  assert.deepEqual(repair.repair.repairSlice.rejectedFacts.map((item: any) => item.factNumber), [1, 2]);
  return {
    proposalPath,
    proposalBytes,
    repairPath: repair.repair.path,
    appliedReceiptPath: repair.repair.appliedReceiptPath,
  };
}

async function writeCompletedSourceRepairState(workspace: string): Promise<void> {
  const stateRoot = join(workspace, STATE_ROOT);
  const opinion = "# Legal Review\nThe reviewed synthetic sources contain no material legal issue.\n";
  await writeFile(join(workspace, "deliverables", "opinion.md"), opinion);
  const sourceLedger = JSON.parse(await readFile(join(stateRoot, "sources.json"), "utf8")) as {
    schemaVersion: number;
    sources: Array<Record<string, unknown>>;
  };
  await writeJson(join(stateRoot, "sources.json"), {
    ...sourceLedger,
    sources: sourceLedger.sources.map((source) => source.status === "pending" ? {
      ...source,
      status: "reviewed",
      extractionMethod: "plain-text inspection",
      evidenceClass: "other",
      factIds: [],
      noMaterialFactsReason: "The final synthetic source contains no additional material fact.",
      unresolvedItems: [],
    } : source),
  });
  await writeJson(join(stateRoot, "matrices.json"), {
    schemaVersion: 1,
    matrices: REQUIRED_MATRIX_IDS.map((id) => ({
      id,
      status: "not-applicable",
      entries: [],
      notApplicableReason: "The repaired synthetic source facts are non-material.",
    })),
  });
  await writeJson(join(stateRoot, "issues.json"), { schemaVersion: 1, issues: [] });
  await writeJson(join(stateRoot, "authorities.json"), { schemaVersion: 1, authorities: [] });
  await writeJson(join(stateRoot, "coverage.json"), {
    schemaVersion: 1,
    deliverables: [{ path: "deliverables/opinion.md", sha256: sha256(opinion) }],
    sources: [],
    facts: [],
    issues: [],
    authorities: [],
  });
  const legal = await import(pathToFileURL(join(PLUGIN_ROOT, "scripts", "lib", "legal-coverage.mjs")).href) as any;
  const validation = await legal.validateWorkspace({ workspaceRoot: workspace, writeProof: false });
  assert.equal(validation.passed, true, JSON.stringify(validation.errors));
}

function fakeModelRuntime(
  requests: CanonicalModelRequest[],
  projectRoot: string,
  options: { corruptSessionStateAfterProof?: boolean } = {},
): ModelRuntime {
  return {
    async *stream(request) {
      requests.push(request);
      const isCompaction = isCompactionRequest(request);
      const agentRequestCount = requests.filter((candidate) => !isCompactionRequest(candidate)).length;
      if (!isCompaction && agentRequestCount === 1) await writeMinimalValidState(projectRoot);
      if (!isCompaction && agentRequestCount === 2 && options.corruptSessionStateAfterProof) {
        const proofPath = join(projectRoot, STATE_ROOT, "completion-proof.json");
        assert.match((await readFile(proofPath, "utf8")), /"stateHash"/u);
        const sessionsRoot = join(projectRoot, STATE_ROOT, "sessions");
        const sessionFiles = await readdir(sessionsRoot);
        assert.equal(sessionFiles.length, 1);
        const sessionPath = join(sessionsRoot, sessionFiles[0]!);
        await rm(sessionPath);
        await mkdir(sessionPath);
      }
      yield { type: "message_start", role: "assistant" };
      yield {
        type: "text_delta",
        text: isCompaction
          ? "Synthetic compact summary."
          : agentRequestCount === 1 ? "Initial legal completion." : "Validated legal completion.",
      };
      yield { type: "usage", usage: { inputTokens: 20, outputTokens: 5, totalTokens: 25 } };
      yield { type: "message_end", finishReason: "stop" };
    },
    async complete() {
      return { role: "assistant", content: [{ type: "text", text: '{"title":"Legal runtime QA"}' }], finishReason: "stop" };
    },
    getCapabilities: () => DEFAULT_MODEL_CAPABILITIES,
    getMultimodal: () => DEFAULT_MULTIMODAL_CONSTRAINTS,
    getProviderProtocol: () => "openai",
    getProviderBaseUrl: () => "https://example.invalid",
  };
}

function authorityClosureModelRuntime(requests: CanonicalModelRequest[]): ModelRuntime {
  return {
    async *stream(request) {
      if (isCompactionRequest(request)) {
        yield { type: "message_start", role: "assistant" };
        yield { type: "text_delta", text: "Continue the state-bound authority closure." };
        yield { type: "message_end", finishReason: "stop" };
        return;
      }
      requests.push(request);
      const envelope = legalEnvelopeFromMessages(request.messages);
      yield { type: "message_start", role: "assistant" };
      if (envelope?.workItems?.group === "authority-closure-propose") {
        const proposal = validAuthorityClosureProposal(envelope.workItems.proposal.template);
        const proposalPath = envelope.workItems.proposal.path;
        const script = [
          'const { mkdirSync, writeFileSync } = require("node:fs");',
          'const { dirname } = require("node:path");',
          `const path = ${JSON.stringify(proposalPath)};`,
          "mkdirSync(dirname(path), { recursive: true });",
          `writeFileSync(path, ${JSON.stringify(`${JSON.stringify(proposal, null, 2)}\n`)});`,
        ].join("\n");
        const toolCall = {
          id: "authority-proposal-write",
          name: "bash",
          input: {
            command: "node -e 'eval(Buffer.from(process.argv[1],\"base64\").toString(\"utf8\"))' "
              + Buffer.from(script).toString("base64"),
          },
        };
        yield { type: "tool_call_start", id: toolCall.id, name: toolCall.name };
        yield { type: "tool_call_end", toolCall };
        yield { type: "message_end", finishReason: "tool_call" };
        return;
      }
      if (envelope?.workItems?.group === "authority-closure-apply") {
        const toolCall = {
          id: "authority-proposal-apply",
          name: "bash",
          input: { command: envelope.authorityClosureApplyCommand },
        };
        yield { type: "tool_call_start", id: toolCall.id, name: toolCall.name };
        yield { type: "tool_call_end", toolCall };
        yield { type: "message_end", finishReason: "tool_call" };
        return;
      }
      yield { type: "text_delta", text: "The legal authority closure is validated." };
      yield { type: "usage", usage: { inputTokens: 20, outputTokens: 6, totalTokens: 26 } };
      yield { type: "message_end", finishReason: "stop" };
    },
    async complete() {
      return { role: "assistant", content: [{ type: "text", text: '{"title":"Authority closure QA"}' }], finishReason: "stop" };
    },
    getCapabilities: () => ({ ...DEFAULT_MODEL_CAPABILITIES, maxContextTokens: 1_048_576 }),
    getMultimodal: () => DEFAULT_MULTIMODAL_CONSTRAINTS,
    getProviderProtocol: () => "openai",
    getProviderBaseUrl: () => "https://example.invalid",
  };
}

function legalEnvelopeFromMessages(messages: readonly CanonicalMessage[]): any {
  const match = messageText(messages).match(/<legal_coverage_state>\n([\s\S]*?)\n<\/legal_coverage_state>/u);
  return match ? JSON.parse(match[1]!) : undefined;
}

function validAuthorityClosureProposal(template: Record<string, unknown>): Record<string, unknown> {
  return {
    ...template,
    issueUpserts: [{
      id: "I-001",
      ruleId: "threshold-breach",
      status: "open",
      severity: "high",
      critical: true,
      factIds: ["F-001"],
      authorityIds: ["A-LEGAL"],
      analysis: "The normalized amount is above the analytical threshold.",
      conclusion: "The transaction should not close before confirmation.",
      recommendations: ["Use a documented condition precedent."],
    }],
    authorityUpserts: [{
      id: "A-LEGAL",
      name: "Synthetic transactions act",
      article: "Article 1",
      effectiveVersion: "Current synthetic version",
      effectiveDate: "Synthetic effective date",
      verificationStatus: "verified",
      sourceLocator: "Synthetic official source",
      supportedIssueIds: ["I-001"],
      supportedConclusion: "A closing condition may address the identified risk.",
    }],
    matrixEntryLinks: { issueIds: ["I-001"], authorityIds: ["A-LEGAL"] },
  };
}

async function writeAuthorityClosureState(workspace: string): Promise<void> {
  const root = join(workspace, STATE_ROOT);
  const source = "Synthetic company record.\n";
  const opinion = [
    "# Legal Opinion",
    "Synthetic entity registered capital of 120 currency units is material to the transaction.",
    "The threshold breach requires a closing condition.",
    "Synthetic transactions act Article 1 states that a closing condition may address the identified risk.",
    "",
  ].join("\n");
  await mkdir(join(workspace, "source-room"), { recursive: true });
  await mkdir(join(workspace, "deliverables"), { recursive: true });
  await mkdir(root, { recursive: true });
  await writeFile(join(workspace, "source-room", "record.txt"), source);
  await writeFile(join(workspace, "deliverables", "opinion.md"), opinion);
  await writeJson(join(root, "config.json"), {
    schemaVersion: 1,
    enabled: true,
    jurisdiction: "Synthetic jurisdiction",
    basisDate: "Synthetic review date",
    allowNoMaterialFacts: false,
    inputRoots: ["source-room"],
    deliverables: [{ id: "opinion", path: "deliverables/opinion.md", required: true }],
  });
  await writeJson(join(root, "sources.json"), {
    schemaVersion: 1,
    sources: [{
      id: "S-001",
      path: "source-room/record.txt",
      sha256: sha256(source),
      status: "reviewed",
      extractionMethod: "plain-text inspection",
      evidenceClass: "official-record",
      factIds: ["F-001"],
      unresolvedItems: [],
    }],
  });
  await writeJson(join(root, "facts.json"), {
    schemaVersion: 1,
    facts: [{
      id: "F-001",
      subject: "Synthetic entity",
      predicate: "registered capital",
      value: 120,
      unit: "currency units",
      dateOrPeriod: "Synthetic review date",
      sourceRefs: [{ sourceId: "S-001", locator: "line 1" }],
      evidenceClass: "official-record",
      verificationStatus: "verified",
      conflictStatus: "none",
      material: true,
      critical: true,
      thresholdAssessment: { operator: "gt", actual: 120, threshold: 100, unit: "currency units", breached: true },
    }],
  });
  await writeJson(join(root, "matrices.json"), {
    schemaVersion: 1,
    matrices: [
      ...[
        "equity-capital-timeline",
        "holding-platform-special-rights",
        "governance-personnel-timeline",
        "contract-key-terms",
        "debt-collateral-liquidity",
        "employment-ip-timeline",
      ].map((id) => ({ id, status: "not-applicable", entries: [], notApplicableReason: "No separate synthetic relationship is required." })),
      {
        id: "legal-authority",
        status: "complete",
        entries: [{
          id: "LA-001",
          summary: "The critical capital threshold requires controlling legal support.",
          factIds: ["F-001"],
          riskSignals: [],
          issueIds: ["I-001"],
          authorityIds: [],
        }],
      },
    ],
  });
  await writeJson(join(root, "issues.json"), {
    schemaVersion: 1,
    issues: [{
      id: "I-001",
      ruleId: "threshold-breach",
      status: "open",
      severity: "high",
      critical: true,
      factIds: ["F-001"],
      authorityIds: [],
      analysis: "The normalized amount is above the analytical threshold.",
      conclusion: "The transaction should not close before confirmation.",
      recommendations: ["Use a documented condition precedent."],
    }],
  });
  await writeJson(join(root, "authorities.json"), { schemaVersion: 1, authorities: [] });
  await writeJson(join(root, "coverage.json"), {
    schemaVersion: 1,
    deliverables: [{ path: "deliverables/opinion.md", sha256: sha256(opinion) }],
    sources: [],
    facts: [{
      factId: "F-001",
      status: "covered",
      deliverablePath: "deliverables/opinion.md",
      section: "Legal Opinion",
      locator: "paragraph 1",
      claim: "The capital fact is material.",
      quote: "Synthetic entity registered capital of 120 currency units is material to the transaction.",
    }],
    issues: [{
      issueId: "I-001",
      status: "covered",
      deliverablePath: "deliverables/opinion.md",
      section: "Legal Opinion",
      locator: "paragraph 2",
      claim: "The breach requires a closing condition.",
      quote: "The threshold breach requires a closing condition.",
    }],
    authorities: [{
      authorityId: "A-LEGAL",
      status: "covered",
      deliverablePath: "deliverables/opinion.md",
      section: "Legal Opinion",
      locator: "paragraph 3",
      claim: "The authority supports the control.",
      quote: "Synthetic transactions act Article 1 states that a closing condition may address the identified risk.",
    }],
  });
}

async function writeMinimalValidState(workspace: string): Promise<void> {
  const root = join(workspace, STATE_ROOT);
  const sourcePath = join(workspace, "source-room", "record.txt");
  const opinionPath = join(workspace, "deliverables", "opinion.md");
  const opinion = "# Legal Opinion\nNo material legal facts were identified in the synthetic source.\n";
  await mkdir(join(workspace, "source-room"), { recursive: true });
  await mkdir(join(workspace, "deliverables"), { recursive: true });
  await writeFile(sourcePath, "Synthetic source with no material legal facts.\n");
  await writeFile(opinionPath, opinion);
  await writeJson(join(root, "config.json"), {
    schemaVersion: 1,
    enabled: true,
    jurisdiction: "Synthetic jurisdiction",
    basisDate: "Synthetic basis date",
    allowNoMaterialFacts: true,
    inputRoots: ["source-room"],
    deliverables: [{ id: "opinion", path: "deliverables/opinion.md", required: true }],
  });
  await writeJson(join(root, "sources.json"), {
    schemaVersion: 1,
    sources: [{
      id: "S-001",
      path: "source-room/record.txt",
      sha256: sha256("Synthetic source with no material legal facts.\n"),
      status: "reviewed",
      extractionMethod: "plain-text inspection",
      evidenceClass: "official-record",
      factIds: [],
      noMaterialFactsReason: "The synthetic source contains no material legal facts.",
      unresolvedItems: [],
    }],
  });
  await writeJson(join(root, "facts.json"), { schemaVersion: 1, facts: [] });
  await writeJson(join(root, "matrices.json"), {
    schemaVersion: 1,
    matrices: [
      "equity-capital-timeline",
      "holding-platform-special-rights",
      "governance-personnel-timeline",
      "contract-key-terms",
      "debt-collateral-liquidity",
      "employment-ip-timeline",
      "legal-authority",
    ].map((id) => ({ id, status: "not-applicable", entries: [], notApplicableReason: "No responsive facts in the synthetic source." })),
  });
  await writeJson(join(root, "issues.json"), { schemaVersion: 1, issues: [] });
  await writeJson(join(root, "authorities.json"), { schemaVersion: 1, authorities: [] });
  await writeJson(join(root, "coverage.json"), {
    schemaVersion: 1,
    deliverables: [{ path: "deliverables/opinion.md", sha256: sha256(opinion) }],
    sources: [],
    facts: [],
    issues: [],
    authorities: [],
  });
}

function messageText(messages: readonly CanonicalMessage[]): string {
  return messages.flatMap((message) => message.content)
    .map((block) => block.type === "text" ? block.text : "")
    .filter(Boolean)
    .join("\n");
}

function isCompactionRequest(request: CanonicalModelRequest): boolean {
  return messageText(request.messages).includes("Summarize the conversation so far");
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const TEST_CONFIG = `schemaVersion: 1
agent:
  model: test/test-model
  maxOutputTokens: 4096
model:
  providers:
    test:
      protocol: openai
      url: https://example.invalid
      apiKey: test-key
      models:
        test-model:
          capabilities:
            maxContextTokens: 32768
            maxOutputTokens: 8192
router:
  enabled: false
  scenarios:
    default: test/test-model
memory:
  enabled: false
telemetry:
  enabled: false
`;

const AUTHORITY_CLOSURE_TEST_CONFIG = `schemaVersion: 1
agent:
  model: test/test-model
  maxOutputTokens: 4096
  progressLease:
    enabled: true
    mode: evaluation
    maxStagnantObservations: 2
    maxInitialStagnantObservations: 8
model:
  providers:
    test:
      protocol: openai
      url: https://example.invalid
      apiKey: test-key
      models:
        test-model:
          capabilities:
            maxContextTokens: 32768
            maxOutputTokens: 8192
router:
  enabled: false
  scenarios:
    default: test/test-model
memory:
  enabled: false
telemetry:
  enabled: false
observability:
  enabled: true
  profile: diagnostic
  campaignId: authority-closure-qa
  variant: candidate
  queueCapacity: 4096
`;

const SOURCE_REPAIR_TEST_CONFIG = `schemaVersion: 1
agent:
  model: test/test-model
  maxOutputTokens: 4096
  progressLease:
    enabled: true
    mode: evaluation
    maxStagnantObservations: 2
    maxInitialStagnantObservations: 8
model:
  providers:
    test:
      protocol: openai
      url: https://example.invalid
      apiKey: test-key
      models:
        test-model:
          capabilities:
            maxContextTokens: 1048576
            maxOutputTokens: 8192
router:
  enabled: false
  scenarios:
    default: test/test-model
memory:
  enabled: false
telemetry:
  enabled: false
observability:
  enabled: true
  profile: diagnostic
  campaignId: immutable-source-repair-qa
  variant: candidate
  queueCapacity: 4096
`;

const SOURCE_APPLY_TEST_CONFIG = SOURCE_REPAIR_TEST_CONFIG.replace(
  "campaignId: immutable-source-repair-qa",
  "campaignId: ordinary-source-apply-qa",
);
