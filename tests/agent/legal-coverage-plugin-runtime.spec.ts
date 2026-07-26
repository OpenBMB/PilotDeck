import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createLocalGateway } from "../../src/cli/createLocalGateway.js";
import type { CanonicalMessage, CanonicalModelRequest, ModelRuntime } from "../../src/model/index.js";
import { DEFAULT_MODEL_CAPABILITIES } from "../../src/model/protocol/capabilities.js";
import { DEFAULT_MULTIMODAL_CONSTRAINTS } from "../../src/model/protocol/multimodal.js";
import { readObservationEvents } from "../../src/observability/index.js";
import { createAgentProjectSessionStorage } from "../../src/session/index.js";

const PLUGIN_ROOT = resolve("products/legal/plugins/legal-coverage");
const STATE_ROOT = join(".pilotdeck", "work", "legal-coverage");

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
