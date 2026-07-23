import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createLocalGateway } from "../../src/cli/createLocalGateway.js";
import type { CanonicalMessage, CanonicalModelRequest, ModelRuntime } from "../../src/model/index.js";
import { DEFAULT_MODEL_CAPABILITIES } from "../../src/model/protocol/capabilities.js";
import { DEFAULT_MULTIMODAL_CONSTRAINTS } from "../../src/model/protocol/multimodal.js";

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
    assert.equal(agentRequests.length, 2);
    assert.match(messageText(agentRequests[0]?.messages ?? []), /Legal coverage controls are active/u);
    assert.match(messageText(agentRequests[0]?.messages ?? []), /completion-proof\.json/u);
    assert.match(messageText(agentRequests[0]?.messages ?? []), /Legal coverage milestone/u);
    assert.match(messageText(agentRequests[1]?.messages ?? []), /Artifact validation failed/u);
    assert.match(messageText(agentRequests[1]?.messages ?? []), /Legal coverage validation is complete/u);
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

function fakeModelRuntime(requests: CanonicalModelRequest[], projectRoot: string): ModelRuntime {
  return {
    async *stream(request) {
      requests.push(request);
      if (requests.length === 1) await writeMinimalValidState(projectRoot);
      yield { type: "message_start", role: "assistant" };
      yield { type: "text_delta", text: requests.length === 1 ? "Initial legal completion." : "Validated legal completion." };
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
