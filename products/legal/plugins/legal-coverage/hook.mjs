import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  PROOF_PATH,
  activationMatches,
  ensureWorkspace,
  milestoneFor,
  validateWorkspace,
} from "./scripts/lib/legal-coverage.mjs";

let body = "";
for await (const chunk of process.stdin) body += chunk;
const input = JSON.parse(body);
const output = { hookSpecificOutput: { hookEventName: input.hookEventName } };
const sessionFile = sessionStatePath(input.cwd, input.sessionId);
const cliPath = fileURLToPath(new URL("./scripts/legal-coverage.mjs", import.meta.url));

if (input.hookEventName === "UserPromptSubmit" && input.internal !== true) {
  const configured = await hasConfiguredWorkspace(input.cwd);
  const active = configured || activationMatches(String(input.prompt ?? ""));
  if (active) {
    await ensureWorkspace(input.cwd);
    await writeSessionState(sessionFile, { active: true });
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

const active = await readSessionState(sessionFile)
  || await pathExists(`${input.cwd}/.pilotdeck/work/legal-coverage/config.json`)
  || await pathExists(`${input.cwd}/${PROOF_PATH}`);
if (active && input.hookEventName === "PreModelRequest") {
  const result = await validateWorkspace({ workspaceRoot: input.cwd, writeProof: true });
  output.hookSpecificOutput.additionalContext = milestoneFor(result, cliPath);
  output.hookSpecificOutput.modelRequestPatch = {
    metadata: {
      legalCoverageActive: true,
      legalCoverageState: result.passed ? "validated" : result.errors[0]?.phase ?? "incomplete",
    },
  };
}

if (active && input.hookEventName === "Stop") {
  const result = await validateWorkspace({ workspaceRoot: input.cwd, writeProof: true });
  if (!result.passed) {
    output.continue = false;
    output.stopReason = "legal_coverage_incomplete";
    output.reason = milestoneFor(result, cliPath);
  }
}

if (input.hookEventName === "SessionEnd") await rm(sessionFile, { force: true });
console.log(JSON.stringify(output));

async function hasConfiguredWorkspace(workspaceRoot) {
  try {
    const config = JSON.parse(await readFile(`${workspaceRoot}/.pilotdeck/work/legal-coverage/config.json`, "utf8"));
    return config?.enabled === true;
  } catch {
    return false;
  }
}

async function writeSessionState(path, value) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(value)}\n`, { mode: 0o600 });
}

async function readSessionState(path) {
  try {
    const value = JSON.parse(await readFile(path, "utf8"));
    return value?.active === true;
  } catch {
    return false;
  }
}

function sessionStatePath(workspaceRoot, sessionId) {
  const safe = String(sessionId ?? "unknown").normalize("NFKC").replace(/[^a-zA-Z0-9._-]+/gu, "-").slice(0, 96) || "unknown";
  return `${workspaceRoot}/.pilotdeck/work/legal-coverage/sessions/${safe}.json`;
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
