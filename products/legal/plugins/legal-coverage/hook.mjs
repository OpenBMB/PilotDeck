import { createHash } from "node:crypto";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROOF_PATH,
  STATE_DIRECTORY,
  activationMatches,
  authorityClosurePlan,
  convergenceStateHash,
  ensureWorkspace,
  issueClosurePlan,
  milestoneDigest,
  milestoneEnvelopeFor,
  milestoneFor,
  nextCoverageBatch,
  nextMatrixRelationBatch,
  pendingMatrixPlan,
  pendingSourceReviewPlan,
  resolveSafeWorkspacePath,
  validateWorkspace,
} from "./scripts/lib/legal-coverage.mjs";

const cliPath = fileURLToPath(new URL("./scripts/legal-coverage.mjs", import.meta.url));
const MAX_PROGRESS_CHECKPOINT_DIGESTS = 64;
const MAX_REPAIR_CHECKPOINT_DIGESTS = 64;
const MAX_REPAIR_PREPARATION_CHECKPOINT_DIGESTS = 64;
const MAX_HANDOFF_CHECKPOINT_DIGESTS = 64;
let hookEventName = "Unknown";

try {
  let body = "";
  for await (const chunk of process.stdin) body += chunk;
  const input = JSON.parse(body);
  hookEventName = typeof input?.hookEventName === "string" ? input.hookEventName : hookEventName;
  const output = { hookSpecificOutput: { hookEventName } };
  const sessionPath = sessionStatePath(input.sessionId);
  const isSubagent = input.isSubagent === true;

  if (!isSubagent && input.hookEventName === "UserPromptSubmit" && input.internal !== true) {
    const configured = await hasConfiguredWorkspace(input.cwd);
    const active = configured || activationMatches(String(input.prompt ?? ""));
    if (active) {
      await ensureWorkspace(input.cwd);
      const existingSessionState = await readSessionState(input.cwd, sessionPath);
      await writeSessionState(input.cwd, sessionPath, { ...existingSessionState, active: true });
      output.hookSpecificOutput.dynamicContext = [{
        id: "legal-coverage-activation",
        priority: "critical",
        ttlMs: 60 * 60 * 1000,
        content: [
          "Legal coverage controls are active for this task.",
          "Load and apply the project skill legal-coverage:conduct-legal-due-diligence before substantive analysis.",
          "Keep legal facts, issue rules, authorities, and coverage mappings under .pilotdeck/work/legal-coverage.",
          "When configuration is incomplete, execute the injected initializerCommand and preserve its manifest-bound input option.",
          "When .pilotdeck/input-manifest.json exists, bind sources to its originalRoot and use derivedRoot files only as recorded inspection artifacts.",
          "When the source milestone exposes sourceBootstrapCommand, execute it before manually copying manifest rows.",
          "Use one main-agent writer for canonical ledgers and deliverables; delegated workers may write only disjoint evidence fragments.",
          "The completion proof is generated only by the bundled validator and is required before completion.",
        ].join("\n"),
      }];
      output.hookSpecificOutput.artifactContracts = [{
        id: "legal-coverage-completion-proof",
        path: PROOF_PATH,
        required: true,
        expectedExtensions: [".json"],
        validatorIds: ["core:file-exists"],
        domainId: "legal-due-diligence",
      }];
    }
  }

  const sessionState = await readSessionState(input.cwd, sessionPath);
  const active = !isSubagent && (sessionState?.active === true
    || await pathExists(input.cwd, `${STATE_DIRECTORY}/config.json`)
    || await pathExists(input.cwd, PROOF_PATH));
  if (active && input.hookEventName === "PostToolUse"
    && ["read_file", "write_file"].includes(input.toolName)) {
    const preparation = await advanceRepairPreparation(
      input.cwd,
      sessionState,
      input.toolName,
      input.toolInput,
    );
    if (preparation.changed) {
      await writeSessionState(input.cwd, sessionPath, {
        ...sessionState,
        active: true,
        repairPreparationOrdinal: preparation.ordinal,
        repairPreparationCheckpointDigests: preparation.seenCheckpointDigests,
      });
    }
  }

  if (active && input.hookEventName === "PreModelRequest") {
    const result = await validateWorkspace({ workspaceRoot: input.cwd, writeProof: true });
    const workItems = await dynamicWorkItems(input.cwd, result);
    const digest = milestoneDigest(result, workItems);
    const repairCheckpoint = legalRepairCheckpoint(workItems);
    const repairCheckpointDigest = checkpointDigest(repairCheckpoint);
    const repairTarget = legalRepairTarget(workItems, repairCheckpointDigest);
    const progressState = advanceProgressState(sessionState, digest, {
      phase: result.passed ? "complete" : result.errors[0]?.phase ?? "incomplete",
      blockingCode: result.errors[0]?.code ?? null,
      remainingCount: result.errors.length,
    }, legalProgressCheckpointDigest(workItems), repairCheckpointDigest);
    const handoffState = advanceHandoffState(sessionState, legalHandoffCheckpointDigest(workItems));
    output.hookSpecificOutput.additionalContext = milestoneEnvelopeFor(result, cliPath, workItems);
    if (progressState.changed || handoffState.changed || sessionState?.lastMilestoneDigest !== digest
      || !sameRepairTarget(sessionState?.repairTarget, repairTarget)
    ) {
      await writeSessionState(input.cwd, sessionPath, {
        ...sessionState,
        active: true,
        lastMilestoneDigest: digest,
        progressOrdinal: progressState.ordinal,
        progressCheckpointDigests: progressState.seenCheckpointDigests,
        progressMaxPhaseRank: progressState.maxPhaseRank,
        repairOrdinal: progressState.repairOrdinal,
        repairCheckpointDigests: progressState.seenRepairCheckpointDigests,
        repairTarget,
        handoffOrdinal: handoffState.ordinal,
        handoffCheckpointDigests: handoffState.seenCheckpointDigests,
        progressMilestoneDigests: undefined,
        progressObservation: progressState.observation,
      });
    }
    output.hookSpecificOutput.modelRequestPatch = {
      metadata: {
        legalCoverageActive: true,
        legalCoverageState: result.passed ? "validated" : result.errors[0]?.phase ?? "incomplete",
        pilotdeckConvergence: convergenceReport(
          result,
          workItems,
          convergenceStateHash(result, workItems),
          progressState.ordinal,
          progressState.repairOrdinal,
          repairPreparationOrdinal(sessionState),
          handoffState.ordinal,
        ),
      },
    };
  }

  if (active && input.hookEventName === "PostCompact") {
    const result = await validateWorkspace({ workspaceRoot: input.cwd, writeProof: true });
    const workItems = await dynamicWorkItems(input.cwd, result);
    const digest = milestoneDigest(result, workItems);
    output.hookSpecificOutput.dynamicContext = [{
      id: `legal-coverage-post-compact-${digest.slice(0, 12)}`,
      priority: "critical",
      ttlMs: 60 * 60 * 1000,
      content: milestoneEnvelopeFor(result, cliPath, workItems),
    }];
    await writeSessionState(input.cwd, sessionPath, { ...sessionState, active: true, lastMilestoneDigest: digest });
  }

  if (active && input.hookEventName === "Stop") {
    const result = await validateWorkspace({ workspaceRoot: input.cwd, writeProof: true });
    if (!result.passed) {
      output.continue = false;
      output.stopReason = "legal_coverage_incomplete";
      output.reason = milestoneFor(result, cliPath);
    }
  }

  if (input.hookEventName === "SessionEnd") await removeSessionState(input.cwd, sessionPath);
  console.log(JSON.stringify(output));
} catch (error) {
  const code = errorCode(error);
  const reason = [
    `Legal coverage ${hookEventName} hook failed closed because validator or state I/O did not complete`,
    code ? ` (${code}).` : ".",
    " Completion is blocked until the legal coverage state and validator can be read and written successfully.",
  ].join("");
  console.log(JSON.stringify({
    continue: false,
    stopReason: "legal_coverage_validation_error",
    reason,
    hookSpecificOutput: { hookEventName },
  }));
  console.error(reason);
  process.exitCode = 2;
}

