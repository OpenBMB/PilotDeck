import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const sourceRun = resolve(process.argv[2] ?? "");
const candidateRoot = resolve(process.argv[3] ?? "");
const outputPath = resolve(process.argv[4] ?? "");

assert.ok(process.argv[2] && process.argv[3] && process.argv[4],
  "usage: replay-preserved-case09.mjs <preserved-run> <candidate-root> <output-json>");

const workspace = await mkdtemp(join(tmpdir(), "pilotdeck-v24r9-case09-replay-"));
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

  const repairReceiptName = (await readdir(fragmentRoot))
    .find((name) => /^source-repair-applied-[a-f0-9]{12}\.json$/u.test(name));
  assert.ok(repairReceiptName, "preserved run must contain the prior applied repair receipt");
  const repairReceipt = JSON.parse(await readFile(join(fragmentRoot, repairReceiptName), "utf8"));

  const proposalNames = (await readdir(fragmentRoot))
    .filter((name) => /^source-merge-[a-f0-9]{12}\.json$/u.test(name));
  const proposals = await Promise.all(proposalNames.map(async (name) => ({
    name,
    body: JSON.parse(await readFile(join(fragmentRoot, name), "utf8")),
  })));
  const ordinary = proposals.find(({ body }) => body.expectedStateHash === repairReceipt.stateHash);
  assert.ok(ordinary, "preserved run must contain the ordinary proposal applied after the repair");

  const sourcesPath = join(stateRoot, "sources.json");
  const factsPath = join(stateRoot, "facts.json");
  const sources = JSON.parse(await readFile(sourcesPath, "utf8"));
  const selectedIds = new Set(ordinary.body.sourceIds);
  const appliedFactIds = new Set();
  for (const source of sources.sources) {
    if (!selectedIds.has(source.id)) continue;
    for (const factId of source.factIds ?? []) appliedFactIds.add(factId);
    source.status = "pending";
    delete source.extractionMethod;
    delete source.evidenceClass;
    delete source.factIds;
    delete source.unresolvedItems;
    delete source.noMaterialFactsReason;
  }
  const facts = JSON.parse(await readFile(factsPath, "utf8"));
  facts.facts = facts.facts.filter((fact) => !appliedFactIds.has(fact.id));
  await writeJson(sourcesPath, sources);
  await writeJson(factsPath, facts);
  await rm(join(stateRoot, "completion-proof.json"), { force: true });

  const legalModule = pathToFileURL(join(candidatePlugin, "scripts", "lib", "legal-coverage.mjs"));
  legalModule.searchParams.set("qa", String(Date.now()));
  const legal = await import(legalModule.href);
  const reconstructed = await legal.validateWorkspace({ workspaceRoot: workspace, writeProof: false });
  assert.equal(reconstructed.stateHash, ordinary.body.expectedStateHash,
    "reconstructed pre-apply state must match the immutable proposal");

  const sessionId = "v24r9-preserved-case09-replay";
  const beforeHook = await runHook({
    hookEventName: "PreModelRequest",
    sessionId,
    transcriptPath: "",
    cwd: workspace,
  });
  const beforeEnvelope = legalEnvelope(beforeHook);
  assert.equal(beforeEnvelope.workItems.group, "source-fragment-apply");
  const beforeProgress = convergence(beforeHook).progressOrdinal;

  const proposalRelativePath = `.pilotdeck/work/legal-coverage/fragments/${ordinary.name}`;
  const proposalBytes = await readFile(join(workspace, proposalRelativePath));
  const proposalSha256 = sha256(proposalBytes);
  const applied = await execFileAsync(process.execPath, [
    cli,
    "source-merge-apply",
    "--input-file", proposalRelativePath,
    "--proposal-sha256", proposalSha256,
    "--limit", "4",
    "--max-bytes", "24576",
    "--workspace", workspace,
  ], { encoding: "utf8" });
  const appliedResult = JSON.parse(applied.stdout);
  assert.equal(appliedResult.applied, true);

  const digest = ordinary.name.match(/^source-merge-([a-f0-9]{12})\.json$/u)?.[1];
  assert.ok(digest);
  const receiptPath = join(fragmentRoot, `source-merge-applied-${digest}.json`);
  const receipt = JSON.parse(await readFile(receiptPath, "utf8"));
  assert.equal(receipt.previousStateHash, reconstructed.stateHash);
  assert.equal(receipt.stateHash, appliedResult.stateHash);
  assert.equal(receipt.proposalSha256, proposalSha256);

  const afterHook = await runHook({
    hookEventName: "PreModelRequest",
    sessionId,
    transcriptPath: "",
    cwd: workspace,
  });
  const afterEnvelope = legalEnvelope(afterHook);
  const afterProgress = convergence(afterHook).progressOrdinal;
  assert.ok(afterEnvelope.workItems.appliedSource);
  assert.equal(afterProgress, beforeProgress + 1);

  const replayHook = await runHook({
    hookEventName: "PreModelRequest",
    sessionId,
    transcriptPath: "",
    cwd: workspace,
  });
  const replayProgress = convergence(replayHook).progressOrdinal;
  assert.equal(replayProgress, afterProgress);

  const finalSources = JSON.parse(await readFile(sourcesPath, "utf8"));
  const finalFacts = JSON.parse(await readFile(factsPath, "utf8"));
  const result = {
    passed: true,
    fixture: "preserved-v24r8-case09-failure",
    proposal: basename(ordinary.name),
    receipt: basename(receiptPath),
    sourceCount: appliedResult.sourceCount,
    factCountApplied: appliedResult.factCount,
    totalSources: finalSources.sources.length,
    reviewedSources: finalSources.sources.filter((source) => source.status === "reviewed").length,
    pendingSources: finalSources.sources.filter((source) => source.status === "pending").length,
    totalFacts: finalFacts.facts.length,
    stateHashBefore: reconstructed.stateHash,
    stateHashAfter: appliedResult.stateHash,
    progressOrdinal: [beforeProgress, afterProgress, replayProgress],
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
    let settled = false;
    const finish = () => {
      if (settled) return;
      try {
        const output = JSON.parse(stdout);
        settled = true;
        child.kill();
        resolvePromise(output);
      } catch {
        // Wait for the complete JSON document.
      }
    };
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill();
      reject(new Error(`hook output timeout: ${stderr.slice(-1000)}`));
    }, 30_000);
    timer.unref();
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
      finish();
    });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      clearTimeout(timer);
      finish();
      if (!settled) reject(new Error(stderr || `hook exited with code ${code}`));
    });
    child.stdin.end(JSON.stringify(input));
  });
}

async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`);
}
