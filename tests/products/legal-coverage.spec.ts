import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { loadPluginFromPath } from "../../src/extension/plugins/loading/PluginLoader.js";

const execFile = promisify(execFileCallback);
const PLUGIN_ROOT = resolve("products/legal/plugins/legal-coverage");
const CLI = join(PLUGIN_ROOT, "scripts", "legal-coverage.mjs");
const VALIDATOR_LIB = join(PLUGIN_ROOT, "scripts", "lib", "legal-coverage.mjs");
const HOOK = join(PLUGIN_ROOT, "hook.mjs");
const STATE_ROOT = join(".pilotdeck", "work", "legal-coverage");

test("legal coverage validator creates a current proof and removes it when the deliverable changes", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pilotdeck-legal-coverage-valid-"));
  try {
    await writeCompleteFixture(workspace);
    const validation = await runCli(workspace, "validate", "--write-proof");
    assert.equal(validation.exitCode, 0, validation.stderr);
    const result = JSON.parse(validation.stdout) as { passed: boolean; counts: Record<string, number> };
    assert.equal(result.passed, true);
    assert.deepEqual(result.counts, { sources: 1, facts: 1, issues: 1, authorities: 1, deliverables: 1 });

    const proofPath = join(workspace, STATE_ROOT, "completion-proof.json");
    const proof = JSON.parse(await readFile(proofPath, "utf8")) as {
      stateHash: string;
      sources: Array<{ path: string; sha256: string; bytes: number }>;
      deliverables: Array<{ sha256: string }>;
    };
    assert.match(proof.stateHash, /^[a-f0-9]{64}$/u);
    assert.deepEqual(proof.sources, [{
      path: "source-room/record.txt",
      sha256: sha256("Synthetic company record.\n"),
      bytes: Buffer.byteLength("Synthetic company record.\n"),
    }]);
    assert.match(proof.deliverables[0]?.sha256 ?? "", /^[a-f0-9]{64}$/u);

    await writeFile(join(workspace, "deliverables", "opinion.md"), "# Changed after coverage\n");
    const stale = await runCli(workspace, "validate", "--write-proof");
    assert.equal(stale.exitCode, 2);
    const staleResult = JSON.parse(stale.stdout) as { errors: Array<{ code: string }> };
    assert.equal(staleResult.errors.some((error) => error.code === "deliverable_hash_stale"), true);
    await assert.rejects(stat(proofPath), { code: "ENOENT" });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("legal coverage initializer creates a text skeleton before source review and remains idempotent", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pilotdeck-legal-coverage-missing-deliverable-"));
  try {
    await mkdir(join(workspace, "source-room"), { recursive: true });
    const initialized = await runCli(
      workspace,
      "init",
      "--input",
      "source-room",
      "--deliverable",
      "opinion=deliverables/opinion.md",
      "--jurisdiction",
      "pending-confirmation",
      "--basis-date",
      "pending-confirmation",
    );
    assert.equal(initialized.exitCode, 0, initialized.stderr);
    const initializedResult = JSON.parse(initialized.stdout) as {
      deliverableSkeletons: { created: Array<{ path: string }>; preserved: Array<{ path: string }> };
    };
    assert.deepEqual(initializedResult.deliverableSkeletons.created, [{ path: "deliverables/opinion.md" }]);
    const deliverablePath = join(workspace, "deliverables", "opinion.md");
    const skeleton = await readFile(deliverablePath, "utf8");
    assert.match(skeleton, /^# Draft legal deliverable/u);

    const repeated = await runCli(
      workspace,
      "init",
      "--input", "source-room",
      "--deliverable", "opinion=deliverables/opinion.md",
      "--jurisdiction", "pending-confirmation",
      "--basis-date", "pending-confirmation",
    );
    assert.equal(repeated.exitCode, 0, repeated.stderr);
    const repeatedResult = JSON.parse(repeated.stdout) as {
      deliverableSkeletons: { created: unknown[]; preserved: Array<{ path: string; reason: string }> };
    };
    assert.deepEqual(repeatedResult.deliverableSkeletons.created, []);
    assert.deepEqual(repeatedResult.deliverableSkeletons.preserved, [{
      path: "deliverables/opinion.md",
      reason: "already_exists",
    }]);
    assert.equal(await readFile(deliverablePath, "utf8"), skeleton);

    await rm(deliverablePath);

    const validation = await runCli(workspace, "validate", "--write-proof");
    assert.equal(validation.exitCode, 2);
    const result = JSON.parse(validation.stdout) as { errors: Array<{ code: string; path?: string }> };
    assert.equal(result.errors.some((error) => error.code === "deliverable_missing"), true);
    assert.equal(result.errors.some((error) => error.code === "deliverable_path_invalid"), false);

    const milestone = await runHook({
      hookEventName: "PreModelRequest",
      sessionId: "missing-deliverable-session",
      transcriptPath: "",
      cwd: workspace,
    });
    assert.match(milestone.hookSpecificOutput.additionalContext ?? "", /Create a non-empty user deliverable skeleton/u);
    assert.match(milestone.hookSpecificOutput.additionalContext ?? "", /deliverables\/opinion\.md/u);
    assert.match(milestone.hookSpecificOutput.additionalContext ?? "", /with write_file/u);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("legal coverage initializer creates only explicit text formats and preserves existing content", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pilotdeck-legal-coverage-skeleton-formats-"));
  try {
    await mkdir(join(workspace, "source-room"), { recursive: true });
    await mkdir(join(workspace, "deliverables"), { recursive: true });
    const existingPath = join(workspace, "deliverables", "existing.md");
    await writeFile(existingPath, "# User-authored draft\n");
    const initialized = await runCli(
      workspace,
      "init",
      "--input", "source-room",
      "--deliverable", "markdown=deliverables/report.md",
      "--deliverable", "text=deliverables/report.txt",
      "--deliverable", "html=deliverables/report.html",
      "--deliverable", "legacy-html=deliverables/report.htm",
      "--deliverable", "csv=deliverables/report.csv",
      "--deliverable", "binary=deliverables/report.docx",
      "--deliverable", "existing=deliverables/existing.md",
      "--jurisdiction", "pending-confirmation",
      "--basis-date", "pending-confirmation",
    );
    assert.equal(initialized.exitCode, 0, initialized.stderr);
    const result = JSON.parse(initialized.stdout) as {
      deliverableSkeletons: {
        created: Array<{ path: string }>;
        preserved: Array<{ path: string; reason: string }>;
        unsupported: Array<{ path: string; reason: string }>;
      };
    };
    assert.deepEqual(result.deliverableSkeletons.created.map((item) => item.path), [
      "deliverables/report.md",
      "deliverables/report.txt",
      "deliverables/report.html",
      "deliverables/report.htm",
      "deliverables/report.csv",
    ]);
    assert.deepEqual(result.deliverableSkeletons.preserved, [{
      path: "deliverables/existing.md",
      reason: "already_exists",
    }]);
    assert.deepEqual(result.deliverableSkeletons.unsupported, [{
      path: "deliverables/report.docx",
      reason: "non_text_format",
    }]);
    for (const extension of ["md", "txt", "html", "htm", "csv"]) {
      assert.equal((await stat(join(workspace, "deliverables", `report.${extension}`))).size > 0, true);
    }
    await assert.rejects(stat(join(workspace, "deliverables", "report.docx")), { code: "ENOENT" });
    assert.equal(await readFile(existingPath, "utf8"), "# User-authored draft\n");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("legal coverage initializer rejects traversal and symlink ancestors without external writes", async () => {
  const container = await mkdtemp(join(tmpdir(), "pilotdeck-legal-coverage-skeleton-boundary-"));
  const workspace = join(container, "workspace");
  const outside = join(container, "outside");
  try {
    await mkdir(join(workspace, "source-room"), { recursive: true });
    await mkdir(outside, { recursive: true });
    const traversal = await runCli(
      workspace,
      "init",
      "--input", "source-room",
      "--deliverable", "opinion=../outside/escaped.md",
      "--jurisdiction", "pending-confirmation",
      "--basis-date", "pending-confirmation",
    );
    assert.equal(traversal.exitCode, 1);
    assert.match(traversal.stderr, /"code":"deliverable_skeleton_path_invalid"/u);
    await assert.rejects(stat(join(outside, "escaped.md")), { code: "ENOENT" });

    const absolute = await runCli(
      workspace,
      "init",
      "--input", "source-room",
      "--deliverable", `opinion=${join(outside, "absolute.md")}`,
      "--jurisdiction", "pending-confirmation",
      "--basis-date", "pending-confirmation",
    );
    assert.equal(absolute.exitCode, 1);
    assert.match(absolute.stderr, /"code":"deliverable_skeleton_path_invalid"/u);
    await assert.rejects(stat(join(outside, "absolute.md")), { code: "ENOENT" });

    await symlink(outside, join(workspace, "deliverables"));
    const symlinked = await runCli(
      workspace,
      "init",
      "--input", "source-room",
      "--deliverable", "opinion=deliverables/escaped.md",
      "--jurisdiction", "pending-confirmation",
      "--basis-date", "pending-confirmation",
    );
    assert.equal(symlinked.exitCode, 1);
    assert.match(symlinked.stderr, /"code":"deliverable_skeleton_path_invalid"/u);
    await assert.rejects(stat(join(outside, "escaped.md")), { code: "ENOENT" });
  } finally {
    await rm(container, { recursive: true, force: true });
  }
});

test("legal coverage validator binds runner originals and derivations into its proof", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pilotdeck-legal-coverage-lineage-"));
  try {
    const fixture = await writeManifestBoundFixture(workspace);
    const validation = await runCli(workspace, "validate", "--write-proof");
    assert.equal(validation.exitCode, 0, validation.stderr);

    const proofPath = join(workspace, STATE_ROOT, "completion-proof.json");
    const proof = JSON.parse(await readFile(proofPath, "utf8")) as {
      inputManifest: { path: string; sha256: string; originalRoot: string; derivedRoot: string };
      sources: Array<{ path: string; sha256: string; derivedArtifacts: Array<Record<string, unknown>> }>;
    };
    assert.equal(proof.inputManifest.path, ".pilotdeck/input-manifest.json");
    assert.match(proof.inputManifest.sha256, /^[a-f0-9]{64}$/u);
    assert.equal(proof.sources[0]?.path, fixture.originalPath);
    assert.equal(proof.sources[0]?.sha256, sha256(fixture.originalBytes));
    assert.deepEqual(proof.sources[0]?.derivedArtifacts, [{
      path: fixture.derivedPath,
      sha256: sha256(fixture.derivedBytes),
      bytes: fixture.derivedBytes.byteLength,
      extractionMethod: "docx-text-extraction",
      extractorVersion: "pilotdeck-eval-runner-v1",
    }]);

    await writeFile(join(workspace, fixture.derivedPath), "changed derivation\n");
    const staleDerived = await runCli(workspace, "validate", "--write-proof");
    assert.equal(staleDerived.exitCode, 2);
    const staleDerivedResult = JSON.parse(staleDerived.stdout) as { errors: Array<{ code: string }> };
    assert.equal(staleDerivedResult.errors.some((error) => error.code === "input_manifest_derivation_stale"), true);
    await assert.rejects(stat(proofPath), { code: "ENOENT" });

    await writeFile(join(workspace, fixture.derivedPath), fixture.derivedBytes);
    await writeFile(join(workspace, fixture.originalPath), "changed original bytes");
    const staleOriginal = await runCli(workspace, "validate", "--write-proof");
    assert.equal(staleOriginal.exitCode, 2);
    const staleOriginalResult = JSON.parse(staleOriginal.stdout) as { errors: Array<{ code: string }> };
    assert.equal(staleOriginalResult.errors.some((error) => error.code === "input_manifest_original_stale"), true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("legal coverage validator rejects missing lineage and mutable or derived input roots", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pilotdeck-legal-coverage-lineage-boundary-"));
  try {
    const fixture = await writeManifestBoundFixture(workspace);
    const root = join(workspace, STATE_ROOT);
    const sourcesPath = join(root, "sources.json");
    const sources = JSON.parse(await readFile(sourcesPath, "utf8")) as { sources: Array<Record<string, unknown>> };
    delete sources.sources[0]?.derivedArtifacts;
    await writeJson(sourcesPath, sources);

    const missing = await runCli(workspace, "validate", "--write-proof");
    assert.equal(missing.exitCode, 2);
    const missingResult = JSON.parse(missing.stdout) as { errors: Array<{ code: string }> };
    assert.equal(missingResult.errors.some((error) => error.code === "source_derivation_missing"), true);

    await writeJson(sourcesPath, { schemaVersion: 1, sources: [] });
    const omittedOriginal = await runCli(workspace, "validate", "--write-proof");
    assert.equal(omittedOriginal.exitCode, 2);
    const omittedResult = JSON.parse(omittedOriginal.stdout) as { errors: Array<{ code: string }> };
    assert.equal(omittedResult.errors.some((error) => error.code === "manifest_original_not_inventoried"), true);

    sources.sources[0]!.path = fixture.derivedPath;
    sources.sources[0]!.sha256 = sha256(fixture.derivedBytes);
    sources.sources[0]!.derivedArtifacts = [];
    await writeJson(sourcesPath, sources);
    const configPath = join(root, "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8")) as { inputRoots: string[] };
    config.inputRoots = [fixture.derivedRoot];
    await writeJson(configPath, config);

    const derivedAsOriginal = await runCli(workspace, "validate", "--write-proof");
    assert.equal(derivedAsOriginal.exitCode, 2);
    const derivedResult = JSON.parse(derivedAsOriginal.stdout) as { errors: Array<{ code: string }> };
    assert.equal(derivedResult.errors.some((error) => error.code === "input_root_not_original"), true);
    assert.equal(derivedResult.errors.some((error) => error.code === "source_not_in_input_manifest"), true);

    config.inputRoots = [STATE_ROOT];
    await writeJson(configPath, config);
    const mutableState = await runCli(workspace, "validate", "--write-proof");
    assert.equal(mutableState.exitCode, 2);
    const mutableResult = JSON.parse(mutableState.stdout) as { errors: Array<{ code: string }> };
    assert.equal(mutableResult.errors.some((error) => error.code === "input_root_uses_mutable_state"), true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("legal coverage next-batch exposes one bounded deterministic repair slice", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pilotdeck-legal-coverage-batch-"));
  try {
    await writeCompleteFixture(workspace);
    const coveragePath = join(workspace, STATE_ROOT, "coverage.json");
    const completeCoverage = JSON.parse(await readFile(coveragePath, "utf8")) as Record<string, unknown>;
    await writeJson(coveragePath, {
      schemaVersion: 1,
      deliverables: [],
      sources: [],
      facts: [],
      issues: [],
      authorities: [],
    });

    const deliverableBatch = await runCli(workspace, "next-batch", "--phase", "coverage", "--limit", "1");
    assert.equal(deliverableBatch.exitCode, 0, deliverableBatch.stderr);
    const deliverable = JSON.parse(deliverableBatch.stdout) as {
      group: string;
      stateHash: string;
      returned: number;
      limits: { maxRecords: number; maxSerializedBytes: number };
      items: Array<{ path?: string; actualSha256?: string }>;
    };
    assert.equal(deliverable.group, "deliverables");
    assert.match(deliverable.stateHash, /^[a-f0-9]{64}$/u);
    assert.equal(deliverable.returned, 1);
    assert.equal(deliverable.limits.maxRecords, 1);
    assert.equal(deliverable.limits.maxSerializedBytes, 24576);
    assert.equal(deliverable.items[0]?.path, "deliverables/opinion.md");
    assert.match(deliverable.items[0]?.actualSha256 ?? "", /^[a-f0-9]{64}$/u);
    const coverageMilestone = await runHook({
      hookEventName: "PreModelRequest",
      sessionId: "coverage-batch-session",
      transcriptPath: "",
      cwd: workspace,
    });
    assert.match(coverageMilestone.hookSpecificOutput.additionalContext ?? "", /next-batch --phase coverage/u);
    assert.match(coverageMilestone.hookSpecificOutput.additionalContext ?? "", /"group": "deliverables"/u);
    assert.match(coverageMilestone.hookSpecificOutput.additionalContext ?? "", /"maxSerializedBytes": 2048/u);
    assert.equal((coverageMilestone.hookSpecificOutput.additionalContext ?? "").length < 4096, true);

    const emptyCoverage = JSON.parse(await readFile(coveragePath, "utf8")) as Record<string, unknown>;
    emptyCoverage.deliverables = completeCoverage.deliverables;
    await writeJson(coveragePath, emptyCoverage);
    const factBatch = await runCli(workspace, "next-batch", "--phase", "coverage", "--limit", "12", "--max-bytes", "24576");
    assert.equal(factBatch.exitCode, 0, factBatch.stderr);
    const facts = JSON.parse(factBatch.stdout) as {
      group: string;
      returned: number;
      serializedBytes: number;
      items: Array<{ factId?: string; requiredStatus?: string }>;
    };
    assert.equal(facts.group, "facts");
    assert.equal(facts.returned, 1);
    assert.equal(facts.items[0]?.factId, "F-001");
    assert.equal(facts.items[0]?.requiredStatus, "covered");
    assert.equal(facts.serializedBytes <= 24576, true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("legal coverage apply-batch atomically updates only the current bounded slice", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pilotdeck-legal-coverage-apply-batch-"));
  try {
    await writeCompleteFixture(workspace);
    const coveragePath = join(workspace, STATE_ROOT, "coverage.json");
    const completeCoverage = JSON.parse(await readFile(coveragePath, "utf8")) as {
      deliverables: Array<Record<string, unknown>>;
      facts: Array<Record<string, unknown>>;
    };
    await writeJson(coveragePath, {
      schemaVersion: 1,
      deliverables: [],
      sources: [],
      facts: [],
      issues: [],
      authorities: [],
    });

    const schemaResult = await runCli(workspace, "schema");
    assert.equal(schemaResult.exitCode, 0, schemaResult.stderr);
    const schema = JSON.parse(schemaResult.stdout) as { limits: { maxRecords: number; maxSerializedBytes: number } };
    assert.deepEqual(schema.limits, { maxRecords: 12, maxSerializedBytes: 24576 });

    const batchResult = await runCli(workspace, "next-batch", "--phase", "coverage");
    assert.equal(batchResult.exitCode, 0, batchResult.stderr);
    const batch = JSON.parse(batchResult.stdout) as { stateHash: string; group: string };
    assert.equal(batch.group, "deliverables");

    const patchDirectory = join(workspace, STATE_ROOT, "patches");
    await mkdir(patchDirectory, { recursive: true });
    const patchPath = join(patchDirectory, "deliverables.json");
    const patch = {
      schemaVersion: 1,
      phase: "coverage",
      group: "deliverables",
      expectedStateHash: batch.stateHash,
      items: completeCoverage.deliverables,
    };
    await writeJson(patchPath, patch);

    const applied = await runCli(
      workspace,
      "apply-batch",
      "--phase",
      "coverage",
      "--input-file",
      `${STATE_ROOT}/patches/deliverables.json`,
    );
    assert.equal(applied.exitCode, 0, applied.stderr);
    const appliedResult = JSON.parse(applied.stdout) as {
      applied: boolean;
      group: string;
      updated: number;
      errorCountBefore: number;
      errorCountAfter: number;
      nextBatch: { group: string; stateHash: string };
    };
    assert.equal(appliedResult.applied, true);
    assert.equal(appliedResult.group, "deliverables");
    assert.equal(appliedResult.updated, 1);
    assert.equal(appliedResult.errorCountAfter < appliedResult.errorCountBefore, true);
    assert.equal(appliedResult.nextBatch.group, "facts");
    assert.match(appliedResult.nextBatch.stateHash, /^[a-f0-9]{64}$/u);
    const afterApply = JSON.parse(await readFile(coveragePath, "utf8")) as { deliverables: unknown[]; facts: unknown[] };
    assert.deepEqual(afterApply.deliverables, completeCoverage.deliverables);
    assert.deepEqual(afterApply.facts, []);

    const staleBytes = await readFile(coveragePath);
    const stale = await runCli(
      workspace,
      "apply-batch",
      "--phase",
      "coverage",
      "--input-file",
      `${STATE_ROOT}/patches/deliverables.json`,
    );
    assert.equal(stale.exitCode, 1);
    assert.match(stale.stderr, /"code":"stale_state_hash"/u);
    assert.deepEqual(await readFile(coveragePath), staleBytes);

    const factPatchPath = join(patchDirectory, "facts.json");
    await writeJson(factPatchPath, {
      schemaVersion: 1,
      phase: "coverage",
      group: "facts",
      expectedStateHash: appliedResult.nextBatch.stateHash,
      items: [{ ...completeCoverage.facts[0], factId: "F-out-of-scope" }],
    });
    const beforeOutOfScope = await readFile(coveragePath);
    const outOfScope = await runCli(
      workspace,
      "apply-batch",
      "--phase",
      "coverage",
      "--input-file",
      `${STATE_ROOT}/patches/facts.json`,
    );
    assert.equal(outOfScope.exitCode, 1);
    assert.match(outOfScope.stderr, /"code":"batch_item_out_of_scope"/u);
    assert.deepEqual(await readFile(coveragePath), beforeOutOfScope);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("legal coverage apply-batch rejects record and byte limit violations before writing", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pilotdeck-legal-coverage-batch-limits-"));
  try {
    await writeCompleteFixture(workspace);
    const coveragePath = join(workspace, STATE_ROOT, "coverage.json");
    await writeJson(coveragePath, {
      schemaVersion: 1,
      deliverables: [],
      sources: [],
      facts: [],
      issues: [],
      authorities: [],
    });
    const batch = JSON.parse((await runCli(workspace, "next-batch", "--phase", "coverage")).stdout) as { stateHash: string };
    const patchDirectory = join(workspace, STATE_ROOT, "patches");
    await mkdir(patchDirectory, { recursive: true });
    const patchPath = join(patchDirectory, "limit.json");
    const before = await readFile(coveragePath);

    await writeJson(patchPath, {
      schemaVersion: 1,
      phase: "coverage",
      group: "deliverables",
      expectedStateHash: batch.stateHash,
      items: Array.from({ length: 13 }, (_, index) => ({ path: `deliverables/${index}.md`, sha256: "a".repeat(64) })),
    });
    const tooMany = await runCli(workspace, "apply-batch", "--phase", "coverage", "--input-file", `${STATE_ROOT}/patches/limit.json`);
    assert.equal(tooMany.exitCode, 1);
    assert.match(tooMany.stderr, /"code":"batch_record_limit"/u);
    assert.deepEqual(await readFile(coveragePath), before);

    await writeJson(patchPath, {
      schemaVersion: 1,
      phase: "coverage",
      group: "deliverables",
      expectedStateHash: batch.stateHash,
      items: [{ path: "deliverables/opinion.md", sha256: "a".repeat(64), padding: "x".repeat(25_000) }],
    });
    const tooLarge = await runCli(workspace, "apply-batch", "--phase", "coverage", "--input-file", `${STATE_ROOT}/patches/limit.json`);
    assert.equal(tooLarge.exitCode, 1);
    assert.match(tooLarge.stderr, /"code":"batch_byte_limit"/u);
    assert.deepEqual(await readFile(coveragePath), before);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("legal coverage validator rejects orphaned conflicts and incomplete final disclosure", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pilotdeck-legal-coverage-conflict-"));
  try {
    await writeCompleteFixture(workspace);
    const factsPath = join(workspace, STATE_ROOT, "facts.json");
    const facts = JSON.parse(await readFile(factsPath, "utf8")) as { facts: Array<Record<string, unknown>> };
    facts.facts[0]!.conflictStatus = "unresolved";
    await writeJson(factsPath, facts);

    const validation = await runCli(workspace, "validate", "--write-proof");
    assert.equal(validation.exitCode, 2);
    const result = JSON.parse(validation.stdout) as { errors: Array<{ code: string }> };
    const codes = new Set(result.errors.map((error) => error.code));
    assert.equal(codes.has("unresolved_conflict_orphaned"), true);
    assert.equal(codes.has("conflict_not_disclosed"), true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("legal coverage validator detects un-inventoried sources and cross-fact timeline collisions", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pilotdeck-legal-coverage-omission-"));
  try {
    await writeCompleteFixture(workspace);
    await writeFile(join(workspace, "source-room", "omitted.txt"), "An additional source that was not inventoried.\n");

    const root = join(workspace, STATE_ROOT);
    const sources = JSON.parse(await readFile(join(root, "sources.json"), "utf8")) as { sources: Array<Record<string, unknown>> };
    sources.sources[0]!.factIds = ["F-001", "F-002"];
    await writeJson(join(root, "sources.json"), sources);
    const facts = JSON.parse(await readFile(join(root, "facts.json"), "utf8")) as { facts: Array<Record<string, unknown>> };
    facts.facts.push({
      ...facts.facts[0],
      id: "F-002",
      value: 80,
      thresholdAssessment: undefined,
    });
    await writeJson(join(root, "facts.json"), facts);
    const coverage = JSON.parse(await readFile(join(root, "coverage.json"), "utf8")) as { facts: Array<Record<string, unknown>> };
    coverage.facts.push({ ...coverage.facts[0], factId: "F-002" });
    await writeJson(join(root, "coverage.json"), coverage);

    const validation = await runCli(workspace, "validate", "--write-proof");
    assert.equal(validation.exitCode, 2);
    const result = JSON.parse(validation.stdout) as { errors: Array<{ code: string }> };
    const codes = new Set(result.errors.map((error) => error.code));
    assert.equal(codes.has("source_not_inventoried"), true);
    assert.equal(codes.has("timeline_collision_orphaned"), true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("legal coverage validator rejects reused generic quotes and unsupported fact coverage", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pilotdeck-legal-coverage-generic-"));
  try {
    await writeCompleteFixture(workspace);
    const root = join(workspace, STATE_ROOT);
    const sources = JSON.parse(await readFile(join(root, "sources.json"), "utf8")) as { sources: Array<Record<string, unknown>> };
    sources.sources[0]!.factIds = ["F-001", "F-002"];
    await writeJson(join(root, "sources.json"), sources);

    const facts = JSON.parse(await readFile(join(root, "facts.json"), "utf8")) as { facts: Array<Record<string, unknown>> };
    facts.facts.push({
      ...facts.facts[0],
      id: "F-002",
      predicate: "employee count",
      value: 42,
      material: true,
      critical: false,
      thresholdAssessment: null,
    });
    await writeJson(join(root, "facts.json"), facts);

    const coverage = JSON.parse(await readFile(join(root, "coverage.json"), "utf8")) as { facts: Array<Record<string, unknown>> };
    coverage.facts.push({ ...coverage.facts[0], factId: "F-002" });
    await writeJson(join(root, "coverage.json"), coverage);

    const validation = await runCli(workspace, "validate", "--write-proof");
    assert.equal(validation.exitCode, 2);
    const result = JSON.parse(validation.stdout) as { errors: Array<{ code: string }> };
    const codes = new Set(result.errors.map((error) => error.code));
    assert.equal(codes.has("coverage_quote_reused"), true);
    assert.equal(codes.has("fact_coverage_quote_unsupported"), true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("legal coverage validator requires authority links for critical issues and legal-authority matrices", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pilotdeck-legal-coverage-authority-"));
  try {
    await writeCompleteFixture(workspace);
    const root = join(workspace, STATE_ROOT);
    const issues = JSON.parse(await readFile(join(root, "issues.json"), "utf8")) as { issues: Array<Record<string, unknown>> };
    issues.issues[0]!.authorityIds = [];
    issues.issues[0]!.authorityNotRequiredReason = "Authority support omitted.";
    await writeJson(join(root, "issues.json"), issues);
    await writeJson(join(root, "authorities.json"), { schemaVersion: 1, authorities: [] });

    const matrices = JSON.parse(await readFile(join(root, "matrices.json"), "utf8")) as { matrices: Array<Record<string, unknown>> };
    const authorityMatrix = matrices.matrices.find((matrix) => matrix.id === "legal-authority")!;
    authorityMatrix.status = "complete";
    authorityMatrix.entries = [{
      id: "M-AUTH-001",
      summary: "Authority support for the closing condition.",
      factIds: ["F-001"],
      riskSignals: [],
      issueIds: ["I-001"],
      authorityIds: [],
    }];
    delete authorityMatrix.notApplicableReason;
    await writeJson(join(root, "matrices.json"), matrices);

    const coverage = JSON.parse(await readFile(join(root, "coverage.json"), "utf8")) as { authorities: unknown[] };
    coverage.authorities = [];
    await writeJson(join(root, "coverage.json"), coverage);

    const validation = await runCli(workspace, "validate", "--write-proof");
    assert.equal(validation.exitCode, 2);
    const result = JSON.parse(validation.stdout) as { errors: Array<{ code: string }> };
    const codes = new Set(result.errors.map((error) => error.code));
    assert.equal(codes.has("critical_issue_authority_missing"), true);
    assert.equal(codes.has("legal_authority_links_missing"), true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("legal coverage validator rejects non-object canonical JSON documents", async () => {
  const stateFiles = ["config", "sources", "facts", "matrices", "issues", "authorities", "coverage"];
  const nonObjects = [null, [], "not an object", 42];
  for (const [index, stateFile] of stateFiles.entries()) {
    const workspace = await mkdtemp(join(tmpdir(), `pilotdeck-legal-coverage-non-object-${stateFile}-`));
    try {
      await writeCompleteFixture(workspace);
      await writeFile(join(workspace, STATE_ROOT, `${stateFile}.json`), `${JSON.stringify(nonObjects[index % nonObjects.length])}\n`);
      const validation = await runCli(workspace, "validate", "--write-proof");
      assert.equal(validation.exitCode, 2, `${stateFile}: ${validation.stderr}`);
      const result = JSON.parse(validation.stdout) as { passed: boolean; errors: Array<{ code: string; path?: string }> };
      assert.equal(result.passed, false);
      assert.equal(result.errors.some((error) => error.code === "state_document_not_object" && error.path?.endsWith(`${stateFile}.json`)), true);
      await assert.rejects(stat(join(workspace, STATE_ROOT, "completion-proof.json")), { code: "ENOENT" });
    } finally {
      await rm(workspace, { recursive: true, force: true });
    }
  }
});

test("legal coverage validator binds reviewed source bytes to the ledger and state hash", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pilotdeck-legal-coverage-source-hash-"));
  try {
    await writeCompleteFixture(workspace);
    const current = await runCli(workspace, "validate", "--write-proof");
    assert.equal(current.exitCode, 0, current.stderr);
    const currentResult = JSON.parse(current.stdout) as { stateHash: string };

    await writeFile(join(workspace, "source-room", "record.txt"), "Changed source bytes after legal review.\n");
    const stale = await runCli(workspace, "validate", "--write-proof");
    assert.equal(stale.exitCode, 2);
    const staleResult = JSON.parse(stale.stdout) as { stateHash: string; errors: Array<{ code: string }> };
    assert.notEqual(staleResult.stateHash, currentResult.stateHash);
    assert.equal(staleResult.errors.some((error) => error.code === "source_hash_stale"), true);
    await assert.rejects(stat(join(workspace, STATE_ROOT, "completion-proof.json")), { code: "ENOENT" });

    await writeFile(join(workspace, "source-room", "record.txt"), "Synthetic company record.\n");
    const sourcesPath = join(workspace, STATE_ROOT, "sources.json");
    const sources = JSON.parse(await readFile(sourcesPath, "utf8")) as { sources: Array<Record<string, unknown>> };
    delete sources.sources[0]!.sha256;
    await writeJson(sourcesPath, sources);
    const unbound = await runCli(workspace, "validate", "--write-proof");
    assert.equal(unbound.exitCode, 2);
    const unboundResult = JSON.parse(unbound.stdout) as { errors: Array<{ code: string }> };
    assert.equal(unboundResult.errors.some((error) => error.code === "source_hash_missing"), true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("legal coverage validator rejects ancestor symlinks and a symlinked proof", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pilotdeck-legal-coverage-symlink-"));
  const outside = await mkdtemp(join(tmpdir(), "pilotdeck-legal-coverage-outside-"));
  try {
    await writeCompleteFixture(workspace);
    await mkdir(join(outside, "source-room"), { recursive: true });
    await mkdir(join(outside, "deliverables"), { recursive: true });
    await writeFile(join(outside, "source-room", "record.txt"), "Synthetic company record.\n");
    await writeFile(join(outside, "deliverables", "opinion.md"), "External legal opinion.\n");
    await symlink(outside, join(workspace, "escape"));

    const root = join(workspace, STATE_ROOT);
    const config = JSON.parse(await readFile(join(root, "config.json"), "utf8")) as { inputRoots: string[]; deliverables: Array<Record<string, unknown>> };
    config.inputRoots = ["escape/source-room"];
    config.deliverables[0]!.path = "escape/deliverables/opinion.md";
    await writeJson(join(root, "config.json"), config);
    const sources = JSON.parse(await readFile(join(root, "sources.json"), "utf8")) as { sources: Array<Record<string, unknown>> };
    sources.sources[0]!.path = "escape/source-room/record.txt";
    await writeJson(join(root, "sources.json"), sources);

    const escaped = await runCli(workspace, "validate", "--write-proof");
    assert.equal(escaped.exitCode, 2);
    const escapedResult = JSON.parse(escaped.stdout) as { errors: Array<{ code: string }> };
    assert.equal(escapedResult.errors.some((error) => error.code === "source_path_invalid"), true);
    assert.equal(escapedResult.errors.some((error) => error.code === "input_root_unreadable"), true);
    assert.equal(escapedResult.errors.some((error) => error.code === "deliverable_path_invalid"), true);

    config.inputRoots = ["source-room"];
    config.deliverables[0]!.path = "deliverables/opinion.md";
    sources.sources[0]!.path = "source-room/record.txt";
    await writeJson(join(root, "config.json"), config);
    await writeJson(join(root, "sources.json"), sources);
    const externalProof = join(outside, "completion-proof.json");
    await writeFile(externalProof, "external sentinel\n");
    await symlink(externalProof, join(root, "completion-proof.json"));
    const proofSymlink = await runCli(workspace, "validate", "--write-proof");
    assert.equal(proofSymlink.exitCode, 2);
    const proofResult = JSON.parse(proofSymlink.stdout) as { errors: Array<{ code: string }> };
    assert.equal(proofResult.errors.some((error) => error.code === "proof_path_invalid"), true);
    assert.equal(await readFile(externalProof, "utf8"), "external sentinel\n");
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("legal coverage validator does not read or write through a symlinked state ancestor", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pilotdeck-legal-coverage-state-symlink-"));
  const outside = await mkdtemp(join(tmpdir(), "pilotdeck-legal-coverage-state-outside-"));
  try {
    await writeCompleteFixture(workspace);
    const stateRoot = join(workspace, STATE_ROOT);
    const outsideState = join(outside, "state");
    await rename(stateRoot, outsideState);
    await symlink(outsideState, stateRoot);
    const externalProof = join(outsideState, "completion-proof.json");
    await writeFile(externalProof, "external state sentinel\n");

    const result = await runValidatorDirect(workspace);
    assert.equal(result.passed, false);
    assert.equal(result.errors.some((error: { code: string }) => error.code === "state_file_invalid"), true);
    assert.equal(result.errors.some((error: { code: string }) => error.code === "proof_path_invalid"), true);
    assert.equal(await readFile(externalProof, "utf8"), "external state sentinel\n");
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("legal coverage validator requires unresolved disclosure for unverified material facts", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pilotdeck-legal-coverage-unverified-"));
  try {
    await writeCompleteFixture(workspace);
    const factsPath = join(workspace, STATE_ROOT, "facts.json");
    const facts = JSON.parse(await readFile(factsPath, "utf8")) as { facts: Array<Record<string, unknown>> };
    facts.facts[0]!.verificationStatus = "partially-verified";
    await writeJson(factsPath, facts);
    const validation = await runCli(workspace, "validate", "--write-proof");
    assert.equal(validation.exitCode, 2);
    const result = JSON.parse(validation.stdout) as { errors: Array<{ code: string }> };
    assert.equal(result.errors.some((error) => error.code === "unverified_fact_not_disclosed"), true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("legal coverage validator rejects unique but irrelevant issue and authority quotes", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pilotdeck-legal-coverage-semantic-quotes-"));
  try {
    await writeCompleteFixture(workspace);
    const opinionPath = join(workspace, "deliverables", "opinion.md");
    const opinion = [
      "# Legal Opinion",
      "Synthetic entity registered capital of 120 currency units is material to the transaction.",
      "The office will archive a uniquely numbered blue folder tomorrow.",
      "A separate cafeteria notice confirms the weekly menu schedule.",
      "",
    ].join("\n");
    await writeFile(opinionPath, opinion);
    const coveragePath = join(workspace, STATE_ROOT, "coverage.json");
    const coverage = JSON.parse(await readFile(coveragePath, "utf8")) as {
      deliverables: Array<Record<string, unknown>>;
      issues: Array<Record<string, unknown>>;
      authorities: Array<Record<string, unknown>>;
    };
    coverage.deliverables[0]!.sha256 = sha256(opinion);
    coverage.issues[0]!.quote = "The office will archive a uniquely numbered blue folder tomorrow.";
    coverage.authorities[0]!.quote = "A separate cafeteria notice confirms the weekly menu schedule.";
    await writeJson(coveragePath, coverage);

    const validation = await runCli(workspace, "validate", "--write-proof");
    assert.equal(validation.exitCode, 2);
    const result = JSON.parse(validation.stdout) as { errors: Array<{ code: string }> };
    const codes = new Set(result.errors.map((error) => error.code));
    assert.equal(codes.has("issue_coverage_quote_unsupported"), true);
    assert.equal(codes.has("authority_coverage_quote_unsupported"), true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("legal coverage validator enforces reciprocal and same-entry ledger relationships", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pilotdeck-legal-coverage-relationships-"));
  try {
    await writeCompleteFixture(workspace);
    const root = join(workspace, STATE_ROOT);
    const sources = JSON.parse(await readFile(join(root, "sources.json"), "utf8")) as { sources: Array<Record<string, unknown>> };
    sources.sources[0]!.factIds = ["F-002"];
    await writeJson(join(root, "sources.json"), sources);

    const facts = JSON.parse(await readFile(join(root, "facts.json"), "utf8")) as { facts: Array<Record<string, unknown>> };
    facts.facts.push({
      ...facts.facts[0],
      id: "F-002",
      predicate: "employee count",
      value: 42,
      material: false,
      critical: false,
      sourceRefs: [],
      thresholdAssessment: null,
    });
    await writeJson(join(root, "facts.json"), facts);

    const authorities = JSON.parse(await readFile(join(root, "authorities.json"), "utf8")) as { authorities: Array<Record<string, unknown>> };
    authorities.authorities.push({
      id: "A-002",
      name: "Unrelated synthetic act",
      article: "Article 9",
      effectiveVersion: "Current synthetic version",
      effectiveDate: "Synthetic effective date",
      verificationStatus: "verified",
      sourceLocator: "Synthetic official source",
      supportedIssueIds: ["I-001"],
      supportedConclusion: "An unrelated filing rule applies.",
    });
    await writeJson(join(root, "authorities.json"), authorities);

    const matrices = JSON.parse(await readFile(join(root, "matrices.json"), "utf8")) as { matrices: Array<Record<string, unknown>> };
    const riskMatrix = matrices.matrices.find((matrix) => matrix.id === "equity-capital-timeline")!;
    (riskMatrix.entries as Array<Record<string, unknown>>)[0]!.factIds = ["F-001", "F-002"];
    const authorityMatrix = matrices.matrices.find((matrix) => matrix.id === "legal-authority")!;
    authorityMatrix.status = "complete";
    authorityMatrix.entries = [{
      id: "M-AUTH-001",
      summary: "An intentionally mismatched authority relationship.",
      factIds: ["F-002"],
      riskSignals: [],
      issueIds: ["I-001"],
      authorityIds: ["A-002"],
    }];
    delete authorityMatrix.notApplicableReason;
    await writeJson(join(root, "matrices.json"), matrices);

    const validation = await runCli(workspace, "validate", "--write-proof");
    assert.equal(validation.exitCode, 2);
    const result = JSON.parse(validation.stdout) as { errors: Array<{ code: string }> };
    const codes = new Set(result.errors.map((error) => error.code));
    assert.equal(codes.has("fact_source_backlink_missing"), true);
    assert.equal(codes.has("source_fact_backlink_missing"), true);
    assert.equal(codes.has("issue_authority_backlink_missing"), true);
    assert.equal(codes.has("matrix_issue_fact_mismatch"), true);
    assert.equal(codes.has("risk_signal_fact_mismatch"), true);
    assert.equal(codes.has("matrix_issue_authority_mismatch"), true);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("legal coverage validator accepts null for an optional threshold assessment", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pilotdeck-legal-coverage-null-threshold-"));
  try {
    await writeCompleteFixture(workspace);
    const factsPath = join(workspace, STATE_ROOT, "facts.json");
    const facts = JSON.parse(await readFile(factsPath, "utf8")) as { facts: Array<Record<string, unknown>> };
    facts.facts[0]!.thresholdAssessment = null;
    await writeJson(factsPath, facts);

    const validation = await runCli(workspace, "validate", "--write-proof");
    assert.equal(validation.exitCode, 0, validation.stderr);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("legal coverage validator uses locators without quotes for binary deliverables", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pilotdeck-legal-coverage-binary-"));
  try {
    await writeCompleteFixture(workspace);
    const root = join(workspace, STATE_ROOT);
    const binaryPath = join(workspace, "deliverables", "opinion.docx");
    const binary = Buffer.from("synthetic-binary-legal-opinion");
    await writeFile(binaryPath, binary);

    const config = JSON.parse(await readFile(join(root, "config.json"), "utf8")) as { deliverables: Array<Record<string, unknown>> };
    config.deliverables[0]!.path = "deliverables/opinion.docx";
    await writeJson(join(root, "config.json"), config);
    const coverage = JSON.parse(await readFile(join(root, "coverage.json"), "utf8")) as {
      deliverables: Array<Record<string, unknown>>;
      facts: Array<Record<string, unknown>>;
      issues: Array<Record<string, unknown>>;
      authorities: Array<Record<string, unknown>>;
    };
    coverage.deliverables = [{ path: "deliverables/opinion.docx", sha256: sha256(binary) }];
    for (const row of [...coverage.facts, ...coverage.issues, ...coverage.authorities]) {
      row.deliverablePath = "deliverables/opinion.docx";
      delete row.quote;
    }
    await writeJson(join(root, "coverage.json"), coverage);

    const validation = await runCli(workspace, "validate", "--write-proof");
    assert.equal(validation.exitCode, 0, validation.stderr);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("legal coverage validator rejects empty-fact shortcuts and material facts outside matrices", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pilotdeck-legal-coverage-empty-facts-"));
  try {
    await writeCompleteFixture(workspace);
    const root = join(workspace, STATE_ROOT);
    const matrices = JSON.parse(await readFile(join(root, "matrices.json"), "utf8")) as { matrices: Array<Record<string, unknown>> };
    for (const matrix of matrices.matrices) {
      matrix.status = "not-applicable";
      matrix.entries = [];
      matrix.notApplicableReason = "No responsive facts for this synthetic matrix.";
    }
    await writeJson(join(root, "matrices.json"), matrices);

    const orphaned = await runCli(workspace, "validate", "--write-proof");
    assert.equal(orphaned.exitCode, 2);
    const orphanedResult = JSON.parse(orphaned.stdout) as { errors: Array<{ code: string }> };
    assert.equal(orphanedResult.errors.some((error) => error.code === "material_fact_matrix_orphaned"), true);

    const sources = JSON.parse(await readFile(join(root, "sources.json"), "utf8")) as { sources: Array<Record<string, unknown>> };
    sources.sources[0]!.factIds = [];
    sources.sources[0]!.noMaterialFactsReason = "The reviewed synthetic source is genuinely non-responsive.";
    await writeJson(join(root, "sources.json"), sources);
    await writeJson(join(root, "facts.json"), { schemaVersion: 1, facts: [] });
    await writeJson(join(root, "issues.json"), { schemaVersion: 1, issues: [] });
    await writeJson(join(root, "authorities.json"), { schemaVersion: 1, authorities: [] });
    const coverage = JSON.parse(await readFile(join(root, "coverage.json"), "utf8")) as Record<string, unknown>;
    coverage.facts = [];
    coverage.issues = [];
    coverage.authorities = [];
    await writeJson(join(root, "coverage.json"), coverage);

    const blocked = await runCli(workspace, "validate", "--write-proof");
    assert.equal(blocked.exitCode, 2);
    const blockedResult = JSON.parse(blocked.stdout) as { errors: Array<{ code: string }> };
    assert.equal(blockedResult.errors.some((error) => error.code === "material_facts_missing"), true);

    const config = JSON.parse(await readFile(join(root, "config.json"), "utf8")) as Record<string, unknown>;
    config.allowNoMaterialFacts = true;
    await writeJson(join(root, "config.json"), config);
    const explicitNoFacts = await runCli(workspace, "validate", "--write-proof");
    assert.equal(explicitNoFacts.exitCode, 0, explicitNoFacts.stderr);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("legal coverage hook activates only legal work and injects one observable milestone", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pilotdeck-legal-coverage-hook-"));
  const ordinaryWorkspace = await mkdtemp(join(tmpdir(), "pilotdeck-nonlegal-hook-"));
  try {
    const legalSubmit = await runHook({
      hookEventName: "UserPromptSubmit",
      sessionId: "legal-session",
      transcriptPath: "",
      cwd: workspace,
      prompt: "Please conduct legal due diligence and issue a legal opinion.",
      internal: false,
    });
    assert.equal(legalSubmit.hookSpecificOutput.dynamicContext?.length, 1);
    assert.equal(legalSubmit.hookSpecificOutput.artifactContracts?.[0]?.path, `${STATE_ROOT}/completion-proof.json`);

    const preModel = await runHook({
      hookEventName: "PreModelRequest",
      sessionId: "legal-session",
      transcriptPath: "",
      cwd: workspace,
    });
    assert.match(preModel.hookSpecificOutput.additionalContext ?? "", /<legal_coverage_state>/u);
    assert.match(preModel.hookSpecificOutput.additionalContext ?? "", /"milestone": "INIT"/u);
    assert.match(preModel.hookSpecificOutput.additionalContext ?? "", /"code": "jurisdiction_missing"/u);
    assert.equal(preModel.hookSpecificOutput.modelRequestPatch?.metadata?.legalCoverageActive, true);
    assert.deepEqual(preModel.hookSpecificOutput.modelRequestPatch?.metadata?.pilotdeckConvergence, {
      schemaVersion: 1,
      scope: "legal-coverage",
      phase: "configuration",
      stateHash: (preModel.hookSpecificOutput.modelRequestPatch?.metadata?.pilotdeckConvergence as { stateHash?: string })?.stateHash,
      blockingCode: "jurisdiction_missing",
      remainingCount: 12,
      writeBudget: { maxRecords: 12, maxSerializedBytes: 24576 },
    });

    const unchangedPreModel = await runHook({
      hookEventName: "PreModelRequest",
      sessionId: "legal-session",
      transcriptPath: "",
      cwd: workspace,
    });
    assert.equal(
      unchangedPreModel.hookSpecificOutput.additionalContext,
      preModel.hookSpecificOutput.additionalContext,
    );
    assert.match(unchangedPreModel.hookSpecificOutput.additionalContext ?? "", /next tool call before inspecting/u);
    assert.equal(unchangedPreModel.hookSpecificOutput.modelRequestPatch?.metadata?.legalCoverageActive, true);
    assert.equal(
      (unchangedPreModel.hookSpecificOutput.modelRequestPatch?.metadata?.pilotdeckConvergence as { stateHash?: string })?.stateHash,
      (preModel.hookSpecificOutput.modelRequestPatch?.metadata?.pilotdeckConvergence as { stateHash?: string })?.stateHash,
    );

    const configPath = join(workspace, STATE_ROOT, "config.json");
    const config = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    config.jurisdiction = "Synthetic jurisdiction";
    await writeJson(configPath, config);
    const changedPreModel = await runHook({
      hookEventName: "PreModelRequest",
      sessionId: "legal-session",
      transcriptPath: "",
      cwd: workspace,
    });
    assert.match(changedPreModel.hookSpecificOutput.additionalContext ?? "", /"code": "basis_date_missing"/u);

    const changedConfig = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    changedConfig.basisDate = "Synthetic review date";
    changedConfig.inputRoots = ["source-room"];
    changedConfig.deliverables = [{ id: "opinion", path: "deliverables/opinion.md", required: true }];
    await mkdir(join(workspace, "source-room"), { recursive: true });
    await mkdir(join(workspace, "deliverables"), { recursive: true });
    await writeFile(join(workspace, "deliverables", "opinion.md"), "# Draft\n");
    await writeJson(configPath, changedConfig);
    const sourceReview = await runHook({
      hookEventName: "PreModelRequest",
      sessionId: "legal-session",
      transcriptPath: "",
      cwd: workspace,
    });
    assert.match(sourceReview.hookSpecificOutput.additionalContext ?? "", /"milestone": "SOURCES_READY"/u);
    assert.match(sourceReview.hookSpecificOutput.additionalContext ?? "", /"maxRecords": 12/u);
    assert.match(sourceReview.hookSpecificOutput.additionalContext ?? "", /"maxSerializedBytes": 24576/u);
    const sourceConvergence = sourceReview.hookSpecificOutput.modelRequestPatch?.metadata?.pilotdeckConvergence as {
      nextBatch?: { group?: string; returned?: number; hasMore?: boolean };
      writeBudget?: { maxRecords?: number; maxSerializedBytes?: number };
    };
    assert.deepEqual(sourceConvergence.writeBudget, { maxRecords: 12, maxSerializedBytes: 24576 });

    const postCompact = await runHook({
      hookEventName: "PostCompact",
      sessionId: "legal-session",
      transcriptPath: "",
      cwd: workspace,
    });
    assert.equal(postCompact.hookSpecificOutput.dynamicContext?.length, 1);
    const recoveredContext = (postCompact.hookSpecificOutput.dynamicContext?.[0] as { content?: string } | undefined)?.content ?? "";
    assert.match(recoveredContext, /<legal_coverage_state>/u);
    for (const forbidden of ["rubric", "judge-response", "checkpoint_id", "ground truth"]) {
      assert.doesNotMatch(recoveredContext, new RegExp(forbidden, "iu"));
    }

    await rm(join(workspace, STATE_ROOT, "sessions"), { recursive: true, force: true });
    await writeFile(join(workspace, STATE_ROOT, "completion-proof.json"), "{\"forged\":true}\n");
    const blockedStop = await runHook({
      hookEventName: "Stop",
      sessionId: "legal-session",
      transcriptPath: "",
      cwd: workspace,
    });
    assert.equal(blockedStop.continue, false);
    await assert.rejects(stat(join(workspace, STATE_ROOT, "completion-proof.json")), { code: "ENOENT" });

    const ordinarySubmit = await runHook({
      hookEventName: "UserPromptSubmit",
      sessionId: "ordinary-session",
      transcriptPath: "",
      cwd: ordinaryWorkspace,
      prompt: "Summarize the weekly engineering notes.",
      internal: false,
    });
    assert.equal(ordinarySubmit.hookSpecificOutput.artifactContracts, undefined);
    assert.equal(ordinarySubmit.hookSpecificOutput.dynamicContext, undefined);
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(ordinaryWorkspace, { recursive: true, force: true });
  }
});

test("legal coverage hook groups repeated validator errors into one bounded milestone", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pilotdeck-legal-coverage-grouped-"));
  try {
    await writeCompleteFixture(workspace);
    const matricesPath = join(workspace, STATE_ROOT, "matrices.json");
    const matrices = JSON.parse(await readFile(matricesPath, "utf8")) as { matrices: Array<Record<string, unknown>> };
    matrices.matrices[0]!.status = "pending";
    matrices.matrices[1]!.status = "pending";
    await writeJson(matricesPath, matrices);

    const preModel = await runHook({
      hookEventName: "PreModelRequest",
      sessionId: "grouped-session",
      transcriptPath: "",
      cwd: workspace,
    });
    assert.match(preModel.hookSpecificOutput.additionalContext ?? "", /"code": "matrix_pending"/u);
    assert.match(preModel.hookSpecificOutput.additionalContext ?? "", /"occurrences": 2/u);
    assert.match(preModel.hookSpecificOutput.additionalContext ?? "", /"milestone": "EVIDENCE_READY"/u);
    assert.match(preModel.hookSpecificOutput.additionalContext ?? "", /one matrix/u);
    assert.match(preModel.hookSpecificOutput.additionalContext ?? "", /up to 12 records/u);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("legal coverage milestone digest ignores opaque incomplete-state hash churn", async () => {
  const { milestoneDigest } = await import(pathToFileURL(VALIDATOR_LIB).href) as {
    milestoneDigest: (result: Record<string, unknown>) => string;
  };
  const incomplete = {
    passed: false,
    stateHash: "a".repeat(64),
    errors: [{ phase: "facts", code: "material_facts_missing", path: "facts.json" }],
    counts: { sources: 64, facts: 0, issues: 0, authorities: 0, deliverables: 1 },
  };
  assert.equal(milestoneDigest(incomplete), milestoneDigest({
    ...incomplete,
    stateHash: "b".repeat(64),
  }));
  assert.notEqual(milestoneDigest(incomplete), milestoneDigest({
    ...incomplete,
    counts: { ...incomplete.counts, facts: 12 },
  }));
});

test("legal coverage hook activates a malformed configured workspace so the agent can repair it", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pilotdeck-legal-coverage-malformed-config-"));
  try {
    const stateRoot = join(workspace, STATE_ROOT);
    await mkdir(stateRoot, { recursive: true });
    await writeFile(join(stateRoot, "config.json"), "{ malformed\n");

    const submit = await runHook({
      hookEventName: "UserPromptSubmit",
      sessionId: "malformed-config-session",
      transcriptPath: "",
      cwd: workspace,
      prompt: "Continue the configured workspace.",
      internal: false,
    });
    assert.equal(submit.hookSpecificOutput.dynamicContext?.length, 1);

    const preModel = await runHook({
      hookEventName: "PreModelRequest",
      sessionId: "malformed-config-session",
      transcriptPath: "",
      cwd: workspace,
    });
    assert.match(preModel.hookSpecificOutput.additionalContext ?? "", /state_file_invalid/u);
    assert.equal(preModel.hookSpecificOutput.modelRequestPatch?.metadata?.legalCoverageState, "configuration");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("legal coverage hook rejects a symlinked session-state ancestor without writing outside the workspace", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pilotdeck-legal-coverage-session-symlink-"));
  const outside = await mkdtemp(join(tmpdir(), "pilotdeck-legal-coverage-session-outside-"));
  try {
    const stateRoot = join(workspace, STATE_ROOT);
    await mkdir(stateRoot, { recursive: true });
    await symlink(outside, join(stateRoot, "sessions"));

    const result = await runHookProcess({
      hookEventName: "UserPromptSubmit",
      sessionId: "symlink-session",
      transcriptPath: "",
      cwd: workspace,
      prompt: "Please conduct legal due diligence and issue a legal opinion.",
      internal: false,
    });
    assert.equal(result.exitCode, 2);
    assert.match(result.stderr, /failed closed/u);
    assert.equal(JSON.parse(result.stdout).continue, false);
    await assert.rejects(stat(join(outside, "symlink-session.json")), { code: "ENOENT" });
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("legal product plugin loads one skill and contains no benchmark-specific controls", async () => {
  const plugin = await loadPluginFromPath(PLUGIN_ROOT, "project");
  assert.equal(plugin.name, "legal-coverage");
  assert.equal(plugin.skills?.length, 1);
  assert.equal(plugin.skills?.[0]?.name, "legal-coverage:conduct-legal-due-diligence");
  assert.equal(plugin.hooksConfig?.PreModelRequest?.length, 1);
  assert.equal(plugin.hooksConfig?.PostCompact?.length, 1);

  const files = await collectFiles(PLUGIN_ROOT);
  const productionText = (await Promise.all(files.map((path) => readFile(path, "utf8")))).join("\n");
  assert.match(productionText, /Do not install system packages, language packages, plugins, or binaries/u);
  assert.match(productionText, /Treat every configured input root as read-only/u);
  for (const forbidden of ["legalBenchmarkCase", "case-input", "qingci", "rubric", "judge-response", "checkpoint_id"]) {
    assert.doesNotMatch(productionText, new RegExp(forbidden, "iu"));
  }
});

export async function writeCompleteFixture(workspace: string): Promise<void> {
  await mkdir(join(workspace, "source-room"), { recursive: true });
  await mkdir(join(workspace, "deliverables"), { recursive: true });
  await writeFile(join(workspace, "source-room", "record.txt"), "Synthetic company record.\n");
  const opinion = [
    "# Legal Opinion",
    "Synthetic entity registered capital of 120 currency units is material to the transaction.",
    "The threshold breach requires a closing condition.",
    "Synthetic transactions act Article 1 states that a closing condition may address the identified risk.",
    "",
  ].join("\n");
  await writeFile(join(workspace, "deliverables", "opinion.md"), opinion);

  const init = await runCli(
    workspace,
    "init",
    "--input", "source-room",
    "--deliverable", "opinion=deliverables/opinion.md",
    "--jurisdiction", "Synthetic jurisdiction",
    "--basis-date", "Synthetic review date",
  );
  assert.equal(init.exitCode, 0, init.stderr);
  const root = join(workspace, STATE_ROOT);
  await writeJson(join(root, "sources.json"), {
    schemaVersion: 1,
    sources: [{
      id: "S-001",
      path: "source-room/record.txt",
      sha256: sha256("Synthetic company record.\n"),
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
      {
        id: "equity-capital-timeline",
        status: "complete",
        entries: [{
          id: "M-001",
          summary: "Capital exceeds the configured analytical threshold.",
          factIds: ["F-001"],
          riskSignals: ["threshold_breach"],
          issueIds: ["I-001"],
        }],
      },
      ...[
        "holding-platform-special-rights",
        "governance-personnel-timeline",
        "contract-key-terms",
        "debt-collateral-liquidity",
        "employment-ip-timeline",
        "legal-authority",
      ].map((id) => ({ id, status: "not-applicable", entries: [], notApplicableReason: "No responsive synthetic facts in the supplied source." })),
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
      authorityIds: ["A-001"],
      analysis: "The normalized amount is above the analytical threshold.",
      conclusion: "The transaction should not close before confirmation.",
      recommendations: ["Use a documented condition precedent."],
    }],
  });
  await writeJson(join(root, "authorities.json"), {
    schemaVersion: 1,
    authorities: [{
      id: "A-001",
      name: "Synthetic transactions act",
      article: "Article 1",
      effectiveVersion: "Current synthetic version",
      effectiveDate: "Synthetic effective date",
      verificationStatus: "verified",
      sourceLocator: "Synthetic official source",
      supportedIssueIds: ["I-001"],
      supportedConclusion: "A closing condition may address the identified risk.",
    }],
  });
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
      authorityId: "A-001",
      status: "covered",
      deliverablePath: "deliverables/opinion.md",
      section: "Legal Opinion",
      locator: "paragraph 3",
      claim: "The authority supports the control.",
      quote: "Synthetic transactions act Article 1 states that a closing condition may address the identified risk.",
    }],
  });
}

async function writeManifestBoundFixture(workspace: string): Promise<{
  originalRoot: string;
  derivedRoot: string;
  originalPath: string;
  derivedPath: string;
  originalBytes: Buffer;
  derivedBytes: Buffer;
}> {
  await writeCompleteFixture(workspace);
  const originalRoot = ".pilotdeck/inputs/original";
  const derivedRoot = ".pilotdeck/inputs/derived";
  const originalRelative = "files/record.docx";
  const derivedRelative = "files/record_converted.txt";
  const originalPath = `${originalRoot}/${originalRelative}`;
  const derivedPath = `${derivedRoot}/${derivedRelative}`;
  const originalBytes = Buffer.from("synthetic office original bytes");
  const derivedBytes = Buffer.from("Synthetic company record.\n");
  await mkdir(join(workspace, originalRoot, "files"), { recursive: true });
  await mkdir(join(workspace, derivedRoot, "files"), { recursive: true });
  await writeFile(join(workspace, originalPath), originalBytes);
  await writeFile(join(workspace, derivedPath), derivedBytes);
  await writeJson(join(workspace, ".pilotdeck/input-manifest.json"), {
    schemaVersion: 1,
    createdBy: "pilotdeck-eval-runner",
    originalRoot,
    derivedRoot,
    entries: [{
      original: {
        path: originalRelative,
        sha256: sha256(originalBytes),
        bytes: originalBytes.byteLength,
      },
      derivations: [{
        path: derivedRelative,
        sha256: sha256(derivedBytes),
        bytes: derivedBytes.byteLength,
        method: "docx-text-extraction",
        version: "pilotdeck-eval-runner-v1",
      }],
    }],
  });

  const stateRoot = join(workspace, STATE_ROOT);
  const configPath = join(stateRoot, "config.json");
  const config = JSON.parse(await readFile(configPath, "utf8")) as { inputRoots: string[] };
  config.inputRoots = [originalRoot];
  await writeJson(configPath, config);
  const sourcesPath = join(stateRoot, "sources.json");
  const sources = JSON.parse(await readFile(sourcesPath, "utf8")) as { sources: Array<Record<string, unknown>> };
  sources.sources[0]!.path = originalPath;
  sources.sources[0]!.sha256 = sha256(originalBytes);
  sources.sources[0]!.extractionMethod = "runner-provided deterministic derivation";
  sources.sources[0]!.derivedArtifacts = [{
    path: derivedPath,
    sha256: sha256(derivedBytes),
    extractionMethod: "docx-text-extraction",
    extractorVersion: "pilotdeck-eval-runner-v1",
  }];
  await writeJson(sourcesPath, sources);
  await rm(join(workspace, "source-room"), { recursive: true, force: true });
  return { originalRoot, derivedRoot, originalPath, derivedPath, originalBytes, derivedBytes };
}

async function runCli(workspace: string, ...args: string[]): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  try {
    const result = await execFile(process.execPath, [CLI, ...args, "--workspace", workspace], { encoding: "utf8" });
    return { ...result, exitCode: 0 };
  } catch (error) {
    const failed = error as Error & { stdout?: string; stderr?: string; code?: number | string };
    return {
      stdout: failed.stdout ?? "",
      stderr: failed.stderr ?? failed.message,
      exitCode: typeof failed.code === "number" ? failed.code : 1,
    };
  }
}

async function runValidatorDirect(workspace: string): Promise<{ passed: boolean; errors: Array<{ code: string }> }> {
  const moduleUrl = pathToFileURL(VALIDATOR_LIB).href;
  const script = [
    `import { validateWorkspace } from ${JSON.stringify(moduleUrl)};`,
    "const result = await validateWorkspace({ workspaceRoot: process.argv[1], writeProof: true });",
    "process.stdout.write(JSON.stringify(result));",
  ].join("\n");
  const result = await execFile(process.execPath, ["--input-type=module", "--eval", script, workspace], { encoding: "utf8" });
  return JSON.parse(result.stdout) as { passed: boolean; errors: Array<{ code: string }> };
}

async function runHook(input: Record<string, unknown>): Promise<{
  continue?: boolean;
  hookSpecificOutput: {
    additionalContext?: string;
    dynamicContext?: unknown[];
    artifactContracts?: Array<{ path: string }>;
    modelRequestPatch?: { metadata?: Record<string, unknown> };
  };
}> {
  const result = await runHookProcess(input);
  if (result.exitCode !== 0) throw new Error(result.stderr || `Hook exited with code ${result.exitCode}.`);
  return JSON.parse(result.stdout) as never;
}

async function runHookProcess(input: Record<string, unknown>): Promise<{
  stdout: string;
  stderr: string;
  exitCode: number;
}> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [HOOK], { stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { output += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      resolvePromise({ stdout: output, stderr, exitCode: code ?? 1 });
    });
    child.stdin.end(JSON.stringify(input));
  });
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

async function collectFiles(directory: string): Promise<string[]> {
  const output: string[] = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) output.push(...await collectFiles(path));
    else output.push(path);
  }
  return output;
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
