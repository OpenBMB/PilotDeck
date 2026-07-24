import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  ArtifactContractStore,
  ArtifactValidationRuntime,
  FileExistsValidator,
  type ArtifactValidator,
} from "../../src/artifact/index.js";

test("validates a required artifact and keeps contracts isolated by session", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pilotdeck-artifact-"));
  await writeFile(join(workspace, "report.xlsx"), "workbook");
  const store = new ArtifactContractStore();
  store.register("session-1", "legal:test", [{
    id: "complaint",
    path: "report.xlsx",
    expectedExtensions: [".xlsx"],
  }]);
  const runtime = new ArtifactValidationRuntime(store, [new FileExistsValidator()]);

  assert.equal((await runtime.validate({ sessionId: "session-1", turnId: "turn-1", workspaceRoot: workspace })).passed, true);
  assert.deepEqual(store.list("session-2"), []);
});

test("missing or wrong-format artifacts fail with reviewer-readable issues", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pilotdeck-artifact-"));
  await writeFile(join(workspace, "generate.py"), "print('helper')");
  const store = new ArtifactContractStore();
  store.register("session-1", "legal:test", [{
    id: "complaint",
    path: "complaint.xlsx",
    validatorIds: ["core:file-exists"],
    expectedExtensions: [".xlsx"],
  }]);
  const runtime = new ArtifactValidationRuntime(store, [new FileExistsValidator()]);
  const result = await runtime.validate({ sessionId: "session-1", turnId: "turn-1", workspaceRoot: workspace });
  assert.equal(result.passed, false);
  assert.equal(result.results[0]?.issues[0]?.code, "artifact_missing");
});

test("empty required artifacts fail validation", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pilotdeck-artifact-empty-"));
  try {
    await writeFile(join(workspace, "report.md"), "");
    const store = new ArtifactContractStore();
    store.register("session-1", "legal:test", [{ id: "report", path: "report.md" }]);
    const result = await new ArtifactValidationRuntime(store, [new FileExistsValidator()]).validate({
      sessionId: "session-1",
      turnId: "turn-1",
      workspaceRoot: workspace,
    });
    assert.equal(result.passed, false);
    assert.equal(result.results[0]?.issues[0]?.code, "artifact_empty");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("rejects traversal and symlink escapes before a domain validator runs", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pilotdeck-artifact-"));
  const outside = await mkdtemp(join(tmpdir(), "pilotdeck-outside-"));
  await writeFile(join(outside, "secret.txt"), "secret");
  await mkdir(join(workspace, "links"));
  await symlink(join(outside, "secret.txt"), join(workspace, "links", "secret.txt"));
  let calls = 0;
  const validator: ArtifactValidator = {
    id: "legal:complaint",
    async validate(input) {
      calls += 1;
      return { validatorId: "legal:complaint", contractId: input.contract.id, status: "passed", issues: [] };
    },
  };
  const store = new ArtifactContractStore();
  store.register("session-1", "legal:test", [
    { id: "traversal", path: "../secret.txt", validatorIds: [validator.id] },
    { id: "symlink", path: "links/secret.txt", validatorIds: [validator.id] },
  ]);
  const result = await new ArtifactValidationRuntime(store, [validator]).validate({
    sessionId: "session-1",
    turnId: "turn-1",
    workspaceRoot: workspace,
  });
  assert.equal(result.passed, false);
  assert.equal(calls, 0);
  assert.deepEqual(result.results.map((entry) => entry.issues[0]?.code), ["artifact_path_invalid", "artifact_path_invalid"]);
});

test("legal-specific validator data stays in the plugin validator", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pilotdeck-artifact-"));
  await writeFile(join(workspace, "complaint.xlsx"), "fake workbook");
  const legalValidator: ArtifactValidator = {
    id: "legal:complaint-workbook",
    async validate(input) {
      assert.deepEqual(input.contract.options, { requiredColumns: ["事实", "证据定位"] });
      return { validatorId: this.id, contractId: input.contract.id, status: "passed", issues: [] };
    },
  };
  const store = new ArtifactContractStore();
  store.register("session-1", "legal:test", [{
    id: "complaint",
    path: "complaint.xlsx",
    validatorIds: [legalValidator.id],
    options: { requiredColumns: ["事实", "证据定位"] },
    domainId: "legal",
  }]);
  const result = await new ArtifactValidationRuntime(store, [new FileExistsValidator(), legalValidator]).validate({
    sessionId: "session-1",
    turnId: "turn-1",
    workspaceRoot: workspace,
  });
  assert.equal(result.passed, true);
});

test("validator exceptions become structured failures instead of escaping the runtime", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pilotdeck-artifact-"));
  try {
    await writeFile(join(workspace, "output.txt"), "content");
    const contracts = new ArtifactContractStore();
    contracts.register("session-1", "domain-plugin", [{
      id: "output",
      path: "output.txt",
      validatorIds: ["domain:throws"],
    }]);
    const runtime = new ArtifactValidationRuntime(contracts, [{
      id: "domain:throws",
      async validate() {
        throw new Error("validator unavailable");
      },
    }]);

    const result = await runtime.validate({ sessionId: "session-1", turnId: "turn-1", workspaceRoot: workspace });

    assert.equal(result.passed, false);
    assert.equal(result.results[0]?.status, "error");
    assert.equal(result.results[0]?.issues[0]?.code, "artifact_validator_error");
    assert.match(result.results[0]?.issues[0]?.message ?? "", /validator unavailable/);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("duplicate validator ids cannot override an existing validator", () => {
  const contracts = new ArtifactContractStore();
  assert.throws(() => new ArtifactValidationRuntime(contracts, [
    new FileExistsValidator(),
    { id: "core:file-exists", async validate() { throw new Error("must not run"); } },
  ]), /Duplicate artifact validator id/);
});

test("contract registration is atomic when one contract is invalid", () => {
  const contracts = new ArtifactContractStore();
  assert.throws(() => contracts.register("session-1", "plugin", [
    { id: "valid", path: "valid.txt" },
    { id: "invalid", path: "" },
  ]), /path is missing/);
  assert.deepEqual(contracts.list("session-1"), []);
});
