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
      "opinion=opinion.md",
      "--jurisdiction",
      "pending-confirmation",
      "--basis-date",
      "pending-confirmation",
    );
    assert.equal(initialized.exitCode, 0, initialized.stderr);
    const initializedResult = JSON.parse(initialized.stdout) as {
      deliverableSkeletons: { created: Array<{ path: string }>; preserved: Array<{ path: string }> };
    };
    assert.deepEqual(initializedResult.deliverableSkeletons.created, [{ path: "opinion.md" }]);
    const deliverablePath = join(workspace, "opinion.md");
    const skeleton = await readFile(deliverablePath, "utf8");
    assert.match(skeleton, /^# Draft legal deliverable/u);

    const repeated = await runCli(
      workspace,
      "init",
      "--input", "source-room",
      "--deliverable", "opinion=opinion.md",
      "--jurisdiction", "pending-confirmation",
      "--basis-date", "pending-confirmation",
    );
    assert.equal(repeated.exitCode, 0, repeated.stderr);
    const repeatedResult = JSON.parse(repeated.stdout) as {
      deliverableSkeletons: { created: unknown[]; preserved: Array<{ path: string; reason: string }> };
    };
    assert.deepEqual(repeatedResult.deliverableSkeletons.created, []);
    assert.deepEqual(repeatedResult.deliverableSkeletons.preserved, [{
      path: "opinion.md",
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
    assert.match(milestone.hookSpecificOutput.additionalContext ?? "", /opinion\.md/u);
    assert.match(milestone.hookSpecificOutput.additionalContext ?? "", /with write_file/u);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("legal coverage initializer binds trusted manifests to original inputs", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pilotdeck-legal-coverage-manifest-init-"));
  const missingManifestWorkspace = await mkdtemp(join(tmpdir(), "pilotdeck-legal-coverage-manifest-missing-"));
  const originalRoot = ".pilotdeck/inputs/original";
  const derivedRoot = ".pilotdeck/inputs/derived";
  try {
    await mkdir(join(workspace, originalRoot), { recursive: true });
    await mkdir(join(workspace, derivedRoot), { recursive: true });
    await writeJson(join(workspace, ".pilotdeck/input-manifest.json"), {
      schemaVersion: 1,
      createdBy: "pilotdeck-eval-runner",
      originalRoot,
      derivedRoot,
      entries: [],
    });

    await runHook({
      hookEventName: "UserPromptSubmit",
      sessionId: "manifest-bound-init",
      transcriptPath: "",
      cwd: workspace,
      prompt: "Please conduct legal due diligence and issue a legal opinion.",
      internal: false,
    });
    const preModel = await runHook({
      hookEventName: "PreModelRequest",
      sessionId: "manifest-bound-init",
      transcriptPath: "",
      cwd: workspace,
    });
    assert.match(preModel.hookSpecificOutput.additionalContext ?? "", /"initializerCommand":/u);
    assert.match(preModel.hookSpecificOutput.additionalContext ?? "", /--input-from-manifest/u);
    assert.doesNotMatch(preModel.hookSpecificOutput.additionalContext ?? "", /--input \.pilotdeck\/inputs\/derived/u);

    const initialized = await runCli(
      workspace,
      "init",
      "--input-from-manifest",
      "--deliverable", "opinion=opinion.md",
      "--jurisdiction", "pending-confirmation",
      "--basis-date", "pending-confirmation",
    );
    assert.equal(initialized.exitCode, 0, initialized.stderr);
    const config = JSON.parse(await readFile(join(workspace, STATE_ROOT, "config.json"), "utf8")) as {
      inputRoots: string[];
    };
    assert.deepEqual(config.inputRoots, [originalRoot]);

    const ambiguous = await runCli(
      workspace,
      "init",
      "--input-from-manifest",
      "--input", derivedRoot,
      "--deliverable", "opinion=opinion.md",
      "--jurisdiction", "pending-confirmation",
      "--basis-date", "pending-confirmation",
    );
    assert.equal(ambiguous.exitCode, 1);
    assert.match(ambiguous.stderr, /legal_coverage_init_input_ambiguous/u);

    const missingManifest = await runCli(
      missingManifestWorkspace,
      "init",
      "--input-from-manifest",
      "--deliverable", "opinion=opinion.md",
      "--jurisdiction", "pending-confirmation",
      "--basis-date", "pending-confirmation",
    );
    assert.equal(missingManifest.exitCode, 1);
    assert.match(missingManifest.stderr, /legal_coverage_init_manifest_unavailable/u);
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(missingManifestWorkspace, { recursive: true, force: true });
  }
});

test("legal coverage source bootstrap creates only deterministic pending manifest rows", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pilotdeck-legal-coverage-source-bootstrap-"));
  try {
    const fixture = await writeManifestBoundFixture(workspace);
    await writeJson(join(workspace, STATE_ROOT, "sources.json"), { schemaVersion: 1, sources: [] });

    const preModel = await runHook({
      hookEventName: "PreModelRequest",
      sessionId: "manifest-source-bootstrap",
      transcriptPath: "",
      cwd: workspace,
    });
    assert.match(preModel.hookSpecificOutput.additionalContext ?? "", /"sourceBootstrapCommand":/u);
    assert.match(preModel.hookSpecificOutput.additionalContext ?? "", /bootstrap-sources --workspace/u);
    assert.match(preModel.hookSpecificOutput.additionalContext ?? "", /--from-manifest/u);

    const bootstrapped = await runCli(workspace, "bootstrap-sources", "--from-manifest");
    assert.equal(bootstrapped.exitCode, 0, bootstrapped.stderr);
    const result = JSON.parse(bootstrapped.stdout) as {
      bootstrapped: number;
      preserved: number;
      created: Array<{ id: string; path: string }>;
    };
    assert.equal(result.bootstrapped, 1);
    assert.equal(result.preserved, 0);
    assert.equal(result.created[0]?.path, fixture.originalPath);
    assert.match(result.created[0]?.id ?? "", /^SRC-[A-F0-9]{12}$/u);

    const ledger = JSON.parse(await readFile(join(workspace, STATE_ROOT, "sources.json"), "utf8")) as {
      sources: Array<Record<string, unknown>>;
    };
    assert.deepEqual(ledger.sources, [{
      id: result.created[0]?.id,
      path: fixture.originalPath,
      sha256: sha256(fixture.originalBytes),
      status: "pending",
      derivedArtifacts: [{
        path: fixture.derivedPath,
        sha256: sha256(fixture.derivedBytes),
        extractionMethod: "docx-text-extraction",
        extractorVersion: "pilotdeck-eval-runner-v1",
      }],
    }]);

    const repeated = await runCli(workspace, "bootstrap-sources", "--from-manifest");
    assert.equal(repeated.exitCode, 0, repeated.stderr);
    const repeatedResult = JSON.parse(repeated.stdout) as { bootstrapped: number; preserved: number };
    assert.equal(repeatedResult.bootstrapped, 0);
    assert.equal(repeatedResult.preserved, 1);
    assert.deepEqual(
      JSON.parse(await readFile(join(workspace, STATE_ROOT, "sources.json"), "utf8")),
      ledger,
    );

    const validation = await runCli(workspace, "validate");
    assert.equal(validation.exitCode, 2);
    const validationResult = JSON.parse(validation.stdout) as { errors: Array<{ code: string }> };
    const codes = new Set(validationResult.errors.map((error) => error.code));
    assert.equal(codes.has("source_pending"), true);
    assert.equal(codes.has("source_not_inventoried"), false);
    assert.equal(codes.has("manifest_original_not_inventoried"), false);

    const missingMode = await runCli(workspace, "bootstrap-sources");
    assert.equal(missingMode.exitCode, 1);
    assert.match(missingMode.stderr, /legal_coverage_source_bootstrap_mode_required/u);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("legal coverage injects deterministic disjoint worker batches for large pending source rooms", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pilotdeck-legal-coverage-source-plan-"));
  const outside = await mkdtemp(join(tmpdir(), "pilotdeck-legal-coverage-source-repair-outside-"));
  try {
    const fixture = await writeManifestBoundFixture(workspace);
    const manifestPath = join(workspace, ".pilotdeck/input-manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8")) as {
      entries: Array<{
        original: { path: string; sha256: string; bytes: number };
        derivations: Array<{ path: string; sha256: string; bytes: number; method: string; version: string }>;
      }>;
    };
    for (let index = 1; index < 24; index += 1) {
      const originalRelative = `files/record-${String(index).padStart(2, "0")}.docx`;
      const derivedRelative = `files/record-${String(index).padStart(2, "0")}_converted.txt`;
      const originalBytes = Buffer.from(`synthetic original ${index}`);
      const derivedBytes = Buffer.from(`Synthetic extracted record ${index}.\n`);
      await writeFile(join(workspace, fixture.originalRoot, originalRelative), originalBytes);
      await writeFile(join(workspace, fixture.derivedRoot, derivedRelative), derivedBytes);
      manifest.entries.push({
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
      });
    }
    await writeJson(manifestPath, manifest);
    await writeJson(join(workspace, STATE_ROOT, "sources.json"), { schemaVersion: 1, sources: [] });

    const bootstrapped = await runCli(workspace, "bootstrap-sources", "--from-manifest");
    assert.equal(bootstrapped.exitCode, 0, bootstrapped.stderr);
    const result = JSON.parse(bootstrapped.stdout) as {
      sourceReviewPlan: {
        mode: string;
        pending: number;
        returned: number;
        hasMore: boolean;
        batches: Array<{
          id: string;
          sourceIds: string[];
          fragmentPath: string;
          agentInput: { description: string; prompt: string; subagent_type: string };
        }>;
        workerContract: { mustNotWrite: string[] };
      };
    };
    assert.equal(result.sourceReviewPlan.mode, "delegated");
    assert.equal(result.sourceReviewPlan.pending, 24);
    assert.equal(result.sourceReviewPlan.returned, 24);
    assert.equal(result.sourceReviewPlan.hasMore, false);
    assert.equal(result.sourceReviewPlan.batches.length, 2);
    assert.deepEqual(result.sourceReviewPlan.batches.map((batch) => batch.sourceIds.length), [12, 12]);
    assert.equal(new Set(result.sourceReviewPlan.batches.flatMap((batch) => batch.sourceIds)).size, 24);
    assert.equal(new Set(result.sourceReviewPlan.batches.map((batch) => batch.fragmentPath)).size, 2);
    assert.equal(result.sourceReviewPlan.batches[0]?.agentInput.subagent_type, "general-purpose");
    assert.match(result.sourceReviewPlan.batches[0]?.agentInput.prompt ?? "", /Assigned source IDs:/u);
    assert.match(result.sourceReviewPlan.batches[0]?.agentInput.prompt ?? "", /fragmentType=legal-evidence-source-batch-review/u);
    assert.match(result.sourceReviewPlan.batches[0]?.agentInput.prompt ?? "", /facts must be an array of \{locator, statement\}/u);
    assert.match(result.sourceReviewPlan.batches[0]?.agentInput.prompt ?? "", /Do not use aliases such as reviews/u);
    assert.match(result.sourceReviewPlan.batches[0]?.agentInput.prompt ?? "", /Do not edit canonical legal-coverage ledgers/u);
    assert.equal(result.sourceReviewPlan.workerContract.mustNotWrite.includes("canonical legal-coverage ledgers"), true);

    const repeated = await runCli(workspace, "bootstrap-sources", "--from-manifest");
    assert.equal(repeated.exitCode, 0, repeated.stderr);
    const repeatedResult = JSON.parse(repeated.stdout) as { sourceReviewPlan: unknown };
    assert.deepEqual(repeatedResult.sourceReviewPlan, result.sourceReviewPlan);

    const preModel = await runHook({
      hookEventName: "PreModelRequest",
      sessionId: "large-pending-source-plan",
      transcriptPath: "",
      cwd: workspace,
    });
    const context = preModel.hookSpecificOutput.additionalContext ?? "";
    assert.match(context, /"group": "pending-source-review"/u);
    assert.match(context, /"callMode": "parallel-same-response"/u);
    assert.match(context, /"agentInput":/u);
    assert.match(context, /source-review-[a-f0-9]{12}\.json/u);
    assert.match(context, /Dispatch every injected workItems\.batches entry now/u);
    assert.match(context, /Pass each batch\.agentInput object to the agent tool verbatim/u);
    assert.match(context, /do not re-list sources that are already partitioned/u);
    assert.match(context, /execute guidanceCommand if it has not already been loaded/u);

    const dispatchHash = (preModel.hookSpecificOutput.modelRequestPatch?.metadata?.pilotdeckConvergence as {
      stateHash?: string;
    } | undefined)?.stateHash;
    const ledger = JSON.parse(await readFile(join(workspace, STATE_ROOT, "sources.json"), "utf8")) as {
      sources: Array<{ id: string; path: string }>;
    };
    const pathById = new Map(ledger.sources.map((source) => [source.id, source.path]));
    const fragmentRoot = join(workspace, STATE_ROOT, "fragments");
    await mkdir(fragmentRoot, { recursive: true });

    const firstBatch = result.sourceReviewPlan.batches[0]!;
    await writeJson(join(workspace, firstBatch.fragmentPath), {
      schemaVersion: 1,
      fragmentType: "legal-evidence-source-batch-review",
      fragmentId: firstBatch.id,
      assignedSourceIds: firstBatch.sourceIds,
      reviews: [],
    });
    const invalidReceipt = await runHook({
      hookEventName: "PreModelRequest",
      sessionId: "large-pending-source-plan",
      transcriptPath: "",
      cwd: workspace,
    });
    assert.match(invalidReceipt.hookSpecificOutput.additionalContext ?? "", /"group": "pending-source-review"/u);
    assert.equal(
      (invalidReceipt.hookSpecificOutput.modelRequestPatch?.metadata?.pilotdeckConvergence as { stateHash?: string })?.stateHash,
      dispatchHash,
    );

    for (const batch of result.sourceReviewPlan.batches) {
      await writeJson(join(workspace, batch.fragmentPath), {
        schemaVersion: 1,
        fragmentType: "legal-evidence-source-batch-review",
        fragmentId: batch.id,
        assignedSourceIds: batch.sourceIds,
        sources: batch.sourceIds.map((sourceId) => ({
          sourceId,
          sourcePath: pathById.get(sourceId),
          inspectionMethod: "verified derived text inspection",
          facts: [{ locator: "converted.txt:1", statement: `Reviewed ${sourceId}.` }],
          evidenceClass: "other",
          verificationState: "verified",
          conflicts: sourceId === batch.sourceIds[0]
            ? ["Synthetic conflict is preserved on the source ledger."]
            : [],
          unresolvedItems: sourceId === batch.sourceIds[0]
            ? ["Synthetic unresolved item is preserved on the source ledger."]
            : [],
          proposedMateriality: "non-material",
        })),
      });
    }
    const mergeReceipt = await runHook({
      hookEventName: "PreModelRequest",
      sessionId: "large-pending-source-plan",
      transcriptPath: "",
      cwd: workspace,
    });
    const mergeContext = mergeReceipt.hookSpecificOutput.additionalContext ?? "";
    assert.match(mergeContext, /"group": "source-fragment-merge"/u);
    assert.match(mergeContext, /"mode": "main-agent-merge"/u);
    assert.match(mergeContext, /"returned": 4/u);
    assert.match(mergeContext, /A validated worker receipt is ready/u);
    assert.match(mergeContext, /sibling read_file calls for current sources\.json and facts\.json/u);
    assert.match(mergeContext, /"sourceFragmentCommand":/u);
    assert.match(mergeContext, /source-merge-prepare/u);
    assert.match(mergeContext, /"proposal":/u);
    assert.match(mergeContext, /"template":/u);
    assert.match(mergeContext, /records a state-bound readiness checkpoint/u);
    assert.match(mergeContext, /Do not edit canonical ledgers/u);
    assert.match(mergeContext, /Do not re-dispatch workers or read raw sources/u);
    const mergeConvergence = mergeReceipt.hookSpecificOutput.modelRequestPatch?.metadata?.pilotdeckConvergence as {
      stateHash?: string;
      nextBatch?: { group?: string; returned?: number; hasMore?: boolean };
      writeBudget?: { maxRecords?: number; maxSerializedBytes?: number };
    };
    assert.notEqual(mergeConvergence.stateHash, dispatchHash);
    assert.deepEqual(mergeConvergence.nextBatch, {
      group: "source-fragment-merge",
      returned: 4,
      hasMore: true,
    });
    assert.deepEqual(mergeConvergence.writeBudget, { maxRecords: 4, maxSerializedBytes: 24576 });

    const envelope = JSON.parse(mergeContext
      .replace(/^<legal_coverage_state>\n/u, "")
      .replace(/\n<\/legal_coverage_state>$/u, "")) as {
      workItems: {
        readiness: { path: string };
        proposal: {
          path: string;
          expectedStateHash: string;
          fragmentPath: string;
          receiptSha256: string;
          sourceIds: string[];
        };
      };
    };
    const proposal = envelope.workItems.proposal;
    const firstReceiptHash = sha256(await readFile(join(workspace, firstBatch.fragmentPath)));
    const prepared = await runCli(
      workspace,
      "source-merge-prepare",
      "--checkpoint", envelope.workItems.readiness.path,
      "--expected-state-hash", proposal.expectedStateHash,
      "--fragment", proposal.fragmentPath,
      "--receipt-sha256", proposal.receiptSha256,
      ...proposal.sourceIds.flatMap((sourceId) => ["--source-id", sourceId]),
      "--limit", "4",
      "--max-bytes", "24576",
    );
    assert.equal(prepared.exitCode, 0, prepared.stderr);
    const preparedResult = JSON.parse(prepared.stdout) as {
      receiptSha256: string;
      sources: Array<{
        sourceId: string;
        facts: Array<{ locator: string; locatorRef: string; statement: string }>;
      }>;
    };
    assert.equal(preparedResult.receiptSha256, proposal.receiptSha256);
    assert.deepEqual(preparedResult.sources.map((source) => source.sourceId), proposal.sourceIds);
    assert.equal(preparedResult.sources.every((source) => source.facts.every((fact) =>
      /^LR-[a-f0-9]{16}$/u.test(fact.locatorRef)
    )), true);
    assert.equal(Buffer.byteLength(JSON.stringify(preparedResult)) <= 24576, true);

    const readinessPath = join(workspace, envelope.workItems.readiness.path);
    const readinessBytes = await readFile(readinessPath);
    const readiness = JSON.parse(readinessBytes.toString("utf8")) as {
      checkpointType: string;
      expectedStateHash: string;
      proposalPath: string;
      sourceIds: string[];
      sliceSha256: string;
    };
    assert.equal(readiness.checkpointType, "legal-source-merge-readiness");
    assert.equal(readiness.expectedStateHash, proposal.expectedStateHash);
    assert.equal(readiness.proposalPath, proposal.path);
    assert.deepEqual(readiness.sourceIds, proposal.sourceIds);
    assert.match(readiness.sliceSha256, /^[a-f0-9]{64}$/u);

    const proposeReceipt = await runHook({
      hookEventName: "PreModelRequest",
      sessionId: "large-pending-source-plan",
      transcriptPath: "",
      cwd: workspace,
    });
    const proposeContext = proposeReceipt.hookSpecificOutput.additionalContext ?? "";
    assert.match(proposeContext, /"group": "source-fragment-propose"/u);
    assert.match(proposeContext, /"mode": "main-agent-propose"/u);
    assert.match(proposeContext, /"validated": true/u);
    const proposeEnvelope = JSON.parse(proposeContext
      .replace(/^<legal_coverage_state>\n/u, "")
      .replace(/\n<\/legal_coverage_state>$/u, "")) as {
      nextAction: string;
      workItems: {
        preparedSlice: typeof preparedResult;
      };
    };
    assert.deepEqual(proposeEnvelope.workItems.preparedSlice, preparedResult);
    assert.equal(Buffer.byteLength(JSON.stringify(proposeEnvelope.workItems.preparedSlice)) <= 24576, true);
    assert.match(proposeContext, /The bounded evidence handoff is prepared and state-bound/u);
    assert.match(proposeContext, /As the next tool call, write one source-merge proposal/u);
    assert.match(proposeContext, /workItems\.preparedSlice as the complete current evidence interface/u);
    assert.match(proposeContext, /Do not read the readiness checkpoint, fragment, canonical ledgers, or raw sources/u);
    assert.match(proposeContext, /Set thresholdAssessment to null unless the source supports a numeric threshold comparison/u);
    assert.match(proposeEnvelope.nextAction, /"operator":"gt","actual":120,"threshold":100/u);
    assert.match(proposeEnvelope.nextAction, /operator one of gt, gte, lt, lte, or eq/u);
    assert.doesNotMatch(proposeContext, /"sourceFragmentCommand":/u);
    assert.doesNotMatch(proposeContext, /"sourceMergeApplyCommand":/u);
    const proposeConvergence = (
      proposeReceipt.hookSpecificOutput.modelRequestPatch?.metadata?.pilotdeckConvergence as {
        stateHash?: string;
        progressOrdinal: number;
        repairOrdinal: number;
        handoffOrdinal: number;
      }
    );
    const proposeConvergenceHash = proposeConvergence.stateHash;
    assert.notEqual(proposeConvergenceHash, mergeConvergence.stateHash);

    await writeJson(readinessPath, { ...readiness, sliceSha256: "0".repeat(64) });
    const tamperedReadiness = await runHook({
      hookEventName: "PreModelRequest",
      sessionId: "large-pending-source-plan",
      transcriptPath: "",
      cwd: workspace,
    });
    assert.match(tamperedReadiness.hookSpecificOutput.additionalContext ?? "", /"group": "source-fragment-merge"/u);
    assert.doesNotMatch(tamperedReadiness.hookSpecificOutput.additionalContext ?? "", /"preparedSlice":/u);
    assert.equal(
      (tamperedReadiness.hookSpecificOutput.modelRequestPatch?.metadata?.pilotdeckConvergence as { stateHash?: string })?.stateHash,
      mergeConvergence.stateHash,
    );
    await writeFile(readinessPath, readinessBytes);

    const stalePrepare = await runCli(
      workspace,
      "source-merge-prepare",
      "--checkpoint", envelope.workItems.readiness.path,
      "--expected-state-hash", "0".repeat(64),
      "--fragment", proposal.fragmentPath,
      "--receipt-sha256", proposal.receiptSha256,
      ...proposal.sourceIds.flatMap((sourceId) => ["--source-id", sourceId]),
      "--limit", "4",
      "--max-bytes", "24576",
    );
    assert.equal(stalePrepare.exitCode, 1);
    assert.match(stalePrepare.stderr, /stale_state_hash/u);
    assert.deepEqual(await readFile(readinessPath), readinessBytes);

    const staleSlice = await runCli(
      workspace,
      "fragment-slice",
      "--fragment", firstBatch.fragmentPath,
      "--receipt-sha256", "0".repeat(64),
      "--source-id", firstBatch.sourceIds[0]!,
    );
    assert.equal(staleSlice.exitCode, 1);
    assert.match(staleSlice.stderr, /source_fragment_receipt_invalid/u);
    const proposalPath = join(workspace, proposal.path);
    const proposalBase = {
      schemaVersion: 1,
      phase: "sources",
      group: "source-fragment-merge",
      expectedStateHash: proposal.expectedStateHash,
      fragmentPath: proposal.fragmentPath,
      receiptSha256: proposal.receiptSha256,
      sourceIds: proposal.sourceIds,
      facts: proposal.sourceIds.map((sourceId) => ({
        subject: sourceId,
        predicate: "contains reviewed evidence",
        value: `Reviewed ${sourceId}.`,
        missingTimeReason: "The synthetic source contains no usable date.",
        sourceRefs: [{
          sourceId,
          locatorRef: preparedResult.sources.find((source) => source.sourceId === sourceId)!.facts[0]!.locatorRef,
        }],
        evidenceClass: "other",
        verificationStatus: "verified",
        conflictStatus: "none",
        material: false,
        critical: false,
      })),
      noMaterialFacts: [],
    };
    const invalidLocatorRefBody = {
      ...proposalBase,
      facts: [{
        ...proposalBase.facts[0],
        sourceRefs: [{ sourceId: proposal.sourceIds[0], locatorRef: "LR-0000000000000000" }],
      }],
      noMaterialFacts: proposal.sourceIds.slice(1).map((sourceId) => ({
        sourceId,
        reason: "Synthetic locatorRef rejection fixture.",
      })),
    };
    await writeJson(proposalPath, invalidLocatorRefBody);
    const invalidLocatorRef = await runHook({
      hookEventName: "PreModelRequest",
      sessionId: "locator-ref-rejection",
      transcriptPath: "",
      cwd: workspace,
    });
    assert.match(
      invalidLocatorRef.hookSpecificOutput.additionalContext ?? "",
      /source_merge_fact_locator_ref_unverified/u,
    );
    const invalidProposalBody = {
      ...proposalBase,
      facts: [
        { ...proposalBase.facts[0], evidenceClass: "official-record" },
        {
          ...proposalBase.facts[1],
          dateOrPeriod: "2026",
          missingTimeReason: "Conflicting synthetic time fields.",
          thresholdAssessment: {
            operator: ">",
            numericActual: 120,
            numericThreshold: 100,
            breached: true,
          },
        },
        proposalBase.facts[2]!,
      ],
      noMaterialFacts: proposal.sourceIds.slice(3).map((sourceId) => ({
        sourceId,
        reason: "Synthetic invalid-proposal fixture.",
      })),
    };
    await writeJson(proposalPath, invalidProposalBody);
    const invalidProposal = await runHook({
      hookEventName: "PreModelRequest",
      sessionId: "large-pending-source-plan",
      transcriptPath: "",
      cwd: workspace,
    });
    const invalidProposalContext = invalidProposal.hookSpecificOutput.additionalContext ?? "";
    assert.match(invalidProposalContext, /"group": "source-fragment-repair"/u);
    assert.match(invalidProposalContext, /"mode": "main-agent-repair"/u);
    assert.match(invalidProposalContext, /source_merge_fact_evidence_mismatch/u);
    assert.match(invalidProposalContext, /source_merge_fact_time_invalid/u);
    const invalidProposalEnvelope = JSON.parse(invalidProposalContext
      .replace(/^<legal_coverage_state>\n/u, "")
      .replace(/\n<\/legal_coverage_state>$/u, "")) as {
      nextAction: string;
      workItems: {
        proposal: {
          path: string;
          expectedStateHash: string;
          sourceIds: string[];
        };
        repair: {
          path: string;
          proposalPath: string;
          proposalSha256: string;
          diagnosticSha256: string;
          appliedReceiptPath: string;
          limits: { maxOperations: number; maxSerializedBytes: number };
          template: {
            schemaVersion: number;
            phase: string;
            group: string;
            expectedStateHash: string;
            proposalPath: string;
            proposalSha256: string;
            diagnosticSha256: string;
            operations: Array<{ factNumber: number; action: string; fact: Record<string, unknown> }>;
          };
          repairSlice: {
            diagnostics: {
              total: number;
              returned: number;
              hasMore: boolean;
              items: Array<{ factNumber?: number; code: string; message: string }>;
            };
            rejectedFacts: Array<{
              factNumber: number;
              diagnosticCodes: string[];
              fact: unknown;
            }>;
            sourceContext: Array<{
              sourceId: string;
              evidenceClass: string;
              allowedFragmentFacts: Array<{ locatorRef: string; locator: string; statement: string }>;
              conflicts: string[];
              unresolvedItems: string[];
            }>;
          };
        };
      };
    };
    const immutableRepair = invalidProposalEnvelope.workItems.repair;
    assert.equal(immutableRepair.repairSlice.diagnostics.total, 3);
    assert.equal(immutableRepair.repairSlice.diagnostics.returned, 3);
    assert.equal(immutableRepair.repairSlice.diagnostics.hasMore, false);
    assert.deepEqual(
      immutableRepair.repairSlice.diagnostics.items.map((item) => item.code),
      [
        "source_merge_fact_evidence_mismatch",
        "source_merge_fact_time_invalid",
        "source_merge_threshold_invalid",
      ],
    );
    assert.deepEqual(
      immutableRepair.repairSlice.diagnostics.items.map((item) => item.factNumber),
      [1, 2, 2],
    );
    assert.match(immutableRepair.repairSlice.diagnostics.items[0]?.message ?? "", /Proposal fact 1 evidenceClass/u);
    assert.match(immutableRepair.repairSlice.diagnostics.items[1]?.message ?? "", /Proposal fact 2 requires exactly one/u);
    assert.match(immutableRepair.repairSlice.diagnostics.items[2]?.message ?? "", /Proposal fact 2 has an invalid thresholdAssessment/u);
    assert.match(invalidProposalEnvelope.nextAction, /Write exactly one new immutable source repair transaction/u);
    assert.match(invalidProposalEnvelope.nextAction, /Do not read or overwrite the rejected proposal/u);
    assert.match(invalidProposalEnvelope.nextAction, /template already applies validator-derived fields/u);
    assert.match(invalidProposalEnvelope.nextAction, /exact sourceContext evidenceClass/u);
    const invalidProposalBytes = await readFile(proposalPath);
    assert.equal(immutableRepair.proposalPath, proposal.path);
    assert.equal(immutableRepair.proposalSha256, sha256(invalidProposalBytes));
    assert.match(immutableRepair.path, /source-repair-[a-f0-9]{12}\.json$/u);
    assert.match(immutableRepair.appliedReceiptPath, /source-repair-applied-[a-f0-9]{12}\.json$/u);
    assert.equal(immutableRepair.limits.maxOperations, 2);
    assert.equal(immutableRepair.limits.maxSerializedBytes, 24576);
    assert.deepEqual(immutableRepair.repairSlice.rejectedFacts.map((item) => item.factNumber), [1, 2]);
    assert.deepEqual(immutableRepair.repairSlice.rejectedFacts[0]?.fact, invalidProposalBody.facts[0]);
    assert.deepEqual(immutableRepair.repairSlice.rejectedFacts[0]?.diagnosticCodes, ["source_merge_fact_evidence_mismatch"]);
    const firstRepairSource = immutableRepair.repairSlice.sourceContext
      .find((source) => source.sourceId === proposal.sourceIds[0]);
    assert.equal(firstRepairSource?.evidenceClass, "other");
    assert.deepEqual(firstRepairSource?.allowedFragmentFacts, [
      {
        locatorRef: preparedResult.sources[0]!.facts[0]!.locatorRef,
        locator: "converted.txt:1",
        statement: `Reviewed ${proposal.sourceIds[0]}.`,
      },
    ]);
    assert.deepEqual(firstRepairSource?.conflicts, ["Synthetic conflict is preserved on the source ledger."]);
    assert.deepEqual(firstRepairSource?.unresolvedItems, ["Synthetic unresolved item is preserved on the source ledger."]);
    assert.equal(immutableRepair.template.operations[0]?.fact.evidenceClass, "other");
    assert.doesNotMatch(invalidProposalContext, /"currentProposal":/u);
    assert.doesNotMatch(invalidProposalContext, /"preparedSlice":/u);
    assert.doesNotMatch(invalidProposalContext, /"sourceFragmentCommand":/u);
    assert.doesNotMatch(invalidProposalContext, /"sourceMergeApplyCommand":/u);
    assert.doesNotMatch(invalidProposalContext, /"sourceMergeRepairApplyCommand":/u);
    const repairConvergence = (
      invalidProposal.hookSpecificOutput.modelRequestPatch?.metadata?.pilotdeckConvergence as {
        stateHash?: string;
        progressOrdinal: number;
        repairOrdinal: number;
        repairPreparationOrdinal: number;
        handoffOrdinal: number;
      }
    );
    const repairConvergenceHash = repairConvergence.stateHash;
    assert.notEqual(repairConvergenceHash, proposeConvergenceHash);
    assert.equal(repairConvergence.repairOrdinal, proposeConvergence.repairOrdinal + 1);
    assert.equal(repairConvergence.repairPreparationOrdinal, 0);
    assert.equal(repairConvergence.progressOrdinal, proposeConvergence.progressOrdinal);
    assert.equal(repairConvergence.handoffOrdinal, proposeConvergence.handoffOrdinal);

    const invalidProposalHash = sha256(invalidProposalBytes);
    const rejectedDirectApply = await runCli(
      workspace,
      "source-merge-apply",
      "--input-file", proposal.path,
      "--proposal-sha256", invalidProposalHash,
    );
    assert.equal(rejectedDirectApply.exitCode, 1);
    assert.match(rejectedDirectApply.stderr, /source_merge_fact_evidence_mismatch/u);
    assert.doesNotMatch(rejectedDirectApply.stderr, /source_merge_threshold_invalid/u);

    const wrongRepairPath = join(workspace, STATE_ROOT, "fragments", "wrong-repair.json");
    await writeJson(wrongRepairPath, { wrong: true });
    await runHook({
      hookEventName: "PostToolUse",
      sessionId: "large-pending-source-plan",
      transcriptPath: "",
      cwd: workspace,
      toolName: "write_file",
      toolInput: { file_path: `${STATE_ROOT}/fragments/wrong-repair.json` },
      toolUseId: "wrong-target-write",
    });
    const afterWrongRead = await runHook({
      hookEventName: "PreModelRequest",
      sessionId: "large-pending-source-plan",
      transcriptPath: "",
      cwd: workspace,
    });
    assert.equal(
      (afterWrongRead.hookSpecificOutput.modelRequestPatch?.metadata?.pilotdeckConvergence as {
        repairPreparationOrdinal: number;
      }).repairPreparationOrdinal,
      0,
    );

    await runHook({
      hookEventName: "PostToolUse",
      sessionId: "large-pending-source-plan",
      transcriptPath: "",
      cwd: workspace,
      toolName: "write_file",
      toolInput: { file_path: immutableRepair.path },
      toolUseId: "missing-target-write",
    });
    const afterMissingTargetWrite = await runHook({
      hookEventName: "PreModelRequest",
      sessionId: "large-pending-source-plan",
      transcriptPath: "",
      cwd: workspace,
    });
    assert.equal(
      (afterMissingTargetWrite.hookSpecificOutput.modelRequestPatch?.metadata?.pilotdeckConvergence as {
        repairPreparationOrdinal: number;
      }).repairPreparationOrdinal,
      0,
    );

    await runHook({
      hookEventName: "PostToolUse",
      sessionId: "large-pending-source-plan",
      transcriptPath: "",
      cwd: workspace,
      toolName: "read_file",
      toolInput: { file_path: proposal.path },
      toolUseId: "rejected-proposal-read",
    });
    const afterRejectedProposalRead = await runHook({
      hookEventName: "PreModelRequest",
      sessionId: "large-pending-source-plan",
      transcriptPath: "",
      cwd: workspace,
    });
    assert.equal(
      (afterRejectedProposalRead.hookSpecificOutput.modelRequestPatch?.metadata?.pilotdeckConvergence as {
        repairPreparationOrdinal: number;
      }).repairPreparationOrdinal,
      0,
    );

    const repairBody = {
      ...immutableRepair.template,
      operations: [
        {
          factNumber: 1,
          action: "replace",
          fact: {
            ...immutableRepair.template.operations[0]?.fact,
          },
        },
        {
          factNumber: 2,
          action: "replace",
          fact: {
            ...invalidProposalBody.facts[1],
            missingTimeReason: undefined,
            thresholdAssessment: {
              operator: "gt",
              actual: 120,
              threshold: 100,
              breached: true,
            },
          },
        },
      ],
    };
    const repairPath = join(workspace, immutableRepair.path);
    const canonicalSourcesBeforeRepair = await readFile(join(workspace, STATE_ROOT, "sources.json"));
    const canonicalFactsBeforeRepair = await readFile(join(workspace, STATE_ROOT, "facts.json"));
    const invalidRepairs: Array<{
      name: string;
      body: Record<string, unknown>;
      errorCode: RegExp;
    }> = [
      {
        name: "missing rejected fact operation",
        body: { ...repairBody, operations: repairBody.operations.slice(0, 1) },
        errorCode: /source_repair_operation_count_invalid/u,
      },
      {
        name: "duplicate fact operation",
        body: { ...repairBody, operations: [repairBody.operations[0], repairBody.operations[0]] },
        errorCode: /source_repair_fact_scope_invalid/u,
      },
      {
        name: "unknown fact operation",
        body: {
          ...repairBody,
          operations: [repairBody.operations[0], { ...repairBody.operations[1], factNumber: 99 }],
        },
        errorCode: /source_repair_fact_scope_invalid/u,
      },
      {
        name: "extra valid-fact operation",
        body: {
          ...repairBody,
          operations: [
            ...repairBody.operations,
            { factNumber: 3, action: "replace", fact: invalidProposalBody.facts[2] },
          ],
        },
        errorCode: /source_repair_operation_count_invalid/u,
      },
      {
        name: "unsupported action",
        body: {
          ...repairBody,
          operations: [repairBody.operations[0], { ...repairBody.operations[1], action: "merge" }],
        },
        errorCode: /source_repair_operation_invalid/u,
      },
      {
        name: "placeholder replacement",
        body: {
          ...repairBody,
          operations: [
            {
              ...repairBody.operations[0],
              fact: { ...repairBody.operations[0]!.fact, subject: "<legal subject>" },
            },
            repairBody.operations[1],
          ],
        },
        errorCode: /source_merge_fact_content_missing/u,
      },
      {
        name: "removal without reason",
        body: {
          ...repairBody,
          operations: [
            repairBody.operations[0],
            { factNumber: 2, action: "remove", reason: "" },
          ],
        },
        errorCode: /source_repair_removal_invalid/u,
      },
      {
        name: "changed diagnostic identity",
        body: { ...repairBody, diagnosticSha256: "0".repeat(64) },
        errorCode: /source_repair_scope_mismatch/u,
      },
      {
        name: "unverified replacement locator",
        body: {
          ...repairBody,
          operations: [
            {
              ...repairBody.operations[0],
              fact: {
                ...repairBody.operations[0]!.fact,
                sourceRefs: [{ sourceId: proposal.sourceIds[0], locator: "converted.txt:999" }],
              },
            },
            repairBody.operations[1],
          ],
        },
        errorCode: /source_merge_fact_locator_unverified/u,
      },
      {
        name: "byte overflow",
        body: { ...repairBody, padding: "x".repeat(24576) },
        errorCode: /source_repair_byte_limit/u,
      },
    ];
    for (const invalidRepair of invalidRepairs) {
      await writeJson(repairPath, invalidRepair.body);
      await runHook({
        hookEventName: "PostToolUse",
        sessionId: "large-pending-source-plan",
        transcriptPath: "",
        cwd: workspace,
        toolName: "write_file",
        toolInput: { file_path: immutableRepair.path },
        toolUseId: `invalid-repair-${invalidRepair.name}`,
      });
      const rejectedRepair = await runHook({
        hookEventName: "PreModelRequest",
        sessionId: "large-pending-source-plan",
        transcriptPath: "",
        cwd: workspace,
      });
      const rejectedRepairContext = rejectedRepair.hookSpecificOutput.additionalContext ?? "";
      assert.match(rejectedRepairContext, invalidRepair.errorCode, invalidRepair.name);
      assert.doesNotMatch(rejectedRepairContext, /"sourceMergeRepairApplyCommand":/u, invalidRepair.name);
      assert.equal(
        (rejectedRepair.hookSpecificOutput.modelRequestPatch?.metadata?.pilotdeckConvergence as {
          repairPreparationOrdinal: number;
        }).repairPreparationOrdinal,
        0,
        invalidRepair.name,
      );
      assert.deepEqual(
        await readFile(join(workspace, STATE_ROOT, "sources.json")),
        canonicalSourcesBeforeRepair,
        invalidRepair.name,
      );
      assert.deepEqual(
        await readFile(join(workspace, STATE_ROOT, "facts.json")),
        canonicalFactsBeforeRepair,
        invalidRepair.name,
      );
    }
    await writeJson(repairPath, repairBody);
    await runHook({
      hookEventName: "PostToolUse",
      sessionId: "large-pending-source-plan",
      transcriptPath: "",
      cwd: workspace,
      toolName: "write_file",
      toolInput: { file_path: immutableRepair.path },
      toolUseId: "immutable-repair-write",
    });
    const repairApplyReceipt = await runHook({
      hookEventName: "PreModelRequest",
      sessionId: "large-pending-source-plan",
      transcriptPath: "",
      cwd: workspace,
    });
    const repairApplyContext = repairApplyReceipt.hookSpecificOutput.additionalContext ?? "";
    assert.match(repairApplyContext, /"group": "source-fragment-repair-apply"/u);
    assert.match(repairApplyContext, /"mode": "main-agent-repair-apply"/u);
    assert.match(repairApplyContext, /"sourceMergeRepairApplyCommand":/u);
    assert.match(repairApplyContext, /source-repair-apply/u);
    assert.doesNotMatch(repairApplyContext, /"repairSlice":/u);
    assert.doesNotMatch(repairApplyContext, /"template":/u);
    const repairApplyEnvelope = JSON.parse(repairApplyContext
      .replace(/^<legal_coverage_state>\n/u, "")
      .replace(/\n<\/legal_coverage_state>$/u, "")) as {
      sourceMergeRepairApplyCommand: string;
      workItems: { repair: { path: string; repairSha256: string; validated: boolean } };
    };
    assert.equal(repairApplyEnvelope.workItems.repair.path, immutableRepair.path);
    assert.equal(repairApplyEnvelope.workItems.repair.validated, true);
    const repairApplyConvergence = repairApplyReceipt.hookSpecificOutput.modelRequestPatch?.metadata
      ?.pilotdeckConvergence as {
        progressOrdinal: number;
        repairOrdinal: number;
        repairPreparationOrdinal: number;
      };
    assert.equal(
      repairApplyConvergence.repairPreparationOrdinal,
      1,
    );
    assert.equal(repairApplyConvergence.progressOrdinal, repairConvergence.progressOrdinal);
    assert.equal(repairApplyConvergence.repairOrdinal, repairConvergence.repairOrdinal);

    await runHook({
      hookEventName: "PostToolUse",
      sessionId: "large-pending-source-plan",
      transcriptPath: "",
      cwd: workspace,
      toolName: "write_file",
      toolInput: { file_path: immutableRepair.path },
      toolUseId: "replayed-repair-write",
    });
    const afterReplayedWrite = await runHook({
      hookEventName: "PreModelRequest",
      sessionId: "large-pending-source-plan",
      transcriptPath: "",
      cwd: workspace,
    });
    assert.equal(
      (afterReplayedWrite.hookSpecificOutput.modelRequestPatch?.metadata?.pilotdeckConvergence as {
        repairPreparationOrdinal: number;
      }).repairPreparationOrdinal,
      1,
    );

    const beforeApplySources = await readFile(join(workspace, STATE_ROOT, "sources.json"));
    const beforeApplyFacts = await readFile(join(workspace, STATE_ROOT, "facts.json"));
    const validRepairBytes = await readFile(repairPath);
    const repairHash = sha256(validRepairBytes);

    await writeFile(proposalPath, Buffer.concat([invalidProposalBytes, Buffer.from("\n")]));
    const changedProposal = await runCli(
      workspace,
      "source-repair-apply",
      "--input-file", immutableRepair.path,
      "--repair-sha256", repairHash,
    );
    assert.equal(changedProposal.exitCode, 1);
    assert.match(changedProposal.stderr, /source_repair_out_of_scope/u);
    assert.deepEqual(await readFile(join(workspace, STATE_ROOT, "sources.json")), beforeApplySources);
    assert.deepEqual(await readFile(join(workspace, STATE_ROOT, "facts.json")), beforeApplyFacts);
    await writeFile(proposalPath, invalidProposalBytes);

    const originalSourcePath = join(workspace, fixture.originalPath);
    const originalSourceBytes = await readFile(originalSourcePath);
    await writeFile(originalSourcePath, Buffer.concat([originalSourceBytes, Buffer.from("changed")]));
    const staleState = await runCli(
      workspace,
      "source-repair-apply",
      "--input-file", immutableRepair.path,
      "--repair-sha256", repairHash,
    );
    assert.equal(staleState.exitCode, 1);
    assert.match(staleState.stderr, /source_repair_out_of_scope/u);
    assert.deepEqual(await readFile(join(workspace, STATE_ROOT, "sources.json")), beforeApplySources);
    assert.deepEqual(await readFile(join(workspace, STATE_ROOT, "facts.json")), beforeApplyFacts);
    await writeFile(originalSourcePath, originalSourceBytes);

    const traversal = await runCli(
      workspace,
      "source-repair-apply",
      "--input-file", `../${immutableRepair.path}`,
      "--repair-sha256", repairHash,
    );
    assert.equal(traversal.exitCode, 1);
    assert.match(traversal.stderr, /source_repair_out_of_scope/u);
    assert.deepEqual(await readFile(join(workspace, STATE_ROOT, "sources.json")), beforeApplySources);
    assert.deepEqual(await readFile(join(workspace, STATE_ROOT, "facts.json")), beforeApplyFacts);

    const outsideRepairPath = join(outside, "source-repair.json");
    await writeFile(outsideRepairPath, validRepairBytes);
    await rm(repairPath);
    await symlink(outsideRepairPath, repairPath);
    const symlinkedRepair = await runCli(
      workspace,
      "source-repair-apply",
      "--input-file", immutableRepair.path,
      "--repair-sha256", repairHash,
    );
    assert.equal(symlinkedRepair.exitCode, 1);
    assert.match(symlinkedRepair.stderr, /source_repair_out_of_scope/u);
    assert.deepEqual(await readFile(join(workspace, STATE_ROOT, "sources.json")), beforeApplySources);
    assert.deepEqual(await readFile(join(workspace, STATE_ROOT, "facts.json")), beforeApplyFacts);
    await rm(repairPath);
    await writeFile(repairPath, validRepairBytes);

    await writeFile(repairPath, Buffer.concat([validRepairBytes, Buffer.from("\n")]));
    const changedRepair = await runCli(
      workspace,
      "source-repair-apply",
      "--input-file", immutableRepair.path,
      "--repair-sha256", repairHash,
    );
    assert.equal(changedRepair.exitCode, 1);
    assert.match(changedRepair.stderr, /source_repair_changed/u);
    assert.deepEqual(await readFile(join(workspace, STATE_ROOT, "sources.json")), beforeApplySources);
    assert.deepEqual(await readFile(join(workspace, STATE_ROOT, "facts.json")), beforeApplyFacts);
    await writeFile(repairPath, validRepairBytes);
    const applied = await runCli(
      workspace,
      "source-repair-apply",
      "--input-file", immutableRepair.path,
      "--repair-sha256", repairHash,
    );
    assert.equal(applied.exitCode, 0, applied.stderr);
    const appliedResult = JSON.parse(applied.stdout) as { applied: boolean; sourceCount: number; factCount: number };
    assert.equal(appliedResult.applied, true);
    assert.equal(appliedResult.sourceCount, 4);
    assert.equal(appliedResult.factCount, 3);
    assert.deepEqual(await readFile(proposalPath), invalidProposalBytes);
    const sourcesAfterApply = JSON.parse(await readFile(join(workspace, STATE_ROOT, "sources.json"), "utf8")) as {
      sources: Array<{ id: string; status: string; extractionMethod?: string; factIds?: string[] }>;
    };
    const factsAfterApply = JSON.parse(await readFile(join(workspace, STATE_ROOT, "facts.json"), "utf8")) as {
      facts: Array<{ id: string; sourceRefs: Array<{ sourceId: string }> }>;
    };
    const mergedSources = sourcesAfterApply.sources.filter((source) => proposal.sourceIds.includes(source.id));
    assert.equal(mergedSources.every((source) => source.status === "reviewed"), true);
    assert.equal(mergedSources.every((source) => source.extractionMethod === "verified derived text inspection"), true);
    assert.deepEqual(mergedSources.map((source) => source.factIds?.length ?? 0), [1, 1, 1, 0]);
    const factsBeforeApply = JSON.parse(beforeApplyFacts.toString("utf8")) as { facts: unknown[] };
    assert.equal(factsAfterApply.facts.length, factsBeforeApply.facts.length + 3);
    for (const source of mergedSources.slice(0, 3)) {
      const factId = source.factIds?.[0];
      assert.equal(factsAfterApply.facts.some((fact) => fact.id === factId
        && fact.sourceRefs.some((reference) => reference.sourceId === source.id)), true);
    }
    assert.notDeepEqual(await readFile(join(workspace, STATE_ROOT, "sources.json")), beforeApplySources);
    assert.notDeepEqual(await readFile(join(workspace, STATE_ROOT, "facts.json")), beforeApplyFacts);

    const appliedReceiptPath = join(workspace, immutableRepair.appliedReceiptPath);
    const appliedReceiptBytes = await readFile(appliedReceiptPath);
    const tamperedAppliedReceipt = JSON.parse(appliedReceiptBytes.toString("utf8")) as { repairSha256: string };
    tamperedAppliedReceipt.repairSha256 = "0".repeat(64);
    await writeJson(appliedReceiptPath, tamperedAppliedReceipt);
    const ignoredTamperedReceipt = await runHook({
      hookEventName: "PreModelRequest",
      sessionId: "large-pending-source-plan",
      transcriptPath: "",
      cwd: workspace,
    });
    assert.equal(
      (ignoredTamperedReceipt.hookSpecificOutput.modelRequestPatch?.metadata?.pilotdeckConvergence as {
        progressOrdinal: number;
      }).progressOrdinal,
      repairApplyConvergence.progressOrdinal,
    );
    assert.doesNotMatch(ignoredTamperedReceipt.hookSpecificOutput.additionalContext ?? "", /"appliedRepair":/u);
    await writeFile(appliedReceiptPath, appliedReceiptBytes);

    const afterRepairApply = await runHook({
      hookEventName: "PreModelRequest",
      sessionId: "large-pending-source-plan",
      transcriptPath: "",
      cwd: workspace,
    });
    const afterRepairProgress = afterRepairApply.hookSpecificOutput.modelRequestPatch?.metadata
      ?.pilotdeckConvergence as { progressOrdinal: number };
    assert.equal(afterRepairProgress.progressOrdinal, repairApplyConvergence.progressOrdinal + 1);
    assert.match(afterRepairApply.hookSpecificOutput.additionalContext ?? "", /"appliedRepair":/u);
    const replayedAppliedReceipt = await runHook({
      hookEventName: "PreModelRequest",
      sessionId: "large-pending-source-plan",
      transcriptPath: "",
      cwd: workspace,
    });
    assert.equal(
      (replayedAppliedReceipt.hookSpecificOutput.modelRequestPatch?.metadata?.pilotdeckConvergence as {
        progressOrdinal: number;
      }).progressOrdinal,
      afterRepairProgress.progressOrdinal,
    );

    const legal = await import(pathToFileURL(join(PLUGIN_ROOT, "scripts", "lib", "legal-coverage.mjs")).href) as any;
    const nextMerge = await legal.pendingSourceReviewPlan(workspace);
    assert.equal(nextMerge.group, "source-fragment-merge");
    assert.ok(nextMerge.appliedRepair);
    const nextPrepared = await runCli(
      workspace,
      "source-merge-prepare",
      "--checkpoint", nextMerge.readiness.path,
      "--expected-state-hash", nextMerge.proposal.expectedStateHash,
      "--fragment", nextMerge.proposal.fragmentPath,
      "--receipt-sha256", nextMerge.proposal.receiptSha256,
      ...nextMerge.proposal.sourceIds.flatMap((sourceId: string) => ["--source-id", sourceId]),
      "--limit", "4",
      "--max-bytes", "24576",
    );
    assert.equal(nextPrepared.exitCode, 0, nextPrepared.stderr);
    const nextPropose = await legal.pendingSourceReviewPlan(workspace);
    assert.equal(nextPropose.group, "source-fragment-propose");
    const nextProposalBody = {
      ...nextPropose.proposal.template,
      facts: nextPropose.proposal.sourceIds.map((sourceId: string) => {
        const source = nextPropose.preparedSlice.sources.find((item: any) => item.sourceId === sourceId);
        return {
          subject: sourceId,
          predicate: "contains reviewed evidence",
          value: `Reviewed ${sourceId}.`,
          missingTimeReason: "The synthetic source contains no usable date.",
          sourceRefs: [{ sourceId, locator: source.facts[0].locator }],
          evidenceClass: "other",
          verificationStatus: "verified",
          conflictStatus: "none",
          material: false,
          critical: false,
        };
      }),
      noMaterialFacts: [],
    };
    await writeJson(join(workspace, nextPropose.proposal.path), nextProposalBody);
    const nextApplyReady = await runHook({
      hookEventName: "PreModelRequest",
      sessionId: "large-pending-source-plan",
      transcriptPath: "",
      cwd: workspace,
    });
    const nextApplyEnvelope = JSON.parse((nextApplyReady.hookSpecificOutput.additionalContext ?? "")
      .replace(/^<legal_coverage_state>\n/u, "")
      .replace(/\n<\/legal_coverage_state>$/u, "")) as {
      sourceMergeApplyCommand: string;
      workItems: { proposal: { path: string; proposalSha256: string } };
    };
    assert.match(nextApplyEnvelope.sourceMergeApplyCommand, /source-merge-apply/u);
    const beforeApplyReadyConvergence = replayedAppliedReceipt.hookSpecificOutput.modelRequestPatch?.metadata
      ?.pilotdeckConvergence as { progressOrdinal: number; handoffOrdinal: number };
    const applyReadyConvergence = (
      nextApplyReady.hookSpecificOutput.modelRequestPatch?.metadata?.pilotdeckConvergence as {
        progressOrdinal: number;
        handoffOrdinal: number;
      }
    );
    const applyReadyProgress = applyReadyConvergence.progressOrdinal;
    assert.equal(applyReadyProgress, afterRepairProgress.progressOrdinal);
    assert.equal(applyReadyConvergence.handoffOrdinal, beforeApplyReadyConvergence.handoffOrdinal + 1);
    const replayedApplyReady = await runHook({
      hookEventName: "PreModelRequest",
      sessionId: "large-pending-source-plan",
      transcriptPath: "",
      cwd: workspace,
    });
    const replayedApplyReadyConvergence = replayedApplyReady.hookSpecificOutput.modelRequestPatch?.metadata
      ?.pilotdeckConvergence as { progressOrdinal: number; handoffOrdinal: number };
    assert.equal(replayedApplyReadyConvergence.progressOrdinal, applyReadyConvergence.progressOrdinal);
    assert.equal(replayedApplyReadyConvergence.handoffOrdinal, applyReadyConvergence.handoffOrdinal);
    assert.equal(
      JSON.parse((replayedApplyReady.hookSpecificOutput.additionalContext ?? "")
        .replace(/^<legal_coverage_state>\n/u, "")
        .replace(/\n<\/legal_coverage_state>$/u, "")).sourceMergeApplyCommand,
      nextApplyEnvelope.sourceMergeApplyCommand,
    );
    const nextApplied = await runCli(
      workspace,
      "source-merge-apply",
      "--input-file", nextApplyEnvelope.workItems.proposal.path,
      "--proposal-sha256", nextApplyEnvelope.workItems.proposal.proposalSha256,
      "--limit", "4",
      "--max-bytes", "24576",
    );
    assert.equal(nextApplied.exitCode, 0, nextApplied.stderr);
    const nextAppliedResult = JSON.parse(nextApplied.stdout) as { applied: boolean; sourceCount: number };
    assert.equal(nextAppliedResult.applied, true);
    assert.equal(nextAppliedResult.sourceCount, 4);
    const proposalDigest = nextApplyEnvelope.workItems.proposal.path.match(/source-merge-([a-f0-9]{12})\.json$/u)?.[1];
    assert.ok(proposalDigest);
    const mergeAppliedReceiptPath = join(
      workspace,
      STATE_ROOT,
      "fragments",
      `source-merge-applied-${proposalDigest}.json`,
    );
    const mergeAppliedReceiptBytes = await readFile(mergeAppliedReceiptPath);
    const tamperedMergeReceipt = JSON.parse(mergeAppliedReceiptBytes.toString("utf8")) as { proposalSha256: string };
    tamperedMergeReceipt.proposalSha256 = "0".repeat(64);
    await writeJson(mergeAppliedReceiptPath, tamperedMergeReceipt);
    const ignoredMergeReceipt = await runHook({
      hookEventName: "PreModelRequest",
      sessionId: "large-pending-source-plan",
      transcriptPath: "",
      cwd: workspace,
    });
    assert.equal(
      (ignoredMergeReceipt.hookSpecificOutput.modelRequestPatch?.metadata?.pilotdeckConvergence as {
        progressOrdinal: number;
      }).progressOrdinal,
      applyReadyProgress,
    );
    await writeFile(mergeAppliedReceiptPath, mergeAppliedReceiptBytes);
    const mergedSourcesPath = join(workspace, STATE_ROOT, "sources.json");
    const mergedSourcesBytes = await readFile(mergedSourcesPath);
    const invalidStatusSources = JSON.parse(mergedSourcesBytes.toString("utf8")) as {
      sources: Array<{ id: string; status: string }>;
    };
    const invalidStatusSource = invalidStatusSources.sources
      .find((source) => nextPropose.proposal.sourceIds.includes(source.id));
    assert.ok(invalidStatusSource);
    invalidStatusSource.status = "unknown";
    await writeJson(mergedSourcesPath, invalidStatusSources);
    const invalidStatusState = await legal.validateWorkspace({ workspaceRoot: workspace, writeProof: false });
    const invalidStatusBaseline = await runHook({
      hookEventName: "PreModelRequest",
      sessionId: "invalid-status-source-receipt",
      transcriptPath: "",
      cwd: workspace,
    });
    const invalidStatusBaselineProgress = (
      invalidStatusBaseline.hookSpecificOutput.modelRequestPatch?.metadata?.pilotdeckConvergence as {
        progressOrdinal: number;
      }
    ).progressOrdinal;
    assert.doesNotMatch(invalidStatusBaseline.hookSpecificOutput.additionalContext ?? "", /"appliedSource":/u);
    const forgedCurrentReceipt = JSON.parse(mergeAppliedReceiptBytes.toString("utf8")) as { stateHash: string };
    forgedCurrentReceipt.stateHash = invalidStatusState.stateHash;
    await writeJson(mergeAppliedReceiptPath, forgedCurrentReceipt);
    const ignoredInvalidStatusReceipt = await runHook({
      hookEventName: "PreModelRequest",
      sessionId: "invalid-status-source-receipt",
      transcriptPath: "",
      cwd: workspace,
    });
    assert.equal(
      (ignoredInvalidStatusReceipt.hookSpecificOutput.modelRequestPatch?.metadata?.pilotdeckConvergence as {
        progressOrdinal: number;
      }).progressOrdinal,
      invalidStatusBaselineProgress,
    );
    assert.doesNotMatch(ignoredInvalidStatusReceipt.hookSpecificOutput.additionalContext ?? "", /"appliedSource":/u);
    await writeFile(mergedSourcesPath, mergedSourcesBytes);
    await writeFile(mergeAppliedReceiptPath, mergeAppliedReceiptBytes);
    const observedMergeReceipt = await runHook({
      hookEventName: "PreModelRequest",
      sessionId: "large-pending-source-plan",
      transcriptPath: "",
      cwd: workspace,
    });
    const observedMergeProgress = (
      observedMergeReceipt.hookSpecificOutput.modelRequestPatch?.metadata?.pilotdeckConvergence as {
        progressOrdinal: number;
        handoffOrdinal: number;
      }
    );
    assert.equal(observedMergeProgress.progressOrdinal, applyReadyProgress + 1);
    assert.equal(observedMergeProgress.handoffOrdinal, applyReadyConvergence.handoffOrdinal);
    assert.match(observedMergeReceipt.hookSpecificOutput.additionalContext ?? "", /"appliedSource":/u);
    const replayedMergeReceipt = await runHook({
      hookEventName: "PreModelRequest",
      sessionId: "large-pending-source-plan",
      transcriptPath: "",
      cwd: workspace,
    });
    assert.deepEqual(
      (replayedMergeReceipt.hookSpecificOutput.modelRequestPatch?.metadata?.pilotdeckConvergence as {
        progressOrdinal: number;
        handoffOrdinal: number;
      }),
      observedMergeProgress,
    );

    const sourcesBeforeReplay = await readFile(join(workspace, STATE_ROOT, "sources.json"));
    const factsBeforeReplay = await readFile(join(workspace, STATE_ROOT, "facts.json"));
    const replay = await runCli(
      workspace,
      "source-repair-apply",
      "--input-file", immutableRepair.path,
      "--repair-sha256", repairHash,
    );
    assert.equal(replay.exitCode, 1);
    assert.match(replay.stderr, /source_repair_out_of_scope/u);
    assert.deepEqual(await readFile(join(workspace, STATE_ROOT, "sources.json")), sourcesBeforeReplay);
    assert.deepEqual(await readFile(join(workspace, STATE_ROOT, "facts.json")), factsBeforeReplay);
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("legal coverage CLI exposes bundled guidance through stable named references", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pilotdeck-legal-coverage-reference-"));
  try {
    const dataContracts = await runCli(workspace, "reference", "--name", "data-contracts");
    assert.equal(dataContracts.exitCode, 0, dataContracts.stderr);
    assert.match(dataContracts.stdout, /sources\.json/u);
    assert.match(dataContracts.stdout, /facts\.json/u);

    const issueRules = await runCli(workspace, "reference", "--name", "issue-rules");
    assert.equal(issueRules.exitCode, 0, issueRules.stderr);
    assert.match(issueRules.stdout, /timeline/u);

    const invalid = await runCli(workspace, "reference", "--name", "unknown");
    assert.equal(invalid.exitCode, 1);
    assert.match(invalid.stderr, /legal_coverage_reference_invalid/u);
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
      progressOrdinal: 0,
      repairOrdinal: 0,
      repairPreparationOrdinal: 0,
      handoffOrdinal: 0,
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
    assert.equal(
      (unchangedPreModel.hookSpecificOutput.modelRequestPatch?.metadata?.pilotdeckConvergence as { progressOrdinal?: number })?.progressOrdinal,
      0,
    );

    const simulatedPriorDigest = "f".repeat(64);
    await writeJson(join(workspace, STATE_ROOT, "sessions", "legal-session.json"), {
      active: true,
      lastMilestoneDigest: simulatedPriorDigest,
      progressOrdinal: 5,
      progressMilestoneDigests: [simulatedPriorDigest],
      progressObservation: {
        phase: "configuration",
        blockingCode: "jurisdiction_missing",
        remainingCount: 1,
        digest: simulatedPriorDigest,
      },
    });
    const increasedRemaining = await runHook({
      hookEventName: "PreModelRequest",
      sessionId: "legal-session",
      transcriptPath: "",
      cwd: workspace,
    });
    assert.equal(
      (increasedRemaining.hookSpecificOutput.modelRequestPatch?.metadata?.pilotdeckConvergence as { progressOrdinal?: number })?.progressOrdinal,
      5,
    );

    const subagentPreModel = await runHook({
      hookEventName: "PreModelRequest",
      sessionId: `${workspace}::sub::evidence-worker`,
      transcriptPath: "",
      cwd: workspace,
      isSubagent: true,
    });
    assert.equal(subagentPreModel.hookSpecificOutput.additionalContext, undefined);
    assert.equal(subagentPreModel.hookSpecificOutput.modelRequestPatch, undefined);

    const subagentStop = await runHook({
      hookEventName: "Stop",
      sessionId: `${workspace}::sub::evidence-worker`,
      transcriptPath: "",
      cwd: workspace,
      isSubagent: true,
    });
    assert.equal(subagentStop.continue, undefined);
    assert.equal(subagentStop.stopReason, undefined);

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
    assert.match(sourceReview.hookSpecificOutput.additionalContext ?? "", /reference --name data-contracts/u);
    assert.match(sourceReview.hookSpecificOutput.additionalContext ?? "", /instead of guessing a workspace-relative references path/u);
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
    const originalMatrices = structuredClone(matrices);
    matrices.matrices[0] = { id: "equity-capital-timeline", status: "pending", entries: [] };
    matrices.matrices[1] = { id: "holding-platform-special-rights", status: "pending", entries: [] };
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
    const context = preModel.hookSpecificOutput.additionalContext ?? "";
    const envelope = JSON.parse(context
      .replace(/^<legal_coverage_state>\n/u, "")
      .replace(/\n<\/legal_coverage_state>$/u, "")) as {
      mutationContract: {
        writer: string;
        strategy: string;
        canonicalPath: string;
        target: { recordId: string; collectionIndex: number };
        limits: { maxChangedRecords: number };
        interface: { kind: string; phaseApplyCommandAvailable: boolean };
        documentSchema: { requiredRecordIds: string[] };
      };
      workItems: {
        group: string;
        limits: { maxRecords: number; maxSerializedBytes: number };
        batchLimits: { maxRecords: number; maxSerializedBytes: number };
        evidencePage: {
          total: number;
          returned: number;
          hasMore: boolean;
          serializedBytes: number;
          items: Array<{ factId: string }>;
        };
        selection: { path: string; template: Record<string, unknown> };
      };
      matrixSelectionApplyCommand?: string;
      nextAction: string;
    };
    assert.equal(envelope.mutationContract.writer, "main-agent-only");
    assert.equal(envelope.mutationContract.strategy, "state-bound-proposal-apply");
    assert.equal(envelope.mutationContract.canonicalPath, ".pilotdeck/work/legal-coverage/matrices.json");
    assert.deepEqual(envelope.mutationContract.target, {
      recordId: "equity-capital-timeline",
      collectionIndex: 0,
      errorCode: "matrix_pending",
      validatorPath: "matrices.json#matrices[0]",
    });
    assert.equal(envelope.mutationContract.limits.maxChangedRecords, 1);
    assert.equal(envelope.mutationContract.interface.kind, "state-bound-proposal");
    assert.equal(envelope.mutationContract.interface.phaseApplyCommandAvailable, false);
    assert.deepEqual(envelope.mutationContract.documentSchema.requiredRecordIds, [
      "equity-capital-timeline",
      "holding-platform-special-rights",
      "governance-personnel-timeline",
      "contract-key-terms",
      "debt-collateral-liquidity",
      "employment-ip-timeline",
      "legal-authority",
    ]);
    assert.equal(envelope.workItems.group, "matrix-pending-selection");
    assert.deepEqual(envelope.workItems.limits, { maxRecords: 1, maxSerializedBytes: 24576 });
    assert.deepEqual(envelope.workItems.batchLimits, { maxRecords: 48, maxSerializedBytes: 8192 });
    assert.equal(envelope.workItems.evidencePage.total, 1);
    assert.equal(envelope.workItems.evidencePage.returned, 1);
    assert.equal(envelope.workItems.evidencePage.hasMore, false);
    assert.equal(envelope.workItems.evidencePage.serializedBytes <= 8192, true);
    assert.deepEqual(envelope.workItems.evidencePage.items.map((item) => item.factId), ["F-001"]);
    assert.equal(envelope.matrixSelectionApplyCommand, undefined);
    assert.match(envelope.nextAction, /complete current fact-index page/u);
    assert.match(envelope.nextAction, /Do not read matrices\.json, the full facts\.json/u);

    const convergence = preModel.hookSpecificOutput.modelRequestPatch?.metadata?.pilotdeckConvergence as {
      stateHash: string;
      nextBatch: { group: string; returned?: number; hasMore?: boolean };
      writeBudget: { maxRecords: number; maxSerializedBytes: number };
    };
    assert.deepEqual(convergence.writeBudget, { maxRecords: 1, maxSerializedBytes: 24576 });

    const selection = structuredClone(envelope.workItems.selection.template) as {
      selectedFactIds: string[];
      decision: string;
      reason: string;
    };
    selection.selectedFactIds = ["F-001"];
    selection.decision = "finalize";
    selection.reason = "The registered-capital fact belongs in the equity and capital timeline.";
    await mkdir(join(workspace, STATE_ROOT, "matrix-transactions"), { recursive: true });
    await writeJson(join(workspace, envelope.workItems.selection.path), selection);
    const selectionApplyHook = await runHook({
      hookEventName: "PreModelRequest",
      sessionId: "grouped-session",
      transcriptPath: "",
      cwd: workspace,
    });
    const selectionApplyEnvelope = legalEnvelope(selectionApplyHook) as {
      workItems: { group: string; evidencePage: { items?: unknown[] }; selection: { validated: boolean } };
      matrixSelectionApplyCommand: string;
      nextAction: string;
    };
    assert.equal(selectionApplyEnvelope.workItems.group, "matrix-pending-selection-apply");
    assert.equal(selectionApplyEnvelope.workItems.selection.validated, true);
    assert.equal(selectionApplyEnvelope.workItems.evidencePage.items, undefined);
    assert.match(selectionApplyEnvelope.matrixSelectionApplyCommand, /matrix-selection-apply/u);
    assert.match(selectionApplyEnvelope.nextAction, /selection is valid and state-bound/u);
    const selectionApply = await runCli(
      workspace,
      "matrix-selection-apply",
      "--input-file", envelope.workItems.selection.path,
    );
    assert.equal(selectionApply.exitCode, 0, selectionApply.stderr);
    assert.equal(JSON.parse(selectionApply.stdout).nextGroup, "matrix-pending-propose");

    const proposalHook = await runHook({
      hookEventName: "PreModelRequest",
      sessionId: "grouped-session",
      transcriptPath: "",
      cwd: workspace,
    });
    const proposalContext = proposalHook.hookSpecificOutput.additionalContext ?? "";
    const proposalEnvelope = JSON.parse(proposalContext
      .replace(/^<legal_coverage_state>\n/u, "")
      .replace(/\n<\/legal_coverage_state>$/u, "")) as {
      workItems: {
        group: string;
        preparedSlice: { returned: number; serializedBytes: number; items: Array<{ factId: string }> };
        proposal: { path: string; template: Record<string, unknown> };
      };
      nextAction: string;
    };
    assert.equal(proposalEnvelope.workItems.group, "matrix-pending-propose");
    assert.equal(proposalEnvelope.workItems.preparedSlice.returned, 1);
    assert.equal(proposalEnvelope.workItems.preparedSlice.serializedBytes <= 8192, true);
    assert.deepEqual(proposalEnvelope.workItems.preparedSlice.items.map((item) => item.factId), ["F-001"]);
    assert.match(proposalEnvelope.nextAction, /selected matrix evidence is rehydrated/u);
    assert.match(proposalEnvelope.nextAction, /do not read facts\.json, matrices\.json/u);

    const proposal = structuredClone(proposalEnvelope.workItems.proposal.template) as {
      matrix: { entries: Array<{ id: string; summary: string; factIds: string[] }> };
    };
    proposal.matrix.entries[0]!.id = "M-NEW-001";
    proposal.matrix.entries[0]!.summary = "The verified registered-capital fact is recorded in the equity and capital timeline.";
    proposal.matrix.entries[0]!.factIds = ["F-UNSELECTED"];
    await writeJson(join(workspace, proposalEnvelope.workItems.proposal.path), proposal);
    const rejectedProposalHook = await runHook({
      hookEventName: "PreModelRequest",
      sessionId: "grouped-session",
      transcriptPath: "",
      cwd: workspace,
    });
    const rejectedProposalEnvelope = legalEnvelope(rejectedProposalHook) as {
      workItems: { group: string; proposal: { validationError: { code: string } } };
    };
    assert.equal(rejectedProposalEnvelope.workItems.group, "matrix-pending-propose");
    assert.equal(rejectedProposalEnvelope.workItems.proposal.validationError.code, "matrix_proposal_entry_invalid");

    proposal.matrix.entries[0]!.factIds = ["F-001"];
    await writeJson(join(workspace, proposalEnvelope.workItems.proposal.path), proposal);

    const applyHook = await runHook({
      hookEventName: "PreModelRequest",
      sessionId: "grouped-session",
      transcriptPath: "",
      cwd: workspace,
    });
    const applyContext = applyHook.hookSpecificOutput.additionalContext ?? "";
    const applyEnvelope = JSON.parse(applyContext
      .replace(/^<legal_coverage_state>\n/u, "")
      .replace(/\n<\/legal_coverage_state>$/u, "")) as {
      mutationContract: { interface: { phaseApplyCommandAvailable: boolean } };
      workItems: { group: string; proposal: { path: string; proposalSha256: string } };
      matrixProposalApplyCommand: string;
    };
    assert.equal(applyEnvelope.workItems.group, "matrix-pending-apply");
    assert.equal(applyEnvelope.mutationContract.interface.phaseApplyCommandAvailable, true);
    assert.match(applyEnvelope.matrixProposalApplyCommand, /matrix-proposal-apply/u);
    const matrixApply = await runCli(
      workspace,
      "matrix-proposal-apply",
      "--input-file", applyEnvelope.workItems.proposal.path,
      "--proposal-sha256", applyEnvelope.workItems.proposal.proposalSha256,
    );
    assert.equal(matrixApply.exitCode, 0, matrixApply.stderr);

    const validation = await runCli(workspace, "validate", "--write-proof");
    assert.equal(validation.exitCode, 2);
    const validationResult = JSON.parse(validation.stdout) as {
      errors: Array<{ code: string; recordId?: string; collectionIndex?: number }>;
    };
    const pending = validationResult.errors.filter((error) => error.code === "matrix_pending");
    assert.deepEqual(pending.map(({ recordId, collectionIndex }) => ({ recordId, collectionIndex })), [
      { recordId: "holding-platform-special-rights", collectionIndex: 1 },
    ]);

    const appliedMatrices = JSON.parse(await readFile(matricesPath, "utf8")) as { matrices: Array<Record<string, unknown>> };
    assert.equal(appliedMatrices.matrices[0]?.status, "complete");
    assert.deepEqual(appliedMatrices.matrices[1], matrices.matrices[1]);
    const advanced = await runHook({
      hookEventName: "PreModelRequest",
      sessionId: "grouped-session",
      transcriptPath: "",
      cwd: workspace,
    });
    const advancedContext = advanced.hookSpecificOutput.additionalContext ?? "";
    const advancedEnvelope = JSON.parse(advancedContext
      .replace(/^<legal_coverage_state>\n/u, "")
      .replace(/\n<\/legal_coverage_state>$/u, "")) as {
      mutationContract: { target: { recordId: string; collectionIndex: number } };
    };
    assert.deepEqual(advancedEnvelope.mutationContract.target, {
      recordId: "holding-platform-special-rights",
      collectionIndex: 1,
      errorCode: "matrix_pending",
      validatorPath: "matrices.json#matrices[1]",
    });
    assert.notEqual(
      (advanced.hookSpecificOutput.modelRequestPatch?.metadata?.pilotdeckConvergence as { stateHash?: string })?.stateHash,
      convergence.stateHash,
    );
    assert.deepEqual(originalMatrices.matrices[0]?.status, "complete");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("legal coverage pending-matrix selection is bounded across pages and invalid revisions cannot manufacture progress", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pilotdeck-legal-coverage-matrix-pages-"));
  try {
    await writeCompleteFixture(workspace);
    const root = join(workspace, STATE_ROOT);
    const factsPath = join(root, "facts.json");
    const sourcesPath = join(root, "sources.json");
    const matricesPath = join(root, "matrices.json");
    const facts = JSON.parse(await readFile(factsPath, "utf8")) as { facts: Array<Record<string, unknown>> };
    const sources = JSON.parse(await readFile(sourcesPath, "utf8")) as { sources: Array<{ factIds: string[] }> };
    for (let index = 2; index <= 70; index += 1) {
      const factId = `F-${String(index).padStart(3, "0")}`;
      facts.facts.push({
        id: factId,
        subject: `Synthetic subject ${index}`,
        predicate: `bounded matrix selection predicate ${index}`,
        value: `Synthetic value ${index}`,
        missingTimeReason: "The synthetic source does not state a date.",
        sourceRefs: [{ sourceId: "S-001", locator: `line ${index}` }],
        evidenceClass: "official-record",
        verificationStatus: "verified",
        conflictStatus: "none",
        material: false,
        critical: false,
      });
      sources.sources[0]!.factIds.push(factId);
    }
    const matrices = JSON.parse(await readFile(matricesPath, "utf8")) as { matrices: Array<Record<string, unknown>> };
    matrices.matrices[0] = { id: "equity-capital-timeline", status: "pending", entries: [] };
    await writeJson(factsPath, facts);
    await writeJson(sourcesPath, sources);
    await writeJson(matricesPath, matrices);
    await mkdir(join(root, "matrix-transactions"), { recursive: true });

    const firstHook = await runHook({ hookEventName: "PreModelRequest", sessionId: "matrix-pages", transcriptPath: "", cwd: workspace });
    const firstEnvelope = legalEnvelope(firstHook) as {
      workItems: {
        group: string;
        evidencePage: { offset: number; total: number; returned: number; hasMore: boolean; serializedBytes: number; items: Array<{ factId: string }> };
        selection: { path: string; template: Record<string, unknown>; validationError?: { code: string } };
      };
    };
    assert.equal(firstEnvelope.workItems.group, "matrix-pending-selection");
    assert.equal(firstEnvelope.workItems.evidencePage.offset, 0);
    assert.equal(firstEnvelope.workItems.evidencePage.total, 70);
    assert.equal(firstEnvelope.workItems.evidencePage.returned <= 48, true);
    assert.equal(firstEnvelope.workItems.evidencePage.serializedBytes <= 8192, true);
    assert.equal(firstEnvelope.workItems.evidencePage.hasMore, true);

    const invalid = structuredClone(firstEnvelope.workItems.selection.template) as {
      selectedFactIds: string[];
      decision: string;
      reason: string;
    };
    invalid.selectedFactIds = ["F-OUTSIDE-PAGE"];
    invalid.decision = "continue";
    invalid.reason = "Attempted selection outside the injected page.";
    await writeJson(join(workspace, firstEnvelope.workItems.selection.path), invalid);
    const invalidApply = await runCli(workspace, "matrix-selection-apply", "--input-file", firstEnvelope.workItems.selection.path);
    assert.equal(invalidApply.exitCode, 1);
    assert.equal(JSON.parse(invalidApply.stderr).error.code, "matrix_selection_fact_out_of_scope");

    const invalidHookOne = await runHook({ hookEventName: "PreModelRequest", sessionId: "matrix-pages", transcriptPath: "", cwd: workspace });
    const invalidEnvelopeOne = legalEnvelope(invalidHookOne) as {
      workItems: { selection: { validationError: { code: string } } };
    };
    assert.equal(invalidEnvelopeOne.workItems.selection.validationError.code, "matrix_selection_fact_out_of_scope");
    const invalidConvergenceOne = invalidHookOne.hookSpecificOutput.modelRequestPatch?.metadata?.pilotdeckConvergence as {
      stateHash: string;
      progressOrdinal: number;
      repairOrdinal: number;
      handoffOrdinal: number;
    };
    const invalidHashOne = invalidConvergenceOne.stateHash;

    invalid.selectedFactIds = ["F-ANOTHER-OUTSIDE-PAGE"];
    await writeJson(join(workspace, firstEnvelope.workItems.selection.path), invalid);
    const invalidHookTwo = await runHook({ hookEventName: "PreModelRequest", sessionId: "matrix-pages", transcriptPath: "", cwd: workspace });
    const invalidConvergenceTwo = invalidHookTwo.hookSpecificOutput.modelRequestPatch?.metadata?.pilotdeckConvergence as {
      stateHash: string;
      progressOrdinal: number;
      repairOrdinal: number;
      handoffOrdinal: number;
    };
    const invalidHashTwo = invalidConvergenceTwo.stateHash;
    assert.equal(invalidHashTwo, invalidHashOne);
    assert.equal(invalidConvergenceTwo.progressOrdinal, invalidConvergenceOne.progressOrdinal);
    assert.equal(invalidConvergenceTwo.repairOrdinal, invalidConvergenceOne.repairOrdinal);
    assert.equal(
      invalidConvergenceTwo.handoffOrdinal,
      invalidConvergenceOne.handoffOrdinal,
    );

    const valid = structuredClone(firstEnvelope.workItems.selection.template) as {
      selectedFactIds: string[];
      decision: string;
      reason: string;
    };
    valid.selectedFactIds = [];
    valid.decision = "continue";
    valid.reason = "No fact on this page is needed for the target matrix; inspect the next bounded page.";
    await writeJson(join(workspace, firstEnvelope.workItems.selection.path), valid);
    const validSelectionHook = await runHook({
      hookEventName: "PreModelRequest",
      sessionId: "matrix-pages",
      transcriptPath: "",
      cwd: workspace,
    });
    assert.equal(
      (legalEnvelope(validSelectionHook) as { workItems: { group: string } }).workItems.group,
      "matrix-pending-selection-apply",
    );
    const validSelectionConvergence = validSelectionHook.hookSpecificOutput.modelRequestPatch?.metadata?.pilotdeckConvergence as {
      progressOrdinal: number;
      handoffOrdinal: number;
    };
    assert.equal(validSelectionConvergence.progressOrdinal, invalidConvergenceOne.progressOrdinal);
    assert.equal(validSelectionConvergence.handoffOrdinal, invalidConvergenceOne.handoffOrdinal + 1);
    const replayedValidSelectionHook = await runHook({
      hookEventName: "PreModelRequest",
      sessionId: "matrix-pages",
      transcriptPath: "",
      cwd: workspace,
    });
    assert.equal(
      (replayedValidSelectionHook.hookSpecificOutput.modelRequestPatch?.metadata?.pilotdeckConvergence as { handoffOrdinal: number }).handoffOrdinal,
      validSelectionConvergence.handoffOrdinal,
    );
    const validApply = await runCli(workspace, "matrix-selection-apply", "--input-file", firstEnvelope.workItems.selection.path);
    assert.equal(validApply.exitCode, 0, validApply.stderr);

    const secondHook = await runHook({ hookEventName: "PreModelRequest", sessionId: "matrix-pages", transcriptPath: "", cwd: workspace });
    const secondEnvelope = legalEnvelope(secondHook) as {
      workItems: {
        group: string;
        accumulatedSelectedFactIds: string[];
        evidencePage: { offset: number; serializedBytes: number; items: Array<{ factId: string }> };
        selection: { path: string; template: Record<string, unknown> };
      };
    };
    assert.equal(secondEnvelope.workItems.group, "matrix-pending-selection");
    assert.equal(secondEnvelope.workItems.evidencePage.offset, firstEnvelope.workItems.evidencePage.returned);
    assert.equal(secondEnvelope.workItems.evidencePage.serializedBytes <= 8192, true);
    assert.deepEqual(secondEnvelope.workItems.accumulatedSelectedFactIds, []);
    assert.notEqual(
      (secondHook.hookSpecificOutput.modelRequestPatch?.metadata?.pilotdeckConvergence as { stateHash: string }).stateHash,
      invalidHashOne,
    );
    const secondProgressOrdinal = (
      secondHook.hookSpecificOutput.modelRequestPatch?.metadata?.pilotdeckConvergence as { progressOrdinal: number }
    ).progressOrdinal;
    assert.equal(secondProgressOrdinal, invalidConvergenceOne.progressOrdinal);
    const secondHandoffOrdinal = (
      secondHook.hookSpecificOutput.modelRequestPatch?.metadata?.pilotdeckConvergence as { handoffOrdinal: number }
    ).handoffOrdinal;
    assert.equal(secondHandoffOrdinal, validSelectionConvergence.handoffOrdinal + 1);
    const replayedSecondPageHook = await runHook({
      hookEventName: "PreModelRequest",
      sessionId: "matrix-pages",
      transcriptPath: "",
      cwd: workspace,
    });
    assert.equal(
      (replayedSecondPageHook.hookSpecificOutput.modelRequestPatch?.metadata?.pilotdeckConvergence as { handoffOrdinal: number }).handoffOrdinal,
      secondHandoffOrdinal,
    );

    await runHook({
      hookEventName: "UserPromptSubmit",
      sessionId: "matrix-pages",
      transcriptPath: "",
      cwd: workspace,
      prompt: "Continue the configured legal review.",
      internal: false,
    });
    const afterUserPrompt = await runHook({
      hookEventName: "PreModelRequest",
      sessionId: "matrix-pages",
      transcriptPath: "",
      cwd: workspace,
    });
    assert.equal(
      (afterUserPrompt.hookSpecificOutput.modelRequestPatch?.metadata?.pilotdeckConvergence as { progressOrdinal: number }).progressOrdinal,
      secondProgressOrdinal,
    );
    assert.equal(
      (afterUserPrompt.hookSpecificOutput.modelRequestPatch?.metadata?.pilotdeckConvergence as { repairOrdinal: number }).repairOrdinal,
      invalidConvergenceOne.repairOrdinal,
    );
    assert.equal(
      (afterUserPrompt.hookSpecificOutput.modelRequestPatch?.metadata?.pilotdeckConvergence as { handoffOrdinal: number }).handoffOrdinal,
      secondHandoffOrdinal,
    );

    const selectedId = secondEnvelope.workItems.evidencePage.items[0]!.factId;
    const secondSelection = structuredClone(secondEnvelope.workItems.selection.template) as {
      selectedFactIds: string[];
      decision: string;
      reason: string;
    };
    secondSelection.selectedFactIds = [selectedId];
    secondSelection.decision = "finalize";
    secondSelection.reason = "This fact is sufficient to ground the current synthetic matrix.";
    await writeJson(join(workspace, secondEnvelope.workItems.selection.path), secondSelection);
    const finalSelectionHook = await runHook({
      hookEventName: "PreModelRequest",
      sessionId: "matrix-pages",
      transcriptPath: "",
      cwd: workspace,
    });
    assert.equal((legalEnvelope(finalSelectionHook) as { workItems: { group: string } }).workItems.group, "matrix-pending-selection-apply");
    const finalSelectionOrdinal = (
      finalSelectionHook.hookSpecificOutput.modelRequestPatch?.metadata?.pilotdeckConvergence as { progressOrdinal: number }
    ).progressOrdinal;
    assert.equal(finalSelectionOrdinal, secondProgressOrdinal + 1);
    assert.equal(
      (finalSelectionHook.hookSpecificOutput.modelRequestPatch?.metadata?.pilotdeckConvergence as { handoffOrdinal: number }).handoffOrdinal,
      secondHandoffOrdinal,
    );
    const replayedFinalSelectionHook = await runHook({
      hookEventName: "PreModelRequest",
      sessionId: "matrix-pages",
      transcriptPath: "",
      cwd: workspace,
    });
    assert.equal(
      (replayedFinalSelectionHook.hookSpecificOutput.modelRequestPatch?.metadata?.pilotdeckConvergence as { progressOrdinal: number }).progressOrdinal,
      finalSelectionOrdinal,
    );
    const secondApply = await runCli(workspace, "matrix-selection-apply", "--input-file", secondEnvelope.workItems.selection.path);
    assert.equal(secondApply.exitCode, 0, secondApply.stderr);

    const proposalHook = await runHook({ hookEventName: "PreModelRequest", sessionId: "matrix-pages", transcriptPath: "", cwd: workspace });
    const proposalEnvelope = legalEnvelope(proposalHook) as {
      workItems: {
        group: string;
        selectedFactIds: string[];
        preparedSlice: { returned: number; serializedBytes: number; items: Array<{ factId: string }> };
        proposal: { path: string; template: Record<string, unknown> };
      };
    };
    assert.equal(proposalEnvelope.workItems.group, "matrix-pending-propose");
    assert.deepEqual(proposalEnvelope.workItems.selectedFactIds, [selectedId]);
    assert.deepEqual(proposalEnvelope.workItems.preparedSlice.items.map((item) => item.factId), [selectedId]);
    assert.equal(proposalEnvelope.workItems.preparedSlice.returned, 1);
    assert.equal(proposalEnvelope.workItems.preparedSlice.serializedBytes <= 8192, true);
    assert.equal(
      (proposalHook.hookSpecificOutput.modelRequestPatch?.metadata?.pilotdeckConvergence as { progressOrdinal: number }).progressOrdinal,
      finalSelectionOrdinal,
    );

    const matrixProposal = structuredClone(proposalEnvelope.workItems.proposal.template) as {
      matrix: { entries: Array<{ id: string; summary: string; factIds: string[] }> };
    };
    matrixProposal.matrix.entries[0]!.id = "M-PAGED-001";
    matrixProposal.matrix.entries[0]!.summary = "The selected synthetic fact grounds the pending matrix.";
    await writeJson(join(workspace, proposalEnvelope.workItems.proposal.path), matrixProposal);
    const matrixApplyHook = await runHook({
      hookEventName: "PreModelRequest",
      sessionId: "matrix-pages",
      transcriptPath: "",
      cwd: workspace,
    });
    assert.equal((legalEnvelope(matrixApplyHook) as { workItems: { group: string } }).workItems.group, "matrix-pending-apply");
    const matrixApplyOrdinal = (
      matrixApplyHook.hookSpecificOutput.modelRequestPatch?.metadata?.pilotdeckConvergence as { progressOrdinal: number }
    ).progressOrdinal;
    assert.equal(matrixApplyOrdinal, finalSelectionOrdinal + 1);
    const replayedMatrixApplyHook = await runHook({
      hookEventName: "PreModelRequest",
      sessionId: "matrix-pages",
      transcriptPath: "",
      cwd: workspace,
    });
    assert.equal(
      (replayedMatrixApplyHook.hookSpecificOutput.modelRequestPatch?.metadata?.pilotdeckConvergence as { progressOrdinal: number }).progressOrdinal,
      matrixApplyOrdinal,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("legal coverage progress ordinal advances once for a new legal phase", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pilotdeck-legal-coverage-phase-progress-"));
  try {
    await writeCompleteFixture(workspace);
    const matricesPath = join(workspace, STATE_ROOT, "matrices.json");
    const originalMatrices = JSON.parse(await readFile(matricesPath, "utf8")) as { matrices: Array<Record<string, unknown>> };
    const pendingMatrices = structuredClone(originalMatrices);
    pendingMatrices.matrices[0] = { id: "equity-capital-timeline", status: "pending", entries: [] };
    await writeJson(matricesPath, pendingMatrices);
    await mkdir(join(workspace, STATE_ROOT, "matrix-transactions"), { recursive: true });

    const initial = await runHook({ hookEventName: "PreModelRequest", sessionId: "phase-progress", transcriptPath: "", cwd: workspace });
    const initialConvergence = initial.hookSpecificOutput.modelRequestPatch?.metadata?.pilotdeckConvergence as {
      phase: string;
      progressOrdinal: number;
    };
    assert.equal(initialConvergence.phase, "matrices");

    await writeJson(matricesPath, originalMatrices);
    const advanced = await runHook({ hookEventName: "PreModelRequest", sessionId: "phase-progress", transcriptPath: "", cwd: workspace });
    const advancedConvergence = advanced.hookSpecificOutput.modelRequestPatch?.metadata?.pilotdeckConvergence as {
      phase: string;
      progressOrdinal: number;
    };
    assert.equal(advancedConvergence.phase, "complete");
    assert.equal(advancedConvergence.progressOrdinal, initialConvergence.progressOrdinal + 1);

    const replayed = await runHook({ hookEventName: "PreModelRequest", sessionId: "phase-progress", transcriptPath: "", cwd: workspace });
    assert.equal(
      (replayed.hookSpecificOutput.modelRequestPatch?.metadata?.pilotdeckConvergence as { progressOrdinal: number }).progressOrdinal,
      advancedConvergence.progressOrdinal,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("legal coverage permits not-applicable only after exhaustive selection and rejects stale or changed matrix proposals", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pilotdeck-legal-coverage-matrix-na-"));
  try {
    await writeCompleteFixture(workspace);
    const root = join(workspace, STATE_ROOT);
    const matricesPath = join(root, "matrices.json");
    const configPath = join(root, "config.json");
    const matrices = JSON.parse(await readFile(matricesPath, "utf8")) as { matrices: Array<Record<string, unknown>> };
    matrices.matrices[0] = { id: "equity-capital-timeline", status: "pending", entries: [] };
    await writeJson(matricesPath, matrices);
    await mkdir(join(root, "matrix-transactions"), { recursive: true });

    const selectionHook = await runHook({ hookEventName: "PreModelRequest", sessionId: "matrix-na", transcriptPath: "", cwd: workspace });
    const selectionEnvelope = legalEnvelope(selectionHook) as {
      workItems: {
        evidencePage: { hasMore: boolean };
        selection: { path: string; template: Record<string, unknown> };
      };
    };
    assert.equal(selectionEnvelope.workItems.evidencePage.hasMore, false);
    const selection = structuredClone(selectionEnvelope.workItems.selection.template) as {
      selectedFactIds: string[];
      decision: string;
      reason: string;
    };
    selection.selectedFactIds = [];
    selection.decision = "finalize";
    selection.reason = "The only reviewed synthetic fact does not concern the target equity timeline.";
    await writeJson(join(workspace, selectionEnvelope.workItems.selection.path), selection);
    const selectionApply = await runCli(workspace, "matrix-selection-apply", "--input-file", selectionEnvelope.workItems.selection.path);
    assert.equal(selectionApply.exitCode, 0, selectionApply.stderr);

    const proposalHook = await runHook({ hookEventName: "PreModelRequest", sessionId: "matrix-na", transcriptPath: "", cwd: workspace });
    const proposalEnvelope = legalEnvelope(proposalHook) as {
      workItems: { group: string; selectedFactIds: string[]; proposal: { path: string; template: Record<string, unknown> } };
    };
    assert.equal(proposalEnvelope.workItems.group, "matrix-pending-propose");
    assert.deepEqual(proposalEnvelope.workItems.selectedFactIds, []);
    const proposal = structuredClone(proposalEnvelope.workItems.proposal.template) as {
      matrix: { status: string; entries: unknown[]; notApplicableReason: string };
    };
    assert.equal(proposal.matrix.status, "not-applicable");
    assert.deepEqual(proposal.matrix.entries, []);
    assert.equal(proposal.matrix.notApplicableReason, selection.reason);
    await writeJson(join(workspace, proposalEnvelope.workItems.proposal.path), proposal);

    const applyHook = await runHook({ hookEventName: "PreModelRequest", sessionId: "matrix-na", transcriptPath: "", cwd: workspace });
    const applyEnvelope = legalEnvelope(applyHook) as {
      workItems: { group: string; proposal: { path: string; proposalSha256: string } };
    };
    assert.equal(applyEnvelope.workItems.group, "matrix-pending-apply");

    const originalConfig = JSON.parse(await readFile(configPath, "utf8")) as Record<string, unknown>;
    await writeJson(configPath, { ...originalConfig, basisDate: "Changed state for stale proposal test" });
    const staleApply = await runCli(
      workspace,
      "matrix-proposal-apply",
      "--input-file", applyEnvelope.workItems.proposal.path,
      "--proposal-sha256", applyEnvelope.workItems.proposal.proposalSha256,
    );
    assert.equal(staleApply.exitCode, 1);
    assert.equal(JSON.parse(staleApply.stderr).error.code, "matrix_proposal_out_of_scope");
    assert.equal((JSON.parse(await readFile(matricesPath, "utf8")) as { matrices: Array<{ status: string }> }).matrices[0]?.status, "pending");
    await writeJson(configPath, originalConfig);

    proposal.matrix.notApplicableReason = "A changed but still specific not-applicable reason.";
    await writeJson(join(workspace, proposalEnvelope.workItems.proposal.path), proposal);
    const changedApply = await runCli(
      workspace,
      "matrix-proposal-apply",
      "--input-file", applyEnvelope.workItems.proposal.path,
      "--proposal-sha256", applyEnvelope.workItems.proposal.proposalSha256,
    );
    assert.equal(changedApply.exitCode, 1);
    assert.equal(JSON.parse(changedApply.stderr).error.code, "matrix_proposal_changed");

    const refreshedHook = await runHook({ hookEventName: "PreModelRequest", sessionId: "matrix-na", transcriptPath: "", cwd: workspace });
    const refreshedEnvelope = legalEnvelope(refreshedHook) as {
      workItems: { group: string; proposal: { path: string; proposalSha256: string } };
    };
    assert.equal(refreshedEnvelope.workItems.group, "matrix-pending-apply");
    assert.notEqual(refreshedEnvelope.workItems.proposal.proposalSha256, applyEnvelope.workItems.proposal.proposalSha256);
    const applied = await runCli(
      workspace,
      "matrix-proposal-apply",
      "--input-file", refreshedEnvelope.workItems.proposal.path,
      "--proposal-sha256", refreshedEnvelope.workItems.proposal.proposalSha256,
    );
    assert.equal(applied.exitCode, 0, applied.stderr);
    const finalMatrices = JSON.parse(await readFile(matricesPath, "utf8")) as { matrices: Array<{ status: string; notApplicableReason?: string }> };
    assert.equal(finalMatrices.matrices[0]?.status, "not-applicable");
    assert.equal(finalMatrices.matrices[0]?.notApplicableReason, proposal.matrix.notApplicableReason);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("legal coverage rejects oversized matrix evidence before making a selection receipt immutable", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pilotdeck-legal-coverage-matrix-oversized-"));
  try {
    await writeCompleteFixture(workspace);
    const root = join(workspace, STATE_ROOT);
    const factsPath = join(root, "facts.json");
    const matricesPath = join(root, "matrices.json");
    const facts = JSON.parse(await readFile(factsPath, "utf8")) as { facts: Array<Record<string, unknown>> };
    facts.facts[0]!.value = "x".repeat(9000);
    const matrices = JSON.parse(await readFile(matricesPath, "utf8")) as { matrices: Array<Record<string, unknown>> };
    matrices.matrices[0] = { id: "equity-capital-timeline", status: "pending", entries: [] };
    await writeJson(factsPath, facts);
    await writeJson(matricesPath, matrices);
    await mkdir(join(root, "matrix-transactions"), { recursive: true });

    const hook = await runHook({ hookEventName: "PreModelRequest", sessionId: "matrix-oversized", transcriptPath: "", cwd: workspace });
    const envelope = legalEnvelope(hook) as {
      workItems: {
        selection: { path: string; receiptPath: string; template: Record<string, unknown> };
      };
    };
    const selection = structuredClone(envelope.workItems.selection.template) as {
      selectedFactIds: string[];
      decision: string;
      reason: string;
    };
    selection.selectedFactIds = ["F-001"];
    selection.decision = "finalize";
    selection.reason = "Select the only canonical fact for bounded-slice validation.";
    await writeJson(join(workspace, envelope.workItems.selection.path), selection);
    const apply = await runCli(workspace, "matrix-selection-apply", "--input-file", envelope.workItems.selection.path);
    assert.equal(apply.exitCode, 1);
    assert.equal(JSON.parse(apply.stderr).error.code, "matrix_selection_prepared_slice_byte_limit");
    await assert.rejects(stat(join(workspace, envelope.workItems.selection.receiptPath)), { code: "ENOENT" });
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("legal coverage fails closed when one matrix index item exceeds the bounded page", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pilotdeck-legal-coverage-matrix-index-oversized-"));
  try {
    await writeCompleteFixture(workspace);
    const root = join(workspace, STATE_ROOT);
    const factsPath = join(root, "facts.json");
    const matricesPath = join(root, "matrices.json");
    const facts = JSON.parse(await readFile(factsPath, "utf8")) as { facts: Array<Record<string, unknown>> };
    facts.facts[0]!.subject = "x".repeat(9000);
    const matrices = JSON.parse(await readFile(matricesPath, "utf8")) as { matrices: Array<Record<string, unknown>> };
    matrices.matrices[0] = { id: "equity-capital-timeline", status: "pending", entries: [] };
    await writeJson(factsPath, facts);
    await writeJson(matricesPath, matrices);
    await mkdir(join(root, "matrix-transactions"), { recursive: true });

    const hook = await runHook({ hookEventName: "PreModelRequest", sessionId: "matrix-index-oversized", transcriptPath: "", cwd: workspace });
    const envelope = legalEnvelope(hook) as {
      workItems: {
        evidencePage: { serializedBytes: number; items: Array<{ factId: string; oversizedRecord?: boolean; recordPointer?: string }> };
        selection: { path: string; template: Record<string, unknown> };
      };
    };
    assert.equal(envelope.workItems.evidencePage.serializedBytes <= 8192, true);
    assert.equal(envelope.workItems.evidencePage.items[0]?.oversizedRecord, true);
    assert.equal(envelope.workItems.evidencePage.items[0]?.recordPointer, "state://legal-coverage/facts/F-001");
    const selection = structuredClone(envelope.workItems.selection.template) as { decision: string; reason: string };
    selection.decision = "finalize";
    selection.reason = "Attempting to finalize must fail rather than skip oversized evidence.";
    await writeJson(join(workspace, envelope.workItems.selection.path), selection);
    const apply = await runCli(workspace, "matrix-selection-apply", "--input-file", envelope.workItems.selection.path);
    assert.equal(apply.exitCode, 1);
    assert.equal(JSON.parse(apply.stderr).error.code, "matrix_selection_oversized_index_item");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("legal coverage injects a bounded deterministic matrix relation-closure batch", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pilotdeck-legal-coverage-matrix-closure-"));
  try {
    await writeCompleteFixture(workspace);
    const root = join(workspace, STATE_ROOT);
    const factsPath = join(root, "facts.json");
    const sourcesPath = join(root, "sources.json");
    const matricesPath = join(root, "matrices.json");
    const facts = JSON.parse(await readFile(factsPath, "utf8")) as { facts: Array<Record<string, unknown>> };
    const sources = JSON.parse(await readFile(sourcesPath, "utf8")) as {
      sources: Array<{ factIds: string[] }>;
    };
    const seededMatrices = JSON.parse(await readFile(matricesPath, "utf8")) as {
      matrices: Array<Record<string, unknown>>;
    };
    seededMatrices.matrices.push({
      id: "custom-non-contract-matrix",
      status: "not-applicable",
      notApplicableReason: "This custom projection is outside the configured legal task.",
      entries: [],
    });
    for (let index = 2; index <= 15; index += 1) {
      const factId = `F-${String(index).padStart(3, "0")}`;
      facts.facts.push({
        id: factId,
        subject: `Synthetic subject ${index}`,
        predicate: `material relationship ${index}`,
        value: `Synthetic source-grounded value ${index}`,
        missingTimeReason: "The synthetic source does not state a date.",
        sourceRefs: [{ sourceId: "S-001", locator: `line ${index}` }],
        evidenceClass: "official-record",
        verificationStatus: "verified",
        conflictStatus: "none",
        material: true,
        critical: false,
        thresholdAssessment: null,
      });
      sources.sources[0]!.factIds.push(factId);
    }
    await writeJson(factsPath, facts);
    await writeJson(sourcesPath, sources);
    await writeJson(matricesPath, seededMatrices);

    const first = await runHook({
      hookEventName: "PreModelRequest",
      sessionId: "matrix-relation-closure",
      transcriptPath: "",
      cwd: workspace,
    });
    const context = first.hookSpecificOutput.additionalContext ?? "";
    const envelope = JSON.parse(context
      .replace(/^<legal_coverage_state>\n/u, "")
      .replace(/\n<\/legal_coverage_state>$/u, "")) as {
      knownGaps: Array<{ code: string; occurrences: number }>;
      mutationContract: {
        target: {
          recordId: null;
          collectionIndex: null;
          selectionRequired: boolean;
          eligibleRecordIds: string[];
        };
        limits: { maxChangedRecords: number; maxSerializedBytes: number };
        prerequisites: string[];
      };
      workItems: {
        phase: string;
        group: string;
        stateHash: string;
        remaining: number;
        returned: number;
        hasMore: boolean;
        serializedBytes: number;
        limits: { maxRecords: number; maxSerializedBytes: number };
        batchLimits: { maxRecords: number; maxSerializedBytes: number };
        matrixTargets: Array<{ recordId: string; collectionIndex: number; status: string }>;
        items: Array<{ factId: string; subject: string; sourceRefs: Array<{ sourceId: string; locator: string }> }>;
      };
      nextAction: string;
    };
    assert.deepEqual(envelope.knownGaps[0], {
      phase: "matrices",
      code: "material_fact_matrix_orphaned",
      occurrences: 14,
      representativePaths: ["matrices.json", "matrices.json", "matrices.json", "matrices.json"],
    });
    assert.equal(envelope.workItems.phase, "matrices");
    assert.equal(envelope.workItems.group, "material-fact-matrix-closure");
    assert.equal(envelope.workItems.remaining, 14);
    assert.equal(envelope.workItems.returned, 12);
    assert.equal(envelope.workItems.hasMore, true);
    assert.deepEqual(envelope.workItems.limits, {
      maxRecords: 1,
      maxSerializedBytes: 24576,
    });
    assert.deepEqual(envelope.workItems.batchLimits, { maxRecords: 12, maxSerializedBytes: 8192 });
    assert.equal(envelope.workItems.serializedBytes <= 8192, true);
    assert.equal(envelope.workItems.serializedBytes, Buffer.byteLength(JSON.stringify(envelope.workItems.items)));
    assert.deepEqual(
      envelope.workItems.items.map((item) => item.factId),
      Array.from({ length: 12 }, (_, index) => `F-${String(index + 2).padStart(3, "0")}`),
    );
    assert.deepEqual(envelope.workItems.items[0]?.sourceRefs, [{ sourceId: "S-001", locator: "line 2" }]);
    assert.deepEqual(
      envelope.workItems.matrixTargets.map(({ recordId, collectionIndex }) => ({ recordId, collectionIndex })),
      [
        "equity-capital-timeline",
        "holding-platform-special-rights",
        "governance-personnel-timeline",
        "contract-key-terms",
        "debt-collateral-liquidity",
        "employment-ip-timeline",
        "legal-authority",
      ].map((recordId, collectionIndex) => ({ recordId, collectionIndex })),
    );
    assert.equal(envelope.mutationContract.target.recordId, null);
    assert.equal(envelope.mutationContract.target.collectionIndex, null);
    assert.equal(envelope.mutationContract.target.selectionRequired, true);
    assert.deepEqual(envelope.mutationContract.target.eligibleRecordIds, envelope.workItems.matrixTargets.map((item) => item.recordId));
    assert.equal(envelope.mutationContract.limits.maxChangedRecords, 1);
    assert.equal(envelope.mutationContract.prerequisites.some((item) => item.includes("full facts ledger")), true);
    assert.equal(envelope.mutationContract.prerequisites.some((item) => item.includes("and .pilotdeck/work/legal-coverage/facts.json")), false);
    assert.match(envelope.nextAction, /relation-closure batch is already injected/u);
    assert.match(envelope.nextAction, /choose exactly one legally compatible matrix/u);
    assert.match(envelope.nextAction, /update or create one fact-grounded entry/u);
    assert.match(envelope.nextAction, /do not read the full facts\.json/u);
    assert.match(envelope.nextAction, /do not run a discovery script/u);
    assert.match(envelope.nextAction, /do not change fact materiality/u);

    const convergence = first.hookSpecificOutput.modelRequestPatch?.metadata?.pilotdeckConvergence as {
      stateHash: string;
      nextBatch: { group: string; returned: number; hasMore: boolean };
      writeBudget: { maxRecords: number; maxSerializedBytes: number };
    };
    assert.deepEqual(convergence.nextBatch, {
      group: "material-fact-matrix-closure",
      returned: 12,
      hasMore: true,
    });
    assert.deepEqual(convergence.writeBudget, { maxRecords: 1, maxSerializedBytes: 24576 });

    const repeated = await runHook({
      hookEventName: "PreModelRequest",
      sessionId: "matrix-relation-closure",
      transcriptPath: "",
      cwd: workspace,
    });
    assert.equal(repeated.hookSpecificOutput.additionalContext, context);
    assert.equal(
      (repeated.hookSpecificOutput.modelRequestPatch?.metadata?.pilotdeckConvergence as { stateHash: string }).stateHash,
      convergence.stateHash,
    );

    const matrices = JSON.parse(await readFile(matricesPath, "utf8")) as {
      matrices: Array<{ id: string; entries: Array<{ summary: string; factIds: string[] }> }>;
    };
    const target = matrices.matrices.find((matrix) => matrix.id === "equity-capital-timeline")!;
    target.entries[0]!.summary += " Synthetic subject 2 is included in this matrix for the test.";
    target.entries[0]!.factIds.push("F-002");
    await writeJson(matricesPath, matrices);

    const advanced = await runHook({
      hookEventName: "PreModelRequest",
      sessionId: "matrix-relation-closure",
      transcriptPath: "",
      cwd: workspace,
    });
    const advancedContext = advanced.hookSpecificOutput.additionalContext ?? "";
    const advancedEnvelope = JSON.parse(advancedContext
      .replace(/^<legal_coverage_state>\n/u, "")
      .replace(/\n<\/legal_coverage_state>$/u, "")) as {
      workItems: { remaining: number; items: Array<{ factId: string }> };
    };
    assert.equal(advancedEnvelope.workItems.remaining, 13);
    assert.equal(advancedEnvelope.workItems.items[0]?.factId, "F-003");
    assert.notEqual(
      (advanced.hookSpecificOutput.modelRequestPatch?.metadata?.pilotdeckConvergence as { stateHash: string }).stateHash,
      convergence.stateHash,
    );
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("legal coverage authority closure uses one bounded state-bound transaction", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pilotdeck-legal-coverage-authority-closure-"));
  try {
    await writeAuthorityClosureFixture(workspace);
    const root = join(workspace, STATE_ROOT);
    const sessionId = "authority-closure";
    const firstHook = await runHook({ hookEventName: "PreModelRequest", sessionId, transcriptPath: "", cwd: workspace });
    const firstEnvelope = legalEnvelope(firstHook) as {
      workItems: {
        group: string;
        returned: number;
        limits: { maxRecords: number; maxFacts: number; maxSerializedBytes: number };
        preparedSlice: {
          target: { entryId: string; factIds: string[]; issueIds: string[]; authorityIds: string[] };
          allowedIssueRules: Array<{ ruleId: string; riskSignal: string; whenToUse: string }>;
          facts: Array<{ factId: string }>;
          existingIssues: Array<{ id: string }>;
        };
        proposal: { path: string; template: Record<string, unknown> };
      };
      authorityClosureApplyCommand?: string;
      mutationContract: { canonicalPaths: string[]; strategy: string; interface: { instruction: string } };
      nextAction: string;
    };
    assert.equal(firstEnvelope.workItems.group, "authority-closure-propose");
    assert.equal(firstEnvelope.workItems.returned, 1);
    assert.deepEqual(firstEnvelope.workItems.limits, { maxRecords: 8, maxFacts: 12, maxSerializedBytes: 24576 });
    assert.deepEqual(firstEnvelope.workItems.preparedSlice.target, {
      matrixId: "legal-authority",
      matrixIndex: 6,
      entryId: "LA-001",
      entryIndex: 0,
      summary: "The critical capital threshold requires controlling legal support.",
      factIds: ["F-001"],
      riskSignals: [],
      issueIds: ["I-001"],
      authorityIds: [],
    });
    assert.deepEqual(firstEnvelope.workItems.preparedSlice.facts.map((fact) => fact.factId), ["F-001"]);
    assert.deepEqual(firstEnvelope.workItems.preparedSlice.existingIssues.map((issue) => issue.id), ["I-001"]);
    assert.equal(
      firstEnvelope.workItems.preparedSlice.allowedIssueRules.some((rule) =>
        rule.ruleId === "liquidity-relationship"
          && rule.riskSignal === "liquidity_relationship"
          && rule.whenToUse.includes("collateral")
      ),
      true,
    );
    assert.equal(firstEnvelope.authorityClosureApplyCommand, undefined);
    assert.deepEqual(firstEnvelope.mutationContract.canonicalPaths, [
      `${STATE_ROOT}/issues.json`,
      `${STATE_ROOT}/authorities.json`,
      `${STATE_ROOT}/matrices.json`,
    ]);
    assert.equal(firstEnvelope.mutationContract.strategy, "state-bound-proposal-apply");
    assert.match(firstEnvelope.mutationContract.interface.instruction, /Never edit issues\.json/u);
    assert.match(firstEnvelope.nextAction, /already injected/u);
    assert.match(firstEnvelope.nextAction, /write exactly one proposal/u);
    assert.match(firstEnvelope.nextAction, /Do not read issues\.json/u);

    const proposalPath = join(workspace, firstEnvelope.workItems.proposal.path);
    const canonicalPaths = ["issues.json", "authorities.json", "matrices.json"].map((name) => join(root, name));
    const beforeInvalid = await Promise.all(canonicalPaths.map((path) => readFile(path, "utf8")));
    const invalid = authorityClosureProposal(firstEnvelope.workItems.proposal.template);
    invalid.issueUpserts[0]!.factIds = ["F-OUT-OF-SCOPE"];
    await writeJson(proposalPath, invalid);
    const invalidHookOne = await runHook({ hookEventName: "PreModelRequest", sessionId, transcriptPath: "", cwd: workspace });
    const invalidEnvelopeOne = legalEnvelope(invalidHookOne) as {
      workItems: { group: string; proposal: { validationError: { code: string } } };
    };
    assert.equal(invalidEnvelopeOne.workItems.group, "authority-closure-propose");
    assert.equal(invalidEnvelopeOne.workItems.proposal.validationError.code, "authority_closure_issue_scope_invalid");
    const invalidConvergenceOne = invalidHookOne.hookSpecificOutput.modelRequestPatch?.metadata?.pilotdeckConvergence as {
      stateHash: string; progressOrdinal: number; repairOrdinal: number; handoffOrdinal: number;
    };
    assert.deepEqual(await Promise.all(canonicalPaths.map((path) => readFile(path, "utf8"))), beforeInvalid);

    invalid.issueUpserts[0]!.factIds = ["F-ANOTHER-OUT-OF-SCOPE"];
    await writeJson(proposalPath, invalid);
    const invalidHookTwo = await runHook({ hookEventName: "PreModelRequest", sessionId, transcriptPath: "", cwd: workspace });
    const invalidConvergenceTwo = invalidHookTwo.hookSpecificOutput.modelRequestPatch?.metadata?.pilotdeckConvergence as {
      stateHash: string; progressOrdinal: number; repairOrdinal: number; handoffOrdinal: number;
    };
    assert.equal(invalidConvergenceTwo.stateHash, invalidConvergenceOne.stateHash);
    assert.equal(invalidConvergenceTwo.progressOrdinal, invalidConvergenceOne.progressOrdinal);
    assert.equal(invalidConvergenceTwo.repairOrdinal, invalidConvergenceOne.repairOrdinal);
    assert.equal(invalidConvergenceTwo.handoffOrdinal, invalidConvergenceOne.handoffOrdinal);

    const changedExistingIssue = authorityClosureProposal(firstEnvelope.workItems.proposal.template);
    changedExistingIssue.issueUpserts[0]!.analysis = "An unauthorized rewrite of existing legal reasoning.";
    await writeJson(proposalPath, changedExistingIssue);
    const changedHook = await runHook({ hookEventName: "PreModelRequest", sessionId, transcriptPath: "", cwd: workspace });
    assert.equal(
      (legalEnvelope(changedHook) as { workItems: { proposal: { validationError: { code: string } } } })
        .workItems.proposal.validationError.code,
      "authority_closure_existing_issue_changed",
    );
    assert.deepEqual(await Promise.all(canonicalPaths.map((path) => readFile(path, "utf8"))), beforeInvalid);

    const tooMany = authorityClosureProposal(firstEnvelope.workItems.proposal.template);
    tooMany.issueUpserts = Array.from({ length: 9 }, (_, index) => ({
      ...tooMany.issueUpserts[0]!,
      id: `I-LIMIT-${index}`,
    }));
    await writeJson(proposalPath, tooMany);
    const tooManyHook = await runHook({ hookEventName: "PreModelRequest", sessionId, transcriptPath: "", cwd: workspace });
    assert.equal(
      (legalEnvelope(tooManyHook) as { workItems: { proposal: { validationError: { code: string } } } })
        .workItems.proposal.validationError.code,
      "authority_closure_records_invalid",
    );

    const extraUpsert = authorityClosureProposal(firstEnvelope.workItems.proposal.template);
    extraUpsert.authorityUpserts.push({
      ...extraUpsert.authorityUpserts[0]!,
      id: "A-UNLINKED",
    });
    await writeJson(proposalPath, extraUpsert);
    const extraUpsertHook = await runHook({ hookEventName: "PreModelRequest", sessionId, transcriptPath: "", cwd: workspace });
    assert.equal(
      (legalEnvelope(extraUpsertHook) as { workItems: { proposal: { validationError: { code: string } } } })
        .workItems.proposal.validationError.code,
      "authority_closure_upsert_out_of_scope",
    );
    assert.deepEqual(await Promise.all(canonicalPaths.map((path) => readFile(path, "utf8"))), beforeInvalid);

    const valid = authorityClosureProposal(firstEnvelope.workItems.proposal.template);
    await writeJson(proposalPath, valid);
    const validHook = await runHook({ hookEventName: "PreModelRequest", sessionId, transcriptPath: "", cwd: workspace });
    const validEnvelope = legalEnvelope(validHook) as {
      workItems: {
        group: string;
        preparedSlice?: unknown;
        proposal: {
          path: string;
          proposalSha256: string;
          validated: boolean;
          template?: unknown;
          transaction?: unknown;
        };
      };
      authorityClosureApplyCommand: string;
      nextAction: string;
    };
    assert.equal(validEnvelope.workItems.group, "authority-closure-apply");
    assert.equal(validEnvelope.workItems.preparedSlice, undefined);
    assert.equal(validEnvelope.workItems.proposal.validated, true);
    assert.equal(validEnvelope.workItems.proposal.template, undefined);
    assert.equal(validEnvelope.workItems.proposal.transaction, undefined);
    assert.match(validEnvelope.authorityClosureApplyCommand, /authority-closure-apply/u);
    assert.match(validEnvelope.authorityClosureApplyCommand, new RegExp(validEnvelope.workItems.proposal.proposalSha256, "u"));
    assert.match(validEnvelope.nextAction, /Execute authorityClosureApplyCommand exactly/u);
    const validConvergence = validHook.hookSpecificOutput.modelRequestPatch?.metadata?.pilotdeckConvergence as {
      progressOrdinal: number; handoffOrdinal: number;
    };
    assert.equal(validConvergence.progressOrdinal, invalidConvergenceOne.progressOrdinal);
    assert.equal(validConvergence.handoffOrdinal, invalidConvergenceOne.handoffOrdinal + 1);
    const replayedHook = await runHook({ hookEventName: "PreModelRequest", sessionId, transcriptPath: "", cwd: workspace });
    assert.equal(
      (replayedHook.hookSpecificOutput.modelRequestPatch?.metadata?.pilotdeckConvergence as { handoffOrdinal: number }).handoffOrdinal,
      validConvergence.handoffOrdinal,
    );

    const applied = await runCli(
      workspace,
      "authority-closure-apply",
      "--input-file", validEnvelope.workItems.proposal.path,
      "--proposal-sha256", validEnvelope.workItems.proposal.proposalSha256,
    );
    assert.equal(applied.exitCode, 0, applied.stderr);
    const appliedResult = JSON.parse(applied.stdout) as {
      applied: boolean; entryId: string; issuesUpserted: number; authoritiesUpserted: number;
    };
    assert.deepEqual(
      { applied: appliedResult.applied, entryId: appliedResult.entryId, issuesUpserted: appliedResult.issuesUpserted, authoritiesUpserted: appliedResult.authoritiesUpserted },
      { applied: true, entryId: "LA-001", issuesUpserted: 1, authoritiesUpserted: 1 },
    );
    const issues = JSON.parse(await readFile(join(root, "issues.json"), "utf8")) as { issues: Array<{ id: string; authorityIds: string[] }> };
    const authorities = JSON.parse(await readFile(join(root, "authorities.json"), "utf8")) as { authorities: Array<{ id: string; supportedIssueIds: string[] }> };
    const matrices = JSON.parse(await readFile(join(root, "matrices.json"), "utf8")) as { matrices: Array<{ id: string; entries: Array<{ id: string; issueIds: string[]; authorityIds: string[] }> }> };
    assert.deepEqual(issues.issues.find((issue) => issue.id === "I-001")?.authorityIds, ["A-LEGAL"]);
    assert.deepEqual(authorities.authorities, [{
      id: "A-LEGAL",
      name: "Synthetic transactions act",
      article: "Article 1",
      effectiveVersion: "Current synthetic version",
      effectiveDate: "Synthetic effective date",
      verificationStatus: "verified",
      sourceLocator: "Synthetic official source",
      supportedIssueIds: ["I-001"],
      supportedConclusion: "A closing condition may address the identified risk.",
    }]);
    const legalMatrix = matrices.matrices.find((matrix) => matrix.id === "legal-authority")!;
    assert.deepEqual(legalMatrix.entries[0], {
      id: "LA-001",
      summary: "The critical capital threshold requires controlling legal support.",
      factIds: ["F-001"],
      riskSignals: [],
      issueIds: ["I-001"],
      authorityIds: ["A-LEGAL"],
    });

    const replayApply = await runCli(
      workspace,
      "authority-closure-apply",
      "--input-file", validEnvelope.workItems.proposal.path,
      "--proposal-sha256", validEnvelope.workItems.proposal.proposalSha256,
    );
    assert.equal(replayApply.exitCode, 1);
    assert.equal(JSON.parse(replayApply.stderr).error.code, "authority_closure_out_of_scope");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("legal coverage risk-signal issue closure exposes one bounded state-bound transaction", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pilotdeck-legal-coverage-issue-closure-"));
  try {
    await writeIssueClosureFixture(workspace);
    const replay = JSON.parse(await readFile(
      resolve("tests/fixtures/convergence/case-09-issue-closure-replay.json"),
      "utf8",
    )) as {
      target: { matrixId: string; entryId: string; summary: string; factIds: string[]; riskSignals: string[]; issueIds: string[]; authorityIds: string[] };
      expected: { phase: string; blockingCode: string; workGroup: string; applyCommand: string };
    };

    const firstHook = await runHook({
      hookEventName: "PreModelRequest",
      sessionId: "issue-closure",
      transcriptPath: "",
      cwd: workspace,
    });
    const envelope = legalEnvelope(firstHook) as {
      knownGaps: Array<{ phase: string; code: string }>;
      workItems: {
        group: string;
        returned: number;
        limits: { maxRecords: number; maxFacts: number; maxSerializedBytes: number };
        preparedSlice: {
          target: typeof replay.target & { matrixIndex: number; entryIndex: number };
          facts: Array<{ factId: string }>;
          allowedIssueRules: Array<{ ruleId: string; riskSignal: string; whenToUse: string }>;
        };
        proposal: { path: string; template: Record<string, unknown> };
      };
      issueClosureApplyCommand?: string;
      mutationContract: {
        strategy: string;
        canonicalPaths: string[];
        interface: { kind: string; phaseApplyCommandAvailable: boolean; instruction: string };
      };
      nextAction: string;
    };

    assert.equal(envelope.knownGaps[0]?.phase, replay.expected.phase);
    assert.equal(envelope.knownGaps[0]?.code, replay.expected.blockingCode);
    assert.equal(envelope.workItems.group, replay.expected.workGroup);
    assert.equal(envelope.workItems.returned, 1);
    assert.deepEqual(envelope.workItems.limits, { maxRecords: 6, maxFacts: 12, maxSerializedBytes: 24576 });
    assert.deepEqual(envelope.workItems.preparedSlice.target, {
      ...replay.target,
      matrixIndex: 0,
      entryIndex: 0,
    });
    assert.deepEqual(
      envelope.workItems.preparedSlice.facts.map((fact) => fact.factId),
      replay.target.factIds,
    );
    assert.equal(
      envelope.workItems.preparedSlice.allowedIssueRules.some((rule) =>
        rule.ruleId === "rights-governance-conflict"
          && rule.riskSignal === "rights_governance_conflict"
          && rule.whenToUse.includes("ownership")
      ),
      true,
    );
    assert.equal(
      (envelope.workItems.proposal.template.issueUpserts as Array<{ critical: boolean }>)[0]?.critical,
      true,
    );
    assert.match(envelope.workItems.proposal.path, /issue-transactions\/issue-closure-[a-f0-9]{12}\.json$/u);
    assert.equal(envelope.issueClosureApplyCommand, undefined);
    assert.equal(envelope.mutationContract.strategy, "state-bound-proposal-apply");
    assert.deepEqual(envelope.mutationContract.canonicalPaths, [
      `${STATE_ROOT}/issues.json`,
      `${STATE_ROOT}/matrices.json`,
    ]);
    assert.equal(envelope.mutationContract.interface.kind, "state-bound-proposal");
    assert.equal(envelope.mutationContract.interface.phaseApplyCommandAvailable, false);
    assert.match(envelope.mutationContract.interface.instruction, /Never edit issues\.json or matrices\.json directly/u);
    assert.match(envelope.nextAction, /write exactly one proposal/u);
    assert.match(envelope.nextAction, new RegExp(replay.expected.applyCommand, "u"));
    const initialConvergence = firstHook.hookSpecificOutput.modelRequestPatch?.metadata?.pilotdeckConvergence as {
      handoffOrdinal: number;
    };

    const root = join(workspace, STATE_ROOT);
    const canonicalPaths = ["issues.json", "matrices.json"].map((name) => join(root, name));
    const unchanged = await Promise.all(canonicalPaths.map((path) => readFile(path, "utf8")));
    const invalid = issueClosureProposal(envelope.workItems.proposal.template);
    invalid.issueUpserts[0]!.factIds = ["F-OUT-OF-SCOPE"];
    await writeJson(join(workspace, envelope.workItems.proposal.path), invalid);
    const invalidHook = await runHook({
      hookEventName: "PreModelRequest",
      sessionId: "issue-closure",
      transcriptPath: "",
      cwd: workspace,
    });
    const invalidEnvelope = legalEnvelope(invalidHook) as {
      workItems: { group: string; proposal: { validationError: { code: string } } };
    };
    assert.equal(invalidEnvelope.workItems.group, "issue-closure-propose");
    assert.equal(invalidEnvelope.workItems.proposal.validationError.code, "issue_closure_issue_scope_invalid");
    assert.deepEqual(await Promise.all(canonicalPaths.map((path) => readFile(path, "utf8"))), unchanged);

    const downgraded = issueClosureProposal(envelope.workItems.proposal.template);
    downgraded.issueUpserts[0]!.critical = false;
    await writeJson(join(workspace, envelope.workItems.proposal.path), downgraded);
    const downgradedHook = await runHook({
      hookEventName: "PreModelRequest",
      sessionId: "issue-closure",
      transcriptPath: "",
      cwd: workspace,
    });
    assert.equal(
      (legalEnvelope(downgradedHook) as { workItems: { proposal: { validationError: { code: string } } } })
        .workItems.proposal.validationError.code,
      "issue_closure_criticality_invalid",
    );
    assert.deepEqual(await Promise.all(canonicalPaths.map((path) => readFile(path, "utf8"))), unchanged);

    const duplicate = issueClosureProposal(envelope.workItems.proposal.template);
    const existingIssues = JSON.parse(await readFile(join(root, "issues.json"), "utf8")) as {
      issues: Array<Record<string, unknown>>;
    };
    existingIssues.issues.push({ ...duplicate.issueUpserts[0] });
    await writeJson(join(root, "issues.json"), existingIssues);
    const duplicatePreparation = legalEnvelope(await runHook({
      hookEventName: "PreModelRequest",
      sessionId: "issue-closure",
      transcriptPath: "",
      cwd: workspace,
    })) as { workItems: { proposal: { path: string; template: Record<string, unknown> } } };
    const duplicateProposal = issueClosureProposal(duplicatePreparation.workItems.proposal.template);
    await writeJson(join(workspace, duplicatePreparation.workItems.proposal.path), duplicateProposal);
    const duplicateHook = await runHook({
      hookEventName: "PreModelRequest",
      sessionId: "issue-closure",
      transcriptPath: "",
      cwd: workspace,
    });
    assert.equal(
      (legalEnvelope(duplicateHook) as { workItems: { proposal: { validationError: { code: string } } } })
        .workItems.proposal.validationError.code,
      "issue_closure_duplicate_id",
    );
    await writeJson(join(root, "issues.json"), { schemaVersion: 1, issues: [] });

    const extraLink = issueClosureProposal(envelope.workItems.proposal.template);
    extraLink.matrixEntryLinks.issueIds.push("I-UNPROPOSED");
    await writeJson(join(workspace, envelope.workItems.proposal.path), extraLink);
    const extraLinkHook = await runHook({
      hookEventName: "PreModelRequest",
      sessionId: "issue-closure",
      transcriptPath: "",
      cwd: workspace,
    });
    assert.equal(
      (legalEnvelope(extraLinkHook) as { workItems: { proposal: { validationError: { code: string } } } })
        .workItems.proposal.validationError.code,
      "issue_closure_links_invalid",
    );

    const valid = issueClosureProposal(envelope.workItems.proposal.template);
    await writeJson(join(workspace, envelope.workItems.proposal.path), valid);
    const postWrite = await runHook({
      hookEventName: "PostToolUse",
      sessionId: "issue-closure",
      transcriptPath: "",
      cwd: workspace,
      toolName: "write_file",
      toolInput: { file_path: envelope.workItems.proposal.path },
    });
    assert.equal(postWrite.hookSpecificOutput.modelRequestPatch, undefined);
    assert.equal(
      postWrite.hookSpecificOutput.convergencePreview?.handoffOrdinal,
      initialConvergence.handoffOrdinal + 1,
    );
    const unrelatedWrite = await runHook({
      hookEventName: "PostToolUse",
      sessionId: "issue-closure",
      transcriptPath: "",
      cwd: workspace,
      toolName: "write_file",
      toolInput: { file_path: "notes.md" },
    });
    assert.equal(unrelatedWrite.hookSpecificOutput.convergencePreview, undefined);
    const proposalRead = await runHook({
      hookEventName: "PostToolUse",
      sessionId: "issue-closure",
      transcriptPath: "",
      cwd: workspace,
      toolName: "read_file",
      toolInput: { file_path: envelope.workItems.proposal.path },
    });
    assert.equal(proposalRead.hookSpecificOutput.convergencePreview, undefined);
    const readOnlyCli = await runHook({
      hookEventName: "PostToolUse",
      sessionId: "issue-closure",
      transcriptPath: "",
      cwd: workspace,
      toolName: "bash",
      toolInput: { command: `node ${JSON.stringify(CLI)} status --workspace .` },
    });
    assert.equal(readOnlyCli.hookSpecificOutput.convergencePreview, undefined);
    const validHook = await runHook({
      hookEventName: "PreModelRequest",
      sessionId: "issue-closure",
      transcriptPath: "",
      cwd: workspace,
    });
    const validEnvelope = legalEnvelope(validHook) as {
      workItems: {
        group: string;
        preparedSlice?: unknown;
        proposal: {
          path: string;
          proposalSha256: string;
          validated: boolean;
          template?: unknown;
          transaction?: unknown;
        };
      };
      issueClosureApplyCommand: string;
      mutationContract: { interface: { phaseApplyCommandAvailable: boolean } };
      nextAction: string;
    };
    assert.equal(validEnvelope.workItems.group, "issue-closure-apply");
    assert.equal(validEnvelope.workItems.preparedSlice, undefined);
    assert.equal(validEnvelope.workItems.proposal.validated, true);
    assert.equal(validEnvelope.workItems.proposal.template, undefined);
    assert.equal(validEnvelope.workItems.proposal.transaction, undefined);
    assert.equal(validEnvelope.mutationContract.interface.phaseApplyCommandAvailable, true);
    assert.match(validEnvelope.issueClosureApplyCommand, /issue-closure-apply/u);
    assert.match(validEnvelope.issueClosureApplyCommand, new RegExp(validEnvelope.workItems.proposal.proposalSha256, "u"));
    assert.match(validEnvelope.nextAction, /Execute issueClosureApplyCommand exactly/u);
    const validConvergence = validHook.hookSpecificOutput.modelRequestPatch?.metadata?.pilotdeckConvergence as {
      handoffOrdinal: number;
    };
    assert.equal(validConvergence.handoffOrdinal, initialConvergence.handoffOrdinal + 1);
    const replayedHook = await runHook({
      hookEventName: "PreModelRequest",
      sessionId: "issue-closure",
      transcriptPath: "",
      cwd: workspace,
    });
    assert.equal(
      (replayedHook.hookSpecificOutput.modelRequestPatch?.metadata?.pilotdeckConvergence as { handoffOrdinal: number })
        .handoffOrdinal,
      validConvergence.handoffOrdinal,
    );

    const applied = await runCli(
      workspace,
      "issue-closure-apply",
      "--input-file", validEnvelope.workItems.proposal.path,
      "--proposal-sha256", validEnvelope.workItems.proposal.proposalSha256,
    );
    assert.equal(applied.exitCode, 0, applied.stderr);
    const appliedResult = JSON.parse(applied.stdout) as {
      applied: boolean; matrixId: string; entryId: string; issuesUpserted: number;
    };
    assert.deepEqual(
      {
        applied: appliedResult.applied,
        matrixId: appliedResult.matrixId,
        entryId: appliedResult.entryId,
        issuesUpserted: appliedResult.issuesUpserted,
      },
      {
        applied: true,
        matrixId: replay.target.matrixId,
        entryId: replay.target.entryId,
        issuesUpserted: 1,
      },
    );
    const appliedIssues = JSON.parse(await readFile(join(root, "issues.json"), "utf8")) as {
      issues: Array<Record<string, unknown>>;
    };
    const appliedMatrices = JSON.parse(await readFile(join(root, "matrices.json"), "utf8")) as {
      matrices: Array<{ id: string; entries: Array<{ id: string; issueIds: string[] }> }>;
    };
    assert.deepEqual(appliedIssues.issues, valid.issueUpserts);
    assert.deepEqual(
      appliedMatrices.matrices[0]!.entries[0]!.issueIds,
      valid.matrixEntryLinks.issueIds,
    );
    assert.deepEqual(
      JSON.parse(await readFile(join(root, "authorities.json"), "utf8")),
      { schemaVersion: 1, authorities: [] },
    );

    const replayApply = await runCli(
      workspace,
      "issue-closure-apply",
      "--input-file", validEnvelope.workItems.proposal.path,
      "--proposal-sha256", validEnvelope.workItems.proposal.proposalSha256,
    );
    assert.equal(replayApply.exitCode, 1);
    assert.equal(JSON.parse(replayApply.stderr).error.code, "issue_closure_out_of_scope");
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("legal coverage rejects changed and symlinked issue closure proposals without ledger mutation", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pilotdeck-legal-coverage-issue-closure-reject-"));
  const outside = await mkdtemp(join(tmpdir(), "pilotdeck-legal-coverage-issue-closure-outside-"));
  try {
    await writeIssueClosureFixture(workspace);
    const root = join(workspace, STATE_ROOT);
    const first = legalEnvelope(await runHook({
      hookEventName: "PreModelRequest",
      sessionId: "issue-closure-reject",
      transcriptPath: "",
      cwd: workspace,
    })) as { workItems: { proposal: { path: string; template: Record<string, unknown> } } };
    const proposal = issueClosureProposal(first.workItems.proposal.template);
    await writeJson(join(workspace, first.workItems.proposal.path), proposal);
    const validated = legalEnvelope(await runHook({
      hookEventName: "PreModelRequest",
      sessionId: "issue-closure-reject",
      transcriptPath: "",
      cwd: workspace,
    })) as { workItems: { proposal: { path: string; proposalSha256: string } } };
    const canonicalPaths = ["issues.json", "matrices.json"].map((name) => join(root, name));
    const unchanged = await Promise.all(canonicalPaths.map((path) => readFile(path, "utf8")));

    proposal.issueUpserts[0]!.analysis = "Changed after validation.";
    await writeJson(join(workspace, validated.workItems.proposal.path), proposal);
    const changed = await runCli(
      workspace,
      "issue-closure-apply",
      "--input-file", validated.workItems.proposal.path,
      "--proposal-sha256", validated.workItems.proposal.proposalSha256,
    );
    assert.equal(changed.exitCode, 1);
    assert.equal(JSON.parse(changed.stderr).error.code, "issue_closure_changed");
    assert.deepEqual(await Promise.all(canonicalPaths.map((path) => readFile(path, "utf8"))), unchanged);

    await writeJson(join(workspace, validated.workItems.proposal.path), issueClosureProposal(first.workItems.proposal.template));
    const factsPath = join(root, "facts.json");
    const facts = JSON.parse(await readFile(factsPath, "utf8")) as { facts: Array<Record<string, unknown>> };
    facts.facts[0]!.verificationStatus = "partially-verified";
    await writeJson(factsPath, facts);
    const stale = await runCli(
      workspace,
      "issue-closure-apply",
      "--input-file", validated.workItems.proposal.path,
      "--proposal-sha256", sha256(await readFile(join(workspace, validated.workItems.proposal.path))),
    );
    assert.equal(stale.exitCode, 1);
    assert.equal(JSON.parse(stale.stderr).error.code, "issue_closure_out_of_scope");
    assert.deepEqual(await Promise.all(canonicalPaths.map((path) => readFile(path, "utf8"))), unchanged);

    await rm(join(root, "issue-transactions"), { recursive: true, force: true });
    await symlink(outside, join(root, "issue-transactions"));
    const outsideProposal = join(outside, validated.workItems.proposal.path.split("/").at(-1)!);
    await writeJson(outsideProposal, issueClosureProposal(first.workItems.proposal.template));
    const outsideBytes = await readFile(outsideProposal);
    const symlinked = await runCli(
      workspace,
      "issue-closure-apply",
      "--input-file", validated.workItems.proposal.path,
      "--proposal-sha256", sha256(outsideBytes),
    );
    assert.equal(symlinked.exitCode, 1);
    assert.equal(JSON.parse(symlinked.stderr).error.code, "issue_closure_apply_failed");
    assert.deepEqual(await Promise.all(canonicalPaths.map((path) => readFile(path, "utf8"))), unchanged);
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("legal coverage rejects changed and symlinked authority closure proposals without ledger mutation", async () => {
  const workspace = await mkdtemp(join(tmpdir(), "pilotdeck-legal-coverage-authority-closure-reject-"));
  const outside = await mkdtemp(join(tmpdir(), "pilotdeck-legal-coverage-authority-closure-outside-"));
  try {
    await writeAuthorityClosureFixture(workspace);
    const root = join(workspace, STATE_ROOT);
    const first = legalEnvelope(await runHook({ hookEventName: "PreModelRequest", sessionId: "authority-reject", transcriptPath: "", cwd: workspace })) as {
      workItems: { proposal: { path: string; template: Record<string, unknown> } };
    };
    const proposal = authorityClosureProposal(first.workItems.proposal.template);
    await writeJson(join(workspace, first.workItems.proposal.path), proposal);
    const validated = legalEnvelope(await runHook({ hookEventName: "PreModelRequest", sessionId: "authority-reject", transcriptPath: "", cwd: workspace })) as {
      workItems: { proposal: { path: string; proposalSha256: string } };
    };
    const canonicalPaths = ["issues.json", "authorities.json", "matrices.json"].map((name) => join(root, name));
    const unchanged = await Promise.all(canonicalPaths.map((path) => readFile(path, "utf8")));
    proposal.authorityUpserts[0]!.supportedConclusion = "Changed after validation.";
    await writeJson(join(workspace, validated.workItems.proposal.path), proposal);
    const changed = await runCli(
      workspace,
      "authority-closure-apply",
      "--input-file", validated.workItems.proposal.path,
      "--proposal-sha256", validated.workItems.proposal.proposalSha256,
    );
    assert.equal(changed.exitCode, 1);
    assert.equal(JSON.parse(changed.stderr).error.code, "authority_closure_changed");
    assert.deepEqual(await Promise.all(canonicalPaths.map((path) => readFile(path, "utf8"))), unchanged);

    await rm(join(root, "authority-transactions"), { recursive: true, force: true });
    await symlink(outside, join(root, "authority-transactions"));
    const outsideProposal = join(outside, validated.workItems.proposal.path.split("/").at(-1)!);
    await writeJson(outsideProposal, authorityClosureProposal(first.workItems.proposal.template));
    const outsideBytes = await readFile(outsideProposal);
    const symlinked = await runCli(
      workspace,
      "authority-closure-apply",
      "--input-file", validated.workItems.proposal.path,
      "--proposal-sha256", sha256(outsideBytes),
    );
    assert.equal(symlinked.exitCode, 1);
    assert.equal(JSON.parse(symlinked.stderr).error.code, "authority_closure_apply_failed");
    assert.deepEqual(await Promise.all(canonicalPaths.map((path) => readFile(path, "utf8"))), unchanged);
  } finally {
    await rm(workspace, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("legal coverage milestone digest ignores opaque incomplete-state hash churn", async () => {
  const { convergenceStateHash, milestoneDigest } = await import(pathToFileURL(VALIDATOR_LIB).href) as {
    convergenceStateHash: (result: Record<string, unknown>, workItems?: Record<string, unknown>) => string;
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
  assert.notEqual(convergenceStateHash(incomplete), convergenceStateHash({
    ...incomplete,
    stateHash: "b".repeat(64),
  }));
  assert.notEqual(convergenceStateHash(incomplete), convergenceStateHash(incomplete, {
    group: "source-fragment-merge",
    receipts: [{ id: "source-review-example", receiptSha256: "c".repeat(64) }],
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
  assert.equal(plugin.hooksConfig?.PostToolUse?.length, 1);
  assert.equal(plugin.hooksConfig?.PostToolUse?.[0]?.matcher, "bash|read_file|write_file");
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

async function writeAuthorityClosureFixture(workspace: string): Promise<void> {
  await writeCompleteFixture(workspace);
  const root = join(workspace, STATE_ROOT);
  await mkdir(join(root, "authority-transactions"), { recursive: true });
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
      ].map((id) => ({
        id,
        status: "not-applicable",
        entries: [],
        notApplicableReason: "No separate synthetic relationship is required for this fixture.",
      })),
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
  const issues = JSON.parse(await readFile(join(root, "issues.json"), "utf8")) as {
    schemaVersion: number;
    issues: Array<Record<string, unknown>>;
  };
  issues.issues[0]!.authorityIds = [];
  await writeJson(join(root, "issues.json"), issues);
  await writeJson(join(root, "authorities.json"), { schemaVersion: 1, authorities: [] });
}

async function writeIssueClosureFixture(workspace: string): Promise<void> {
  await writeCompleteFixture(workspace);
  const root = join(workspace, STATE_ROOT);
  const sourcePath = join(root, "sources.json");
  const sources = JSON.parse(await readFile(sourcePath, "utf8")) as {
    sources: Array<{ factIds: string[] }>;
  };
  sources.sources[0]!.factIds = ["F-SYNTHETIC-001", "F-SYNTHETIC-002", "F-SYNTHETIC-003"];
  await writeJson(sourcePath, sources);
  await writeJson(join(root, "facts.json"), {
    schemaVersion: 1,
    facts: [1, 2, 3].map((index) => ({
      id: `F-SYNTHETIC-00${index}`,
      subject: `Synthetic governance subject ${index}`,
      predicate: `synthetic governance predicate ${index}`,
      value: `Synthetic governance value ${index}`,
      missingTimeReason: "The synthetic source has no relevant date.",
      sourceRefs: [{ sourceId: "S-001", locator: `line ${index}` }],
      evidenceClass: "official-record",
      verificationStatus: "verified",
      conflictStatus: "none",
      material: true,
      critical: index === 1,
    })),
  });
  await writeJson(join(root, "matrices.json"), {
    schemaVersion: 1,
    matrices: [
      {
        id: "equity-capital-timeline",
        status: "complete",
        entries: [{
          id: "M-SYNTHETIC-001",
          summary: "Synthetic ownership and governance facts require cross-fact analysis.",
          factIds: ["F-SYNTHETIC-001", "F-SYNTHETIC-002", "F-SYNTHETIC-003"],
          riskSignals: ["rights_governance_conflict"],
          issueIds: [],
          authorityIds: [],
        }],
      },
      ...[
        "holding-platform-special-rights",
        "governance-personnel-timeline",
        "contract-key-terms",
        "debt-collateral-liquidity",
        "employment-ip-timeline",
        "legal-authority",
      ].map((id) => ({
        id,
        status: "not-applicable",
        entries: [],
        notApplicableReason: "No additional synthetic relation is required for this fixture.",
      })),
    ],
  });
  await writeJson(join(root, "issues.json"), { schemaVersion: 1, issues: [] });
  await writeJson(join(root, "authorities.json"), { schemaVersion: 1, authorities: [] });
  await mkdir(join(root, "issue-transactions"), { recursive: true });
}

function issueClosureProposal(template: Record<string, unknown>): {
  schemaVersion: number;
  phase: string;
  group: string;
  expectedStateHash: string;
  targetMatrixId: string;
  targetEntryId: string;
  preparedSliceSha256: string;
  issueUpserts: Array<Record<string, unknown> & { factIds: string[] }>;
  matrixEntryLinks: { issueIds: string[] };
} {
  const envelope = structuredClone(template) as {
    schemaVersion: number;
    phase: string;
    group: string;
    expectedStateHash: string;
    targetMatrixId: string;
    targetEntryId: string;
    preparedSliceSha256: string;
  };
  return {
    ...envelope,
    issueUpserts: [{
      id: "I-SYNTHETIC-001",
      ruleId: "rights-governance-conflict",
      status: "open",
      severity: "high",
      critical: true,
      factIds: ["F-SYNTHETIC-001", "F-SYNTHETIC-002", "F-SYNTHETIC-003"],
      authorityIds: [],
      analysis: "The synthetic ownership and governance facts do not align.",
      conclusion: "The governance conflict requires a documented transaction control.",
      recommendations: ["Require a verified governance remediation before closing."],
    }],
    matrixEntryLinks: { issueIds: ["I-SYNTHETIC-001"] },
  };
}

function authorityClosureProposal(template: Record<string, unknown>): {
  schemaVersion: number;
  phase: string;
  group: string;
  expectedStateHash: string;
  targetEntryId: string;
  preparedSliceSha256: string;
  issueUpserts: Array<Record<string, unknown> & { factIds: string[]; analysis: string }>;
  authorityUpserts: Array<Record<string, unknown> & { supportedConclusion: string }>;
  matrixEntryLinks: { issueIds: string[]; authorityIds: string[] };
} {
  const envelope = structuredClone(template) as {
    schemaVersion: number;
    phase: string;
    group: string;
    expectedStateHash: string;
    targetEntryId: string;
    preparedSliceSha256: string;
  };
  return {
    ...envelope,
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
  stopReason?: string;
  hookSpecificOutput: {
    additionalContext?: string;
    dynamicContext?: unknown[];
    artifactContracts?: Array<{ path: string }>;
    modelRequestPatch?: { metadata?: Record<string, unknown> };
    convergencePreview?: {
      progressOrdinal?: number;
      handoffOrdinal?: number;
    };
  };
}> {
  const result = await runHookProcess(input);
  if (result.exitCode !== 0) throw new Error(result.stderr || `Hook exited with code ${result.exitCode}.`);
  return JSON.parse(result.stdout) as never;
}

function legalEnvelope(hookOutput: {
  hookSpecificOutput: { additionalContext?: string };
}): Record<string, unknown> {
  const context = hookOutput.hookSpecificOutput.additionalContext ?? "";
  return JSON.parse(context
    .replace(/^<legal_coverage_state>\n/u, "")
    .replace(/\n<\/legal_coverage_state>$/u, "")) as Record<string, unknown>;
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
