import test from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { loadPluginFromPath } from "../../src/extension/plugins/loading/PluginLoader.js";

const execFile = promisify(execFileCallback);
const PLUGIN_ROOT = resolve("products/legal/plugins/legal-coverage");
const CLI = join(PLUGIN_ROOT, "scripts", "legal-coverage.mjs");
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
    const proof = JSON.parse(await readFile(proofPath, "utf8")) as { stateHash: string; deliverables: Array<{ sha256: string }> };
    assert.match(proof.stateHash, /^[a-f0-9]{64}$/u);
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
    assert.match(preModel.hookSpecificOutput.additionalContext ?? "", /milestone \(configuration\)/u);
    assert.match(preModel.hookSpecificOutput.additionalContext ?? "", /fix validator code jurisdiction_missing now/u);
    assert.equal(preModel.hookSpecificOutput.modelRequestPatch?.metadata?.legalCoverageActive, true);

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
    assert.match(preModel.hookSpecificOutput.additionalContext ?? "", /fix validator code matrix_pending now/u);
    assert.match(preModel.hookSpecificOutput.additionalContext ?? "", /occurs 2 times/u);
    assert.match(preModel.hookSpecificOutput.additionalContext ?? "", /Fix all occurrences in one bounded edit/u);
  } finally {
    await rm(workspace, { recursive: true, force: true });
  }
});

test("legal product plugin loads one skill and contains no benchmark-specific controls", async () => {
  const plugin = await loadPluginFromPath(PLUGIN_ROOT, "project");
  assert.equal(plugin.name, "legal-coverage");
  assert.equal(plugin.skills?.length, 1);
  assert.equal(plugin.skills?.[0]?.name, "legal-coverage:conduct-legal-due-diligence");
  assert.equal(plugin.hooksConfig?.PreModelRequest?.length, 1);

  const files = await collectFiles(PLUGIN_ROOT);
  const productionText = (await Promise.all(files.map((path) => readFile(path, "utf8")))).join("\n");
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
    "Applicable law supports the stated closing condition.",
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
      quote: "Applicable law supports the stated closing condition.",
    }],
  });
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

async function runHook(input: Record<string, unknown>): Promise<{
  continue?: boolean;
  hookSpecificOutput: {
    additionalContext?: string;
    dynamicContext?: unknown[];
    artifactContracts?: Array<{ path: string }>;
    modelRequestPatch?: { metadata?: Record<string, unknown> };
  };
}> {
  const stdout = await new Promise<string>((resolvePromise, reject) => {
    const child = spawn(process.execPath, [HOOK], { stdio: ["pipe", "pipe", "pipe"] });
    let output = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => { output += chunk; });
    child.stderr.on("data", (chunk: string) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolvePromise(output);
      else reject(new Error(stderr || `Hook exited with code ${code}.`));
    });
    child.stdin.end(JSON.stringify(input));
  });
  return JSON.parse(stdout) as never;
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
