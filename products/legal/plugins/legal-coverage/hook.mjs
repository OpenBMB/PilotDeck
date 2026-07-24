import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROOF_PATH,
  STATE_DIRECTORY,
  activationMatches,
  ensureWorkspace,
  milestoneDigest,
  milestoneEnvelopeFor,
  milestoneFor,
  nextCoverageBatch,
  resolveSafeWorkspacePath,
  validateWorkspace,
} from "./scripts/lib/legal-coverage.mjs";

const cliPath = fileURLToPath(new URL("./scripts/legal-coverage.mjs", import.meta.url));
let hookEventName = "Unknown";

try {
  let body = "";
  for await (const chunk of process.stdin) body += chunk;
  const input = JSON.parse(body);
  hookEventName = typeof input?.hookEventName === "string" ? input.hookEventName : hookEventName;
  const output = { hookSpecificOutput: { hookEventName } };
  const sessionPath = sessionStatePath(input.sessionId);

  if (input.hookEventName === "UserPromptSubmit" && input.internal !== true) {
    const configured = await hasConfiguredWorkspace(input.cwd);
    const active = configured || activationMatches(String(input.prompt ?? ""));
    if (active) {
      await ensureWorkspace(input.cwd);
      await writeSessionState(input.cwd, sessionPath, { active: true });
      output.hookSpecificOutput.dynamicContext = [{
        id: "legal-coverage-activation",
        priority: "critical",
        ttlMs: 60 * 60 * 1000,
        content: [
          "Legal coverage controls are active for this task.",
          "Load and apply the project skill legal-coverage:conduct-legal-due-diligence before substantive analysis.",
          "Keep legal facts, issue rules, authorities, and coverage mappings under .pilotdeck/work/legal-coverage.",
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
  const active = sessionState?.active === true
    || await pathExists(input.cwd, `${STATE_DIRECTORY}/config.json`)
    || await pathExists(input.cwd, PROOF_PATH);
  if (active && input.hookEventName === "PreModelRequest") {
    const result = await validateWorkspace({ workspaceRoot: input.cwd, writeProof: true });
    const workItems = await dynamicWorkItems(input.cwd, result);
    const digest = milestoneDigest(result, workItems);
    if (sessionState?.lastMilestoneDigest !== digest) {
      output.hookSpecificOutput.additionalContext = milestoneEnvelopeFor(result, cliPath, workItems);
      await writeSessionState(input.cwd, sessionPath, { active: true, lastMilestoneDigest: digest });
    }
    output.hookSpecificOutput.modelRequestPatch = {
      metadata: {
        legalCoverageActive: true,
        legalCoverageState: result.passed ? "validated" : result.errors[0]?.phase ?? "incomplete",
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
    await writeSessionState(input.cwd, sessionPath, { active: true, lastMilestoneDigest: digest });
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
  if (result.errors[0]?.phase !== "coverage") return undefined;
  return nextCoverageBatch(workspaceRoot, { limit: 4, maxSerializedBytes: 2048 });
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