async function hasConfiguredWorkspace(workspaceRoot) {
  try {
    const configPath = await resolveSafeWorkspacePath(workspaceRoot, `${STATE_DIRECTORY}/config.json`, { allowMissing: true });
    const value = await readFile(configPath, "utf8");
    try {
      const config = JSON.parse(value);
      return config && typeof config === "object" && !Array.isArray(config)
        ? config.enabled === true
        : true;
    } catch (error) {
      if (error instanceof SyntaxError) return true;
      throw error;
    }
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function dynamicWorkItems(workspaceRoot, result) {
  const first = result.errors[0];
  if (first?.phase === "sources" && first.code === "source_pending") {
    const plan = await pendingSourceReviewPlan(workspaceRoot, { expectedStateHash: result.stateHash });
    return [
      "delegated",
      "main-agent-merge",
      "main-agent-propose",
      "main-agent-apply",
      "main-agent-repair",
      "main-agent-repair-apply",
    ].includes(plan.mode) ? plan : undefined;
  }
  if (first?.phase === "coverage") {
    return nextCoverageBatch(workspaceRoot, { limit: 4, maxSerializedBytes: 2048, validationResult: result });
  }
  if (first?.phase === "matrices" && first.code === "material_fact_matrix_orphaned") {
    return nextMatrixRelationBatch(workspaceRoot, {
      limit: 12,
      maxSerializedBytes: 8192,
      validationResult: result,
    });
  }
  if (first?.phase === "matrices" && first.code === "matrix_pending") {
    return pendingMatrixPlan(workspaceRoot, { validationResult: result });
  }
  if (first?.phase === "issues" && first.code === "risk_signal_orphaned") {
    return issueClosurePlan(workspaceRoot, { validationResult: result });
  }
  if (first?.phase === "authorities" && first.code === "legal_authority_links_missing") {
    return authorityClosurePlan(workspaceRoot, { validationResult: result });
  }
  return undefined;
}

function convergenceReport(
  result,
  workItems,
  milestoneStateHash,
  progressOrdinal,
  repairOrdinal,
  repairPreparationOrdinal,
  handoffOrdinal,
) {
  const first = result.errors[0];
  return {
    schemaVersion: 1,
    scope: "legal-coverage",
    phase: result.passed ? "complete" : first?.phase ?? "incomplete",
    // The domain projection includes validated operational receipts. Core
    // keeps this identity opaque; only the ordinal or remaining count renews.
    stateHash: milestoneStateHash,
    ...(first?.code ? { blockingCode: first.code } : {}),
    remainingCount: result.errors.length,
    progressOrdinal,
    repairOrdinal,
    repairPreparationOrdinal,
    handoffOrdinal,
    ...(workItems ? {
      nextBatch: {
        group: workItems.group,
        returned: workItems.returned,
        hasMore: workItems.hasMore,
      },
    } : {}),
    writeBudget: {
      maxRecords: workItems?.limits?.maxRecords ?? 12,
      maxSerializedBytes: workItems?.limits?.maxSerializedBytes ?? 24576,
    },
  };
}

function advanceProgressState(sessionState, digest, current, checkpointDigest, repairCheckpointDigest) {
  const ordinal = Number.isSafeInteger(sessionState?.progressOrdinal) && sessionState.progressOrdinal >= 0
    ? sessionState.progressOrdinal
    : 0;
  const seenCheckpointDigests = Array.isArray(sessionState?.progressCheckpointDigests)
    ? sessionState.progressCheckpointDigests.filter((value) =>
        typeof value === "string" && /^[a-f0-9]{64}$/u.test(value)
      ).slice(-MAX_PROGRESS_CHECKPOINT_DIGESTS)
    : [];
  const repairOrdinal = Number.isSafeInteger(sessionState?.repairOrdinal) && sessionState.repairOrdinal >= 0
    ? sessionState.repairOrdinal
    : 0;
  const seenRepairCheckpointDigests = Array.isArray(sessionState?.repairCheckpointDigests)
    ? sessionState.repairCheckpointDigests.filter((value) =>
        typeof value === "string" && /^[a-f0-9]{64}$/u.test(value)
      ).slice(-MAX_REPAIR_CHECKPOINT_DIGESTS)
    : [];
  const previous = parseProgressObservation(sessionState?.progressObservation);
  const observation = { ...current, digest };
  const previousMaxPhaseRank = Number.isSafeInteger(sessionState?.progressMaxPhaseRank)
    && sessionState.progressMaxPhaseRank >= 0
    && sessionState.progressMaxPhaseRank <= legalPhaseRank("complete")
    ? sessionState.progressMaxPhaseRank
    : previous === undefined ? legalPhaseRank(current.phase) : legalPhaseRank(previous.phase);
  const currentPhaseRank = legalPhaseRank(current.phase);
  const maxPhaseRank = Math.max(previousMaxPhaseRank, currentPhaseRank);
  const phaseAdvanced = previous !== undefined && currentPhaseRank > previousMaxPhaseRank;
  const unseenCheckpoint = typeof checkpointDigest === "string"
    && /^[a-f0-9]{64}$/u.test(checkpointDigest)
    && !seenCheckpointDigests.includes(checkpointDigest);
  const advanced = phaseAdvanced || unseenCheckpoint;
  const unseenRepairCheckpoint = typeof repairCheckpointDigest === "string"
    && /^[a-f0-9]{64}$/u.test(repairCheckpointDigest)
    && !seenRepairCheckpointDigests.includes(repairCheckpointDigest);
  return {
    ordinal: advanced && ordinal < Number.MAX_SAFE_INTEGER ? ordinal + 1 : ordinal,
    seenCheckpointDigests: unseenCheckpoint
      ? [...seenCheckpointDigests, checkpointDigest].slice(-MAX_PROGRESS_CHECKPOINT_DIGESTS)
      : seenCheckpointDigests,
    maxPhaseRank,
    repairOrdinal: unseenRepairCheckpoint && repairOrdinal < Number.MAX_SAFE_INTEGER
      ? repairOrdinal + 1
      : repairOrdinal,
    seenRepairCheckpointDigests: unseenRepairCheckpoint
      ? [...seenRepairCheckpointDigests, repairCheckpointDigest].slice(-MAX_REPAIR_CHECKPOINT_DIGESTS)
      : seenRepairCheckpointDigests,
    observation,
    changed: unseenCheckpoint || unseenRepairCheckpoint
      || maxPhaseRank !== previousMaxPhaseRank || previous === undefined
      || previous.phase !== observation.phase
      || previous.blockingCode !== observation.blockingCode
      || previous.remainingCount !== observation.remainingCount,
  };
}

function legalProgressCheckpointDigest(workItems) {
  let checkpoint;
  if (workItems?.appliedSource
    && validStateHash(workItems.appliedSource.stateHash)
    && validStateHash(workItems.appliedSource.proposalSha256)
    && Array.isArray(workItems.appliedSource.sourceIds)) {
    const sourceIds = workItems.appliedSource.sourceIds.filter(nonEmptyString).slice(0, 12).sort();
    if (sourceIds.length === 0 || sourceIds.length !== workItems.appliedSource.sourceIds.length) return undefined;
    checkpoint = {
      kind: "source-fragment-applied",
      stateHash: workItems.appliedSource.stateHash,
      sourceIds,
      proposalSha256: workItems.appliedSource.proposalSha256,
    };
  } else if (workItems?.appliedRepair
    && validStateHash(workItems.appliedRepair.stateHash)
    && validStateHash(workItems.appliedRepair.repairSha256)
    && Array.isArray(workItems.appliedRepair.sourceIds)) {
    const sourceIds = workItems.appliedRepair.sourceIds.filter(nonEmptyString).slice(0, 12).sort();
    if (sourceIds.length === 0 || sourceIds.length !== workItems.appliedRepair.sourceIds.length) return undefined;
    checkpoint = {
      kind: "source-fragment-repair-applied",
      stateHash: workItems.appliedRepair.stateHash,
      sourceIds,
      repairSha256: workItems.appliedRepair.repairSha256,
    };
  } else if (workItems?.group === "matrix-pending-selection-apply"
    && workItems.selection?.validated === true
    && workItems.selection.acceptedSelection?.decision === "finalize"
    && validStateHash(workItems.selection.expectedStateHash)
    && nonEmptyString(workItems.selection.targetMatrixId)) {
    checkpoint = {
      kind: "matrix-pending-selection-finalize",
      expectedStateHash: workItems.selection.expectedStateHash,
      targetMatrixId: workItems.selection.targetMatrixId,
    };
  } else if (workItems?.group === "matrix-pending-apply"
    && workItems.proposal?.validated === true
    && validStateHash(workItems.proposal.expectedStateHash)
    && nonEmptyString(workItems.proposal.targetMatrixId)) {
    checkpoint = {
      kind: "matrix-pending-apply",
      expectedStateHash: workItems.proposal.expectedStateHash,
      targetMatrixId: workItems.proposal.targetMatrixId,
    };
  }
  return checkpointDigest(checkpoint);
}

function legalHandoffCheckpointDigest(workItems) {
  let checkpoint;
  if (workItems?.group === "matrix-pending-selection-apply"
    && workItems.selection?.validated === true
    && workItems.selection.acceptedSelection?.decision === "continue"
    && validStateHash(workItems.selection.expectedStateHash)
    && validStateHash(workItems.selection.evidenceBatchSha256)
    && validStateHash(workItems.selection.selectionSha256)
    && nonEmptyString(workItems.selection.targetMatrixId)) {
    checkpoint = {
      kind: "matrix-selection-continue-apply-ready",
      expectedStateHash: workItems.selection.expectedStateHash,
      targetMatrixId: workItems.selection.targetMatrixId,
      evidenceBatchSha256: workItems.selection.evidenceBatchSha256,
      selectionSha256: workItems.selection.selectionSha256,
    };
  } else if (workItems?.group === "matrix-pending-selection"
    && workItems.selection?.validationError === undefined
    && validStateHash(workItems.selection?.expectedStateHash)
    && validStateHash(workItems.selection?.evidenceBatchSha256)
    && nonEmptyString(workItems.selection?.targetMatrixId)
    && Number.isSafeInteger(workItems.evidencePage?.offset)
    && workItems.evidencePage.offset > 0
    && typeof workItems.selection?.path === "string"
    && workItems.selection.path.length > 0
    && workItems.selection.path.length <= 2048) {
    checkpoint = {
      kind: "matrix-selection-next-evidence-page",
      expectedStateHash: workItems.selection.expectedStateHash,
      targetMatrixId: workItems.selection.targetMatrixId,
      offset: workItems.evidencePage.offset,
      evidenceBatchSha256: workItems.selection.evidenceBatchSha256,
      selectionPath: workItems.selection.path,
    };
  } else if (workItems?.group === "authority-closure-apply"
    && workItems.proposal?.validated === true
    && validStateHash(workItems.proposal.expectedStateHash)
    && validStateHash(workItems.proposal.proposalSha256)
    && nonEmptyString(workItems.proposal.targetEntryId)) {
    checkpoint = {
      kind: "authority-closure-apply-ready",
      expectedStateHash: workItems.proposal.expectedStateHash,
      targetEntryId: workItems.proposal.targetEntryId,
      proposalSha256: workItems.proposal.proposalSha256,
    };
  } else if (workItems?.group === "issue-closure-apply"
    && workItems.proposal?.validated === true
    && validStateHash(workItems.proposal.expectedStateHash)
    && validStateHash(workItems.proposal.proposalSha256)
    && nonEmptyString(workItems.proposal.targetMatrixId)
    && nonEmptyString(workItems.proposal.targetEntryId)) {
    checkpoint = {
      kind: "issue-closure-apply-ready",
      expectedStateHash: workItems.proposal.expectedStateHash,
      targetMatrixId: workItems.proposal.targetMatrixId,
      targetEntryId: workItems.proposal.targetEntryId,
      proposalSha256: workItems.proposal.proposalSha256,
    };
  } else if (workItems?.group === "source-fragment-apply"
    && workItems.proposal?.validated === true
    && validStateHash(workItems.proposal.expectedStateHash)
    && validStateHash(workItems.proposal.proposalSha256)
    && Array.isArray(workItems.proposal.sourceIds)) {
    const sourceIds = workItems.proposal.sourceIds.filter(nonEmptyString).slice(0, 12).sort();
    if (sourceIds.length === 0
      || sourceIds.length !== workItems.proposal.sourceIds.length
      || new Set(sourceIds).size !== sourceIds.length) return undefined;
    checkpoint = {
      kind: "source-fragment-apply-ready",
      expectedStateHash: workItems.proposal.expectedStateHash,
      proposalSha256: workItems.proposal.proposalSha256,
      sourceIds,
    };
  }
  return checkpointDigest(checkpoint);
}

function advanceHandoffState(sessionState, checkpoint) {
  const ordinal = Number.isSafeInteger(sessionState?.handoffOrdinal) && sessionState.handoffOrdinal >= 0
    ? sessionState.handoffOrdinal
    : 0;
  const seenCheckpointDigests = Array.isArray(sessionState?.handoffCheckpointDigests)
    ? sessionState.handoffCheckpointDigests.filter(validStateHash).slice(-MAX_HANDOFF_CHECKPOINT_DIGESTS)
    : [];
  const unseenCheckpoint = validStateHash(checkpoint) && !seenCheckpointDigests.includes(checkpoint);
  return {
    ordinal: unseenCheckpoint && ordinal < Number.MAX_SAFE_INTEGER ? ordinal + 1 : ordinal,
    seenCheckpointDigests: unseenCheckpoint
      ? [...seenCheckpointDigests, checkpoint].slice(-MAX_HANDOFF_CHECKPOINT_DIGESTS)
      : seenCheckpointDigests,
    changed: unseenCheckpoint,
  };
}

function legalRepairCheckpoint(workItems) {
  let checkpoint;
  if (workItems?.group === "source-fragment-repair"
    && hasRepairFeedback(workItems.repair)
    && validStateHash(workItems.repair.expectedStateHash)
    && validStateHash(workItems.repair.proposalSha256)
    && validStateHash(workItems.repair.diagnosticSha256)
    && Array.isArray(workItems.repair.sourceIds)) {
    const sourceIds = workItems.repair.sourceIds.filter(nonEmptyString).slice(0, 12).sort();
    if (sourceIds.length === 0 || sourceIds.length !== workItems.repair.sourceIds.length) return undefined;
    checkpoint = {
      kind: "source-fragment-immutable-repair",
      expectedStateHash: workItems.repair.expectedStateHash,
      proposalSha256: workItems.repair.proposalSha256,
      diagnosticSha256: workItems.repair.diagnosticSha256,
      sourceIds,
    };
  } else if (workItems?.group === "source-fragment-propose"
    && hasRepairFeedback(workItems.proposal)
    && validStateHash(workItems.proposal.expectedStateHash)
    && Array.isArray(workItems.proposal.sourceIds)) {
    const sourceIds = workItems.proposal.sourceIds.filter(nonEmptyString).slice(0, 12).sort();
    if (sourceIds.length === 0 || sourceIds.length !== workItems.proposal.sourceIds.length) return undefined;
    checkpoint = {
      kind: "source-fragment-repair",
      expectedStateHash: workItems.proposal.expectedStateHash,
      sourceIds,
    };
  } else if (workItems?.group === "matrix-pending-selection"
    && hasRepairFeedback(workItems.selection)
    && validStateHash(workItems.selection.expectedStateHash)
    && nonEmptyString(workItems.selection.targetMatrixId)) {
    checkpoint = {
      kind: "matrix-pending-selection-repair",
      expectedStateHash: workItems.selection.expectedStateHash,
      targetMatrixId: workItems.selection.targetMatrixId,
    };
  } else if (workItems?.group === "matrix-pending-propose"
    && hasRepairFeedback(workItems.proposal)
    && validStateHash(workItems.proposal.expectedStateHash)
    && nonEmptyString(workItems.proposal.targetMatrixId)) {
    checkpoint = {
      kind: "matrix-pending-proposal-repair",
      expectedStateHash: workItems.proposal.expectedStateHash,
      targetMatrixId: workItems.proposal.targetMatrixId,
    };
  } else if (workItems?.group === "authority-closure-propose"
    && hasRepairFeedback(workItems.proposal)
    && validStateHash(workItems.proposal.expectedStateHash)
    && nonEmptyString(workItems.proposal.targetEntryId)) {
    checkpoint = {
      kind: "authority-closure-repair",
      expectedStateHash: workItems.proposal.expectedStateHash,
      targetEntryId: workItems.proposal.targetEntryId,
    };
  }
  return checkpoint;
}

function legalRepairTarget(workItems, repairDigest) {
  if (!validStateHash(repairDigest)) return undefined;
  let path;
  let preparationTool = "read_file";
  if (workItems?.group === "source-fragment-repair" && hasRepairFeedback(workItems.repair)) {
    path = workItems.repair?.path;
    preparationTool = "write_file";
  } else if (workItems?.group === "source-fragment-propose" && hasRepairFeedback(workItems.proposal)) {
    path = workItems.proposal?.path;
  } else if (workItems?.group === "matrix-pending-selection" && hasRepairFeedback(workItems.selection)) {
    path = workItems.selection?.path;
  } else if (workItems?.group === "matrix-pending-propose" && hasRepairFeedback(workItems.proposal)) {
    path = workItems.proposal?.path;
  } else if (workItems?.group === "authority-closure-propose" && hasRepairFeedback(workItems.proposal)) {
    path = workItems.proposal?.path;
  }
  if (typeof path !== "string" || path.length === 0 || path.length > 2048) return undefined;
  return { repairDigest, path, preparationTool };
}

async function advanceRepairPreparation(workspaceRoot, sessionState, toolName, toolInput) {
  const ordinal = repairPreparationOrdinal(sessionState);
  const seenCheckpointDigests = Array.isArray(sessionState?.repairPreparationCheckpointDigests)
    ? sessionState.repairPreparationCheckpointDigests.filter(validStateHash)
      .slice(-MAX_REPAIR_PREPARATION_CHECKPOINT_DIGESTS)
    : [];
  const target = parseRepairTarget(sessionState?.repairTarget);
  const inputPath = toolInput && typeof toolInput === "object" && !Array.isArray(toolInput)
    ? toolInput.file_path
    : undefined;
  if (!target || toolName !== target.preparationTool
    || typeof inputPath !== "string" || inputPath.length === 0 || inputPath.length > 2048) {
    return { ordinal, seenCheckpointDigests, changed: false };
  }
  const targetPath = await resolveSafeWorkspacePath(workspaceRoot, target.path, { allowMissing: true });
  const readPath = await resolveSafeWorkspacePath(workspaceRoot, inputPath, { allowMissing: true });
  if (targetPath !== readPath) return { ordinal, seenCheckpointDigests, changed: false };
  if (toolName === "write_file") {
    let info;
    try {
      info = await stat(targetPath);
    } catch (error) {
      if (error?.code === "ENOENT") return { ordinal, seenCheckpointDigests, changed: false };
      throw error;
    }
    if (!info.isFile() || info.size <= 0 || info.size > 24576) {
      return { ordinal, seenCheckpointDigests, changed: false };
    }
    const result = await validateWorkspace({ workspaceRoot, writeProof: false });
    const workItems = await dynamicWorkItems(workspaceRoot, result);
    if (workItems?.group !== "source-fragment-repair-apply"
      || workItems.repair?.validated !== true
      || workItems.repair.path !== target.path) {
      return { ordinal, seenCheckpointDigests, changed: false };
    }
  }
  const preparationDigest = checkpointDigest({
    kind: `repair-target-${toolName === "write_file" ? "write" : "read"}`,
    repairDigest: target.repairDigest,
  });
  if (!preparationDigest || seenCheckpointDigests.includes(preparationDigest)) {
    return { ordinal, seenCheckpointDigests, changed: false };
  }
  return {
    ordinal: ordinal < Number.MAX_SAFE_INTEGER ? ordinal + 1 : ordinal,
    seenCheckpointDigests: [...seenCheckpointDigests, preparationDigest]
      .slice(-MAX_REPAIR_PREPARATION_CHECKPOINT_DIGESTS),
    changed: true,
  };
}

function repairPreparationOrdinal(sessionState) {
  return Number.isSafeInteger(sessionState?.repairPreparationOrdinal)
    && sessionState.repairPreparationOrdinal >= 0
    ? sessionState.repairPreparationOrdinal
    : 0;
}

function parseRepairTarget(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  if (!validStateHash(value.repairDigest)) return undefined;
  if (typeof value.path !== "string" || value.path.length === 0 || value.path.length > 2048) return undefined;
  const preparationTool = value.preparationTool === "write_file" ? "write_file" : "read_file";
  return { repairDigest: value.repairDigest, path: value.path, preparationTool };
}

function sameRepairTarget(left, right) {
  const parsedLeft = parseRepairTarget(left);
  const parsedRight = parseRepairTarget(right);
  if (!parsedLeft || !parsedRight) return parsedLeft === undefined && parsedRight === undefined;
  return parsedLeft.repairDigest === parsedRight.repairDigest
    && parsedLeft.path === parsedRight.path
    && parsedLeft.preparationTool === parsedRight.preparationTool;
}

function hasRepairFeedback(value) {
  return value?.repairRequired === true
    || nonEmptyString(value?.validationError?.code)
    || (Number.isSafeInteger(value?.validationDiagnostics?.total) && value.validationDiagnostics.total > 0);
}

function checkpointDigest(checkpoint) {
  return checkpoint === undefined
    ? undefined
    : createHash("sha256").update(JSON.stringify(checkpoint)).digest("hex");
}

function validStateHash(value) {
  return typeof value === "string" && /^[a-f0-9]{64}$/u.test(value);
}

function nonEmptyString(value) {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
}

function parseProgressObservation(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  if (typeof value.phase !== "string" || value.phase.length === 0 || value.phase.length > 128) return undefined;
  if (value.blockingCode !== null && (typeof value.blockingCode !== "string" || value.blockingCode.length > 256)) return undefined;
  if (!Number.isSafeInteger(value.remainingCount) || value.remainingCount < 0) return undefined;
  if (typeof value.digest !== "string" || !/^[a-f0-9]{64}$/u.test(value.digest)) return undefined;
  return {
    phase: value.phase,
    blockingCode: value.blockingCode,
    remainingCount: value.remainingCount,
    digest: value.digest,
  };
}

function legalPhaseRank(phase) {
  return {
    incomplete: 0,
    configuration: 0,
    sources: 1,
    facts: 2,
    matrices: 3,
    issues: 4,
    authorities: 5,
    coverage: 6,
    complete: 7,
  }[phase] ?? 0;
}

async function writeSessionState(workspaceRoot, candidate, value) {
  const path = await resolveSafeWorkspacePath(workspaceRoot, candidate, { allowMissing: true });
  await mkdir(dirname(path), { recursive: true });
  const checkedPath = await resolveSafeWorkspacePath(workspaceRoot, candidate, { allowMissing: true });
  await writeFile(checkedPath, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

async function readSessionState(workspaceRoot, candidate) {
  try {
    const path = await resolveSafeWorkspacePath(workspaceRoot, candidate, { allowMissing: true });
    const value = JSON.parse(await readFile(path, "utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : undefined;
  } catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
}

function sessionStatePath(sessionId) {
  const safe = String(sessionId ?? "unknown").normalize("NFKC").replace(/[^a-zA-Z0-9._-]+/gu, "-").slice(0, 96) || "unknown";
  return `${STATE_DIRECTORY}/sessions/${safe}.json`;
}

async function pathExists(workspaceRoot, candidate) {
  try {
    const path = await resolveSafeWorkspacePath(workspaceRoot, candidate, { allowMissing: true });
    await stat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

async function removeSessionState(workspaceRoot, candidate) {
  const path = await resolveSafeWorkspacePath(workspaceRoot, candidate, { allowMissing: true });
  await rm(path, { force: true });
}

function isMissing(error) {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

function errorCode(error) {
  if (!(error instanceof Error) || !("code" in error) || typeof error.code !== "string") return undefined;
  return /^[A-Z0-9_]{1,32}$/u.test(error.code) ? error.code : undefined;
}
