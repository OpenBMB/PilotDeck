import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const sourceRun = resolve(process.argv[2] ?? "");
const candidateRoot = resolve(process.argv[3] ?? "");
const outputPath = resolve(process.argv[4] ?? "");

assert.ok(process.argv[2] && process.argv[3] && process.argv[4],
  "usage: replay-preserved-case09.mjs <preserved-workspace> <candidate-root> <output-json>");

const workspace = await mkdtemp(join(tmpdir(), "pilotdeck-v24r10-case09-replay-"));
const stateRoot = join(workspace, ".pilotdeck", "work", "legal-coverage");
const fragmentRoot = join(stateRoot, "fragments");
const pluginRoot = join(workspace, ".pilotdeck", "plugins", "legal-coverage");
const candidatePlugin = join(candidateRoot, "products", "legal", "plugins", "legal-coverage");
const cli = join(pluginRoot, "scripts", "legal-coverage.mjs");
const hook = join(pluginRoot, "hook.mjs");

try {
  await cp(sourceRun, workspace, { recursive: true });
  await rm(pluginRoot, { recursive: true, force: true });
  await cp(candidatePlugin, pluginRoot, { recursive: true });

  const repairName = (await readdir(fragmentRoot))
    .find((name) => /^source-repair-[a-f0-9]{12}\.json$/u.test(name));
  assert.ok(repairName, "preserved failed run must contain the rejected immutable repair");
  const repairRelativePath = `.pilotdeck/work/legal-coverage/fragments/${repairName}`;
  const repairPath = join(fragmentRoot, repairName);

  const invalidSessionId = "v24r10-case09-invalid-repair-replay";
  await runHook({
    hookEventName: "PreModelRequest",
    sessionId: invalidSessionId,
    transcriptPath: "",
    cwd: workspace,
  });
  await runHook({
    hookEventName: "PostToolUse",
    sessionId: invalidSessionId,
    transcriptPath: "",
    cwd: workspace,
    toolName: "write_file",
    toolInput: { file_path: repairRelativePath },
    toolUseId: "preserved-invalid-repair-write",
  });
  const afterInvalidWrite = await runHook({
    hookEventName: "PreModelRequest",
    sessionId: invalidSessionId,
    transcriptPath: "",
    cwd: workspace,
  });
  assert.equal(convergence(afterInvalidWrite).repairPreparationOrdinal, 0,
    "invalid preserved repair must not advance preparation");

  await rm(repairPath);
  const sessionId = "v24r10-case09-valid-repair-replay";
  const rejected = await runHook({
    hookEventName: "PreModelRequest",
    sessionId,
    transcriptPath: "",
    cwd: workspace,
  });
  const repairPlan = legalEnvelope(rejected).workItems.repair;
  const template = structuredClone(repairPlan.template);
  const evidenceOperation = template.operations.find((operation) => operation.factNumber === 5);
  const expenseOperation = template.operations.find((operation) => operation.factNumber === 11);
  assert.equal(evidenceOperation?.fact?.evidenceClass, "official-record");
  assert.equal(expenseOperation?.fact?.evidenceClass, "company-disclosure");

  const locatorOperation = template.operations.find((operation) => operation.factNumber === 9);
  assert.ok(locatorOperation?.fact?.sourceRefs?.[0]);
  const sourceContext = repairPlan.repairSlice.sourceContext.find(
    (source) => source.sourceId === locatorOperation.fact.sourceRefs[0].sourceId,
  );
  const exactLocator = sourceContext?.allowedFragmentFacts.find(
    (fact) => fact.locator.includes("line 9-10"),
  )?.locator;
  assert.ok(exactLocator, "preserved repair context must include the exact bounded locator");
  locatorOperation.fact.sourceRefs[0].locator = exactLocator;
  await writeJson(repairPath, template);

  await runHook({
    hookEventName: "PostToolUse",
    sessionId,
    transcriptPath: "",
    cwd: workspace,
    toolName: "write_file",
    toolInput: { file_path: repairRelativePath },
    toolUseId: "preserved-valid-repair-write",
  });
  const applyReady = await runHook({
    hookEventName: "PreModelRequest",
    sessionId,
    transcriptPath: "",
    cwd: workspace,
  });
  const applyEnvelope = legalEnvelope(applyReady);
  const beforeProgress = convergence(applyReady).progressOrdinal;
  assert.equal(convergence(applyReady).repairPreparationOrdinal, 1);
  assert.equal(applyEnvelope.workItems.group, "source-fragment-repair-apply");
  assert.equal(applyEnvelope.workItems.repair.validated, true);
  assert.match(applyEnvelope.sourceMergeRepairApplyCommand, /source-repair-apply/u);

  const applied = await execFileAsync(process.execPath, [
    cli,
    "source-repair-apply",
    "--workspace", workspace,
    "--input-file", applyEnvelope.workItems.repair.path,
    "--repair-sha256", applyEnvelope.workItems.repair.repairSha256,
  ], { encoding: "utf8" });
  const appliedResult = JSON.parse(applied.stdout);
  assert.equal(appliedResult.applied, true);

  const afterApply = await runHook({
    hookEventName: "PreModelRequest",
    sessionId,
    transcriptPath: "",
    cwd: workspace,
  });
  const afterEnvelope = legalEnvelope(afterApply);
  const afterProgress = convergence(afterApply).progressOrdinal;
  assert.ok(afterEnvelope.workItems.appliedRepair);
  assert.equal(afterProgress, beforeProgress + 1);

  const replay = await runHook({
    hookEventName: "PreModelRequest",
    sessionId,
    transcriptPath: "",
    cwd: workspace,
  });
  const replayProgress = convergence(replay).progressOrdinal;
  assert.equal(replayProgress, afterProgress);

  const sources = JSON.parse(await readFile(join(stateRoot, "sources.json"), "utf8"));
  const facts = JSON.parse(await readFile(join(stateRoot, "facts.json"), "utf8"));
  const appliedReceipt = afterEnvelope.workItems.appliedRepair.path;
  const result = {
    passed: true,
    fixture: "preserved-v24r9-case09-invalid-repair",
    rejectedRepair: basename(repairName),
    appliedReceipt: basename(appliedReceipt),
    invalidRepairPreparationOrdinal: convergence(afterInvalidWrite).repairPreparationOrdinal,
    validRepairPreparationOrdinal: convergence(applyReady).repairPreparationOrdinal,
    progressOrdinal: [beforeProgress, afterProgress, replayProgress],
    appliedSourceCount: appliedResult.sourceCount,
    appliedFactCount: appliedResult.factCount,
    reviewedSources: sources.sources.filter((source) => source.status === "reviewed").length,
    pendingSources: sources.sources.filter((source) => source.status === "pending").length,
    totalFacts: facts.facts.length,
    stateHashAfter: appliedResult.stateHash,
    repairSha256: sha256(await readFile(repairPath)),
    nextGroup: afterEnvelope.workItems.group,
  };
  await mkdir(resolve(outputPath, ".."), { recursive: true });
  await writeJson(outputPath, result);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  await rm(workspace, { recursive: true, force: true });
}

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function legalEnvelope(output) {
  return JSON.parse((output.hookSpecificOutput.additionalContext ?? "")
    .replace(/^<legal_coverage_state>\n/u, "")
    .replace(/\n<\/legal_coverage_state>$/u, ""));
}

function convergence(output) {
  return output.hookSpecificOutput.modelRequestPatch.metadata.pilotdeckConvergence;
}

async function runHook(input) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [hook], { stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) reject(new Error(stderr || `hook exited with code ${code}`));
      else resolvePromise(JSON.parse(stdout));
    });
    child.stdin.end(JSON.stringify(input));
  });
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
