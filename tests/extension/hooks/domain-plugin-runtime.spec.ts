import test from "node:test";
import assert from "node:assert/strict";
import {
  ArtifactContractStore,
  type ArtifactValidator,
} from "../../../src/artifact/index.js";
import { DynamicContextStore } from "../../../src/context/index.js";
import {
  DomainPluginRuntime,
  type DomainPlugin,
} from "../../../src/extension/index.js";
import { LifecycleRuntime } from "../../../src/lifecycle/index.js";

test("an active domain plugin contributes only generic runtime contracts", async () => {
  const dynamicContext = new DynamicContextStore();
  const artifactContracts = new ArtifactContractStore();
  const validator: ArtifactValidator = {
    id: "domain:structured-deliverable",
    async validate(input) {
      return { validatorId: this.id, contractId: input.contract.id, status: "passed", issues: [] };
    },
  };
  const plugin: DomainPlugin = {
    id: "project-domain",
    skillIds: ["domain-analysis"],
    validators: [validator],
    async detectTask(input) {
      return input.prompt.includes("specialized")
        ? { domainId: "specialized-work", confidence: 0.95, contextPointer: "references/checklist.md" }
        : null;
    },
    async artifactContracts() {
      return [{
        id: "deliverable",
        path: "deliverable.bin",
        validatorIds: [validator.id],
        domainId: "specialized-work",
      }];
    },
  };
  const runtime = new DomainPluginRuntime({ plugins: [plugin], dynamicContext, artifactContracts });
  const lifecycle = new LifecycleRuntime({
    async run() {
      return { effects: [], events: [], blockingErrors: [], nonBlockingErrors: [] };
    },
  } as never, dynamicContext, artifactContracts, runtime);

  const result = await lifecycle.dispatch({
    event: "UserPromptSubmit",
    baseInput: { sessionId: "session-1", transcriptPath: "", cwd: "/workspace" },
    payload: { prompt: "perform specialized analysis", turnId: "turn-1" },
  });

  assert.deepEqual(result.nonBlockingErrors, []);
  assert.equal(runtime.validators()[0]?.id, validator.id);
  assert.match(dynamicContext.getPending("session-1").merged, /domain-analysis/);
  assert.match(dynamicContext.getPending("session-1").merged, /references\/checklist\.md/);
  assert.equal(artifactContracts.list("session-1")[0]?.domainId, "specialized-work");
});

test("internal prompts do not reactivate domain detection", async () => {
  let detections = 0;
  const dynamicContext = new DynamicContextStore();
  const artifactContracts = new ArtifactContractStore();
  const runtime = new DomainPluginRuntime({
    plugins: [{
      id: "domain",
      async detectTask() {
        detections += 1;
        return { domainId: "domain", confidence: 1 };
      },
    }],
    dynamicContext,
    artifactContracts,
  });
  const lifecycle = new LifecycleRuntime({
    async run() {
      return { effects: [], events: [], blockingErrors: [], nonBlockingErrors: [] };
    },
  } as never, dynamicContext, artifactContracts, runtime);

  await lifecycle.dispatch({
    event: "UserPromptSubmit",
    baseInput: { sessionId: "session-1", transcriptPath: "", cwd: "/workspace" },
    payload: { prompt: "wake up", internal: true },
  });

  assert.equal(detections, 0);
  assert.equal(dynamicContext.hasPending("session-1"), false);
});
