import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { cp, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const sourceRun = resolve(process.argv[2] ?? "");
const candidateRoot = resolve(process.argv[3] ?? "");
const outputPath = resolve(process.argv[4] ?? "");

assert.ok(process.argv[2] && process.argv[3] && process.argv[4],
  "usage: project-preserved-case09-repair.mjs <preserved-run> <candidate-root> <output-json>");
assert.equal(
  sha256(await readFile(join(sourceRun, "run_summary.json"))),
  "e6cf59642dcbf882c68aa5f435437e905bafe13674f6397786ba4b8893a1d3b2",
  "the preserved V24R11 run changed",
);

const workspace = await mkdtemp(join(tmpdir(), "pilotdeck-v24r12-case09-repair-"));
const pluginRoot = join(workspace, ".pilotdeck", "plugins", "legal-coverage");
const candidatePlugin = join(candidateRoot, "products", "legal", "plugins", "legal-coverage");
const cliPath = join(pluginRoot, "scripts", "legal-coverage.mjs");
const originalReceipt = join(
  sourceRun,
  ".pilotdeck/work/legal-coverage/fragments/source-repair-applied-cb249643d05a.json",
);

assert.equal(await exists(originalReceipt), false);
try {
  await cp(sourceRun, workspace, { recursive: true });
  await rm(pluginRoot, { recursive: true, force: true });
  await cp(candidatePlugin, pluginRoot, { recursive: true });

  const legal = await import(pathToFileURL(join(pluginRoot, "scripts", "lib", "legal-coverage.mjs")).href);
  const inputTreeSha256Before = await treeHash(join(workspace, ".pilotdeck", "inputs"));
  const before = await legal.validateWorkspace({ workspaceRoot: workspace, writeProof: false });
  const plan = await legal.pendingSourceReviewPlan(workspace, { expectedStateHash: before.stateHash });
  assert.equal(plan.group, "source-fragment-repair-apply");
  assert.equal(plan.mode, "main-agent-repair-apply");
  assert.equal(plan.repair.validated, true);

  const repairBytes = await readFile(join(workspace, plan.repair.path));
  assert.equal(sha256(repairBytes), plan.repair.repairSha256);
  const envelope = parseEnvelope(legal.milestoneEnvelopeFor(before, cliPath, plan));
  const exactCommand = `node ${JSON.stringify(cliPath)} source-repair-apply --workspace "$PWD" `
    + `--input-file ${JSON.stringify(plan.repair.path)} --repair-sha256 ${plan.repair.repairSha256}`;
  assert.equal(envelope.sourceMergeRepairApplyCommand, exactCommand);

  const applied = await execFileAsync("/bin/zsh", ["-lc", exactCommand], {
    cwd: workspace,
    encoding: "utf8",
  });
  const appliedResult = JSON.parse(applied.stdout);
  assert.equal(appliedResult.applied, true);

  const after = await legal.validateWorkspace({ workspaceRoot: workspace, writeProof: false });
  const nextPlan = await legal.pendingSourceReviewPlan(workspace, { expectedStateHash: after.stateHash });
  assert.equal(nextPlan.appliedRepair.path, plan.repair.appliedReceiptPath);
  assert.equal(nextPlan.appliedRepair.repairSha256, plan.repair.repairSha256);
  const receiptBytes = await readFile(join(workspace, plan.repair.appliedReceiptPath));
  const inputTreeSha256After = await treeHash(join(workspace, ".pilotdeck", "inputs"));
  assert.equal(inputTreeSha256After, inputTreeSha256Before);
  assert.equal(await exists(originalReceipt), false);

  const result = {
    passed: true,
    fixture: "preserved-v24r11-case09-second-source-repair",
    sourceRunSummarySha256: "e6cf59642dcbf882c68aa5f435437e905bafe13674f6397786ba4b8893a1d3b2",
    workItem: {
      group: plan.group,
      mode: plan.mode,
      validated: plan.repair.validated,
      repairPath: plan.repair.path,
      repairSha256: plan.repair.repairSha256,
      operationCount: plan.repair.operationCount,
      sourceCount: plan.repair.sourceIds.length,
      factCount: plan.repair.factCount,
      transactionBytes: plan.repair.transactionBytes,
      exactApplyCommandPresent: true,
    },
    apply: {
      applied: appliedResult.applied,
      previousStateHash: appliedResult.previousStateHash,
      stateHash: appliedResult.stateHash,
      sourceCount: appliedResult.sourceCount,
      factCount: appliedResult.factCount,
      durableReceipt: basename(plan.repair.appliedReceiptPath),
      durableReceiptSha256: sha256(receiptBytes),
      nextGroup: nextPlan.group,
    },
    inputTreeSha256Before,
    inputTreeSha256After,
    preservedRunMutated: false,
  };
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
} finally {
  await rm(workspace, { recursive: true, force: true });
}

function parseEnvelope(value) {
  const match = value.match(/^<legal_coverage_state>\n([\s\S]*)\n<\/legal_coverage_state>$/u);
  assert.ok(match?.[1]);
  return JSON.parse(match[1]);
}

async function exists(path) {
  try {
    await stat(path);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
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

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}
