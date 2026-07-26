import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROOF_PATH,
  STATE_DIRECTORY,
  activationMatches,
  convergenceStateHash,
  ensureWorkspace,
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
const MAX_PROGRESS_MILESTONE_DIGESTS = 64;
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
  if (active && input.hookEventName === "PreModelRequest") {
    const result = await validateWorkspace({ workspaceRoot: input.cwd, writeProof: true });
    const workItems = await dynamicWorkItems(input.cwd, result);
    const digest = milestoneDigest(result, workItems);
    const progressState = advanceProgressState(sessionState, digest, {
      phase: result.passed ? "complete" : result.errors[0]?.phase ?? "incomplete",
      blockingCode: result.errors[0]?.code ?? null,
      remainingCount: result.errors.length,
    });
    output.hookSpecificOutput.additionalContext = milestoneEnvelopeFor(result, cliPath, workItems);
    if (progressState.changed || sessionState?.lastMilestoneDigest !== digest) {
      await writeSessionState(input.cwd, sessionPath, {
        ...sessionState,
        active: true,
        lastMilestoneDigest: digest,
        progressOrdinal: progressState.ordinal,
        progressMilestoneDigests: progressState.seenDigests,
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
    return ["delegated", "main-agent-merge", "main-agent-propose", "main-agent-apply"].includes(plan.mode) ? plan : undefined;
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
  return undefined;
}

function convergenceReport(result, workItems, milestoneStateHash, progressOrdinal) {
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

function advanceProgressState(sessionState, digest, current) {
  const ordinal = Number.isSafeInteger(sessionState?.progressOrdinal) && sessionState.progressOrdinal >= 0
    ? sessionState.progressOrdinal
    : 0;
  const seenDigests = Array.isArray(sessionState?.progressMilestoneDigests)
    ? sessionState.progressMilestoneDigests.filter((value) =>
        typeof value === "string" && /^[a-f0-9]{64}$/u.test(value)
      ).slice(-MAX_PROGRESS_MILESTONE_DIGESTS)
    : [];
  const previous = parseProgressObservation(sessionState?.progressObservation);
  const observation = { ...current, digest };
  const unseen = !seenDigests.includes(digest);
  const advanced = unseen && previous !== undefined && isForwardLegalProgress(previous, observation);
  return {
    ordinal: advanced && ordinal < Number.MAX_SAFE_INTEGER ? ordinal + 1 : ordinal,
    seenDigests: unseen
      ? [...seenDigests, digest].slice(-MAX_PROGRESS_MILESTONE_DIGESTS)
      : seenDigests,
    observation,
    changed: unseen || previous === undefined
      || previous.phase !== observation.phase
      || previous.blockingCode !== observation.blockingCode
      || previous.remainingCount !== observation.remainingCount,
  };
}

function isForwardLegalProgress(previous, current) {
  const previousPhase = legalPhaseRank(previous.phase);
  const currentPhase = legalPhaseRank(current.phase);
  if (currentPhase < previousPhase) return false;
  if (currentPhase > previousPhase) return true;
  if (current.remainingCount > previous.remainingCount) return false;
  if (current.remainingCount < previous.remainingCount) return true;
  return current.digest !== previous.digest;
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
