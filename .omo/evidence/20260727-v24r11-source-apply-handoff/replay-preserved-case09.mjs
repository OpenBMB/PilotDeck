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

const workspace = await mkdtemp(join(tmpdir(), "pilotdeck-v24r11-case09-replay-"));
const pluginRoot = join(workspace, ".pilotdeck", "plugins", "legal-coverage");
const candidatePlugin = join(candidateRoot, "products", "legal", "plugins", "legal-coverage");
const hook = join(pluginRoot, "hook.mjs");

try {
  await cp(sourceRun, workspace, { recursive: true });
  await rm(pluginRoot, { recursive: true, force: true });
  await cp(candidatePlugin, pluginRoot, { recursive: true });

  const inputHashBefore = await treeHash(join(workspace, ".pilotdeck", "inputs"));
  const inspection = await runHook({
    hookEventName: "PreModelRequest",
    sessionId: "v24r11-case09-inspection",
    transcriptPath: "",
    cwd: workspace,
  });
  const inspectionEnvelope = legalEnvelope(inspection);
  assert.equal(inspectionEnvelope.workItems.group, "source-fragment-apply");
  assert.equal(inspectionEnvelope.workItems.proposal.validated, true);
  assert.match(inspectionEnvelope.sourceMergeApplyCommand, /source-merge-apply/u);

  const proposalRelativePath = inspectionEnvelope.workItems.proposal.path;
  const proposalPath = join(workspace, proposalRelativePath);
  const proposalBytes = await readFile(proposalPath);
  const proposalSha256 = sha256(proposalBytes);
  assert.equal(proposalSha256, inspectionEnvelope.workItems.proposal.proposalSha256);
  await rm(proposalPath);

  const sessionId = "v24r11-preserved-case09-source-handoff";
  const baseline = await runHook({
    hookEventName: "PreModelRequest",
    sessionId,
    transcriptPath: "",
    cwd: workspace,
  });
  assert.equal(legalEnvelope(baseline).workItems.group, "source-fragment-propose");
  const baselineConvergence = convergence(baseline);

  await writeFile(proposalPath, proposalBytes);
  const applyReady = await runHook({
    hookEventName: "PreModelRequest",
    sessionId,
    transcriptPath: "",
    cwd: workspace,
  });
  const applyEnvelope = legalEnvelope(applyReady);
  const applyConvergence = convergence(applyReady);
  assert.equal(applyEnvelope.workItems.group, "source-fragment-apply");
  assert.equal(applyEnvelope.workItems.proposal.validated, true);
  assert.equal(applyConvergence.progressOrdinal, baselineConvergence.progressOrdinal);
  assert.equal(applyConvergence.handoffOrdinal, baselineConvergence.handoffOrdinal + 1);
  assert.equal(applyEnvelope.sourceMergeApplyCommand, inspectionEnvelope.sourceMergeApplyCommand);

  const replayReady = await runHook({
    hookEventName: "PreModelRequest",
    sessionId,
    transcriptPath: "",
    cwd: workspace,
  });
  assert.equal(convergence(replayReady).progressOrdinal, applyConvergence.progressOrdinal);
  assert.equal(convergence(replayReady).handoffOrdinal, applyConvergence.handoffOrdinal);
  assert.equal(legalEnvelope(replayReady).sourceMergeApplyCommand, applyEnvelope.sourceMergeApplyCommand);

  const applied = await execFileAsync("/bin/zsh", ["-lc", applyEnvelope.sourceMergeApplyCommand], {
    cwd: workspace,
    encoding: "utf8",
  });
  const appliedResult = JSON.parse(applied.stdout);
  assert.equal(appliedResult.applied, true);

  const afterApply = await runHook({
    hookEventName: "PreModelRequest",
    sessionId,
    transcriptPath: "",
    cwd: workspace,
  });
  const afterEnvelope = legalEnvelope(afterApply);
  const afterConvergence = convergence(afterApply);
  assert.ok(afterEnvelope.workItems.appliedSource);
  assert.equal(afterConvergence.progressOrdinal, applyConvergence.progressOrdinal + 1);
  assert.equal(afterConvergence.handoffOrdinal, applyConvergence.handoffOrdinal);

  const replayApplied = await runHook({
    hookEventName: "PreModelRequest",
    sessionId,
    transcriptPath: "",
    cwd: workspace,
  });
  const replayAppliedConvergence = convergence(replayApplied);
  assert.equal(replayAppliedConvergence.progressOrdinal, afterConvergence.progressOrdinal);
  assert.equal(replayAppliedConvergence.handoffOrdinal, afterConvergence.handoffOrdinal);
  assert.equal(sha256(await readFile(proposalPath)), proposalSha256);
  const inputHashAfter = await treeHash(join(workspace, ".pilotdeck", "inputs"));
  assert.equal(inputHashAfter, inputHashBefore);

  const result = {
    passed: true,
    fixture: "preserved-v24r10-case09-valid-source-proposal",
    proposal: basename(proposalRelativePath),
    proposalBytes: proposalBytes.byteLength,
    proposalSha256,
    sourceIds: applyEnvelope.workItems.proposal.sourceIds,
    handoffOrdinal: [
      baselineConvergence.handoffOrdinal,
      applyConvergence.handoffOrdinal,
      convergence(replayReady).handoffOrdinal,
      afterConvergence.handoffOrdinal,
      replayAppliedConvergence.handoffOrdinal,
    ],
    progressOrdinal: [
      baselineConvergence.progressOrdinal,
      applyConvergence.progressOrdinal,
      convergence(replayReady).progressOrdinal,
      afterConvergence.progressOrdinal,
      replayAppliedConvergence.progressOrdinal,
    ],
    appliedSourceCount: appliedResult.sourceCount,
    appliedFactCount: appliedResult.factCount,
    stateHashBefore: applyEnvelope.workItems.proposal.expectedStateHash,
    stateHashAfter: appliedResult.stateHash,
    durableReceipt: basename(afterEnvelope.workItems.appliedSource.path),
    nextGroup: afterEnvelope.workItems.group,
    inputTreeSha256: inputHashAfter,
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

async function treeHash(root) {
  const entries = [];
  async function visit(directory, prefix = "") {
    for (const entry of (await readdir(directory, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const relativePath = prefix ? `${prefix}/${entry.name}` : entry.name;
      const absolutePath = join(directory, entry.name);
      if (entry.isDirectory()) await visit(absolutePath, relativePath);
      else if (entry.isFile()) entries.push([relativePath, sha256(await readFile(absolutePath))]);
    }
  }
  await visit(root);
  return sha256(Buffer.from(JSON.stringify(entries)));
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
