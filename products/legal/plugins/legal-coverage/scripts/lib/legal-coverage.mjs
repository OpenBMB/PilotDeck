import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";

export const VALIDATOR_VERSION = "1.2.0";
export const STATE_DIRECTORY = ".pilotdeck/work/legal-coverage";
export const PROOF_PATH = `${STATE_DIRECTORY}/completion-proof.json`;

export const REQUIRED_MATRICES = [
  "equity-capital-timeline",
  "holding-platform-special-rights",
  "governance-personnel-timeline",
  "contract-key-terms",
  "debt-collateral-liquidity",
  "employment-ip-timeline",
  "legal-authority",
];

export const ISSUE_RULES = {
  "timeline-collision": "timeline_collision",
  "threshold-breach": "threshold_breach",
  "rights-governance-conflict": "rights_governance_conflict",
  "liquidity-relationship": "liquidity_relationship",
  "employment-ip-ownership": "employment_ip_ownership",
  "source-contradiction": "source_contradiction",
};

const STATE_FILES = {
  config: "config.json",
  sources: "sources.json",
  facts: "facts.json",
  matrices: "matrices.json",
  issues: "issues.json",
  authorities: "authorities.json",
  coverage: "coverage.json",
};

const EVIDENCE_CLASSES = new Set([
  "official-record",
  "executed-contract",
  "company-disclosure",
  "financial-record",
  "third-party-record",
  "interview",
  "image-or-scan",
  "other",
]);
const SOURCE_STATUSES = new Set(["reviewed", "unreadable", "pending"]);
const VERIFICATION_STATUSES = new Set(["verified", "partially-verified", "unverified"]);
const CONFLICT_STATUSES = new Set(["none", "resolved", "unresolved"]);
const ISSUE_STATUSES = new Set(["open", "mitigated", "unresolved"]);
const COVERAGE_STATUSES = new Set(["covered", "unresolved"]);
const AUTHORITY_STATUSES = new Set(["verified", "pending-verification", "not-applicable"]);
const MATRIX_STATUSES = new Set(["pending", "complete", "not-applicable"]);
const TEXT_EXTENSIONS = new Set([".md", ".txt", ".html", ".htm", ".csv"]);

export async function ensureWorkspace(workspaceRoot) {
  const workspace = resolve(workspaceRoot);
  const stateRoot = await resolveSafeWorkspacePath(workspace, STATE_DIRECTORY, { allowMissing: true });
  await mkdir(stateRoot, { recursive: true });
  await resolveSafeWorkspacePath(workspace, STATE_DIRECTORY);
  const templates = {
    config: {
      schemaVersion: 1,
      enabled: true,
      jurisdiction: "",
      basisDate: "",
      allowNoMaterialFacts: false,
      inputRoots: [],
      deliverables: [],
    },
    sources: { schemaVersion: 1, sources: [] },
    facts: { schemaVersion: 1, facts: [] },
    matrices: {
      schemaVersion: 1,
      matrices: REQUIRED_MATRICES.map((id) => ({ id, status: "pending", entries: [] })),
    },
    issues: { schemaVersion: 1, issues: [] },
    authorities: { schemaVersion: 1, authorities: [] },
    coverage: { schemaVersion: 1, deliverables: [], sources: [], facts: [], issues: [], authorities: [] },
  };
  for (const [key, template] of Object.entries(templates)) {
    const filePath = resolve(stateRoot, STATE_FILES[key]);
    await resolveSafeWorkspacePath(workspace, toWorkspacePath(workspace, filePath), { allowMissing: true });
    if (!await pathExists(filePath)) await writeJsonAtomic(filePath, template);
  }
  return { workspace, stateRoot, paths: statePaths(workspace) };
}

export async function readWorkspaceState(workspaceRoot) {
  const workspace = resolve(workspaceRoot);
  const paths = statePaths(workspace);
  const state = {};
  const readErrors = [];
  for (const [key, filePath] of Object.entries(paths)) {
    if (key === "proof") continue;
    try {
      await resolveSafeWorkspacePath(workspace, toWorkspacePath(workspace, filePath));
      state[key] = JSON.parse(await readFile(filePath, "utf8"));
      if (!isRecord(state[key])) {
        state[key] = undefined;
        readErrors.push(issue(
          phaseForStateKey(key),
          "state_document_not_object",
          `${relative(workspace, filePath)} must contain a JSON object at the top level.`,
          relative(workspace, filePath),
        ));
      }
    } catch (error) {
      state[key] = undefined;
      readErrors.push(issue(
        phaseForStateKey(key),
        "state_file_invalid",
          `${relative(workspace, filePath)} is missing, unsafe, or is not valid JSON: ${errorMessage(error)}`,
        relative(workspace, filePath),
      ));
    }
  }
  return { workspace, paths, state, readErrors };
}

export async function validateWorkspace(options) {
  const workspace = resolve(options.workspaceRoot);
  const loaded = await readWorkspaceState(workspace);
  const errors = [...loaded.readErrors];
  const warnings = [];
  const context = {
    workspace,
    state: loaded.state,
    errors,
    warnings,
    sourceIds: new Set(),
    factIds: new Set(),
    issueIds: new Set(),
    authorityIds: new Set(),
    sources: new Map(),
    deliverables: new Map(),
    deliverableContents: new Map(),
    proofPathSafe: true,
  };

  try {
    await resolveSafeWorkspacePath(workspace, PROOF_PATH, { allowMissing: true });
  } catch (error) {
    context.proofPathSafe = false;
    add(context, "configuration", "proof_path_invalid", errorMessage(error), PROOF_PATH);
  }

  await validateConfig(context);
  await validateSources(context);
  validateFacts(context);
  validateMatrices(context);
  validateIssues(context);
  validateAuthorities(context);
  validateRelationships(context);
  await validateCoverage(context);

  const stateHash = await computeStateHash(context);
  const passed = errors.length === 0;
  if (options.writeProof) {
    if (passed) {
      const proof = {
        schemaVersion: 1,
        validatorVersion: VALIDATOR_VERSION,
        validatedAt: new Date().toISOString(),
        stateHash,
        sources: [...context.sources.entries()]
          .map(([path, value]) => ({ path, sha256: value.sha256, bytes: value.bytes }))
          .sort((a, b) => a.path.localeCompare(b.path)),
        deliverables: [...context.deliverables.entries()]
          .map(([path, value]) => ({ path, sha256: value.sha256, bytes: value.bytes }))
          .sort((a, b) => a.path.localeCompare(b.path)),
      };
      await writeJsonAtomic(loaded.paths.proof, proof);
    } else if (context.proofPathSafe) {
      await rm(loaded.paths.proof, { force: true });
    }
  }

  return {
    passed,
    stateHash,
    errors,
    warnings,
    counts: {
      sources: context.sourceIds.size,
      facts: context.factIds.size,
      issues: context.issueIds.size,
      authorities: context.authorityIds.size,
      deliverables: context.deliverables.size,
    },
    proofPath: PROOF_PATH,
  };
}

export function milestoneFor(result, cliPath) {
  if (result.passed) {
    return [
      "Legal coverage validation is complete and the completion proof matches the reviewed sources, canonical ledgers, and current deliverables.",
      "Satisfy any other active domain skill, artifact contract, and deliverable QA before stopping.",
      "If any bound source, ledger, or deliverable changes, re-inspect affected evidence and rerun the validator because the current proof will become stale.",
    ].join("\n");
  }
  const first = result.errors[0];
  const sameCode = result.errors.filter((error) => error.code === first?.code);
  const command = `node ${JSON.stringify(cliPath)} validate --workspace \"$PWD\" --write-proof`;
  const initialize = `node ${JSON.stringify(cliPath)} init --workspace \"$PWD\" --input <source-root> --deliverable <id>=<path> --jurisdiction <name> --basis-date <date>`;
  return [
    `Legal coverage milestone (${first?.phase ?? "configuration"}): fix validator code ${first?.code ?? "state_file_invalid"} now.`,
    sameCode.length > 1
      ? `This code occurs ${sameCode.length} times. Fix all occurrences in one bounded edit before rerunning validation.`
      : "Fix this occurrence in one bounded edit before rerunning validation.",
    first?.message ?? "Initialize the legal coverage workspace.",
    sameCode.length > 1
      ? `Representative paths: ${sameCode.slice(0, 4).map((error) => error.path).filter(Boolean).join(", ")}.`
      : undefined,
    first?.phase === "configuration" ? `Use this initializer with task-specific values: ${initialize}` : undefined,
    `After the fix, run: ${command}`,
    "Do not claim completion and do not create completion-proof.json manually.",
  ].filter(Boolean).join("\n");
}

export function activationMatches(prompt) {
  return /(?:法律.{0,8}(?:尽调|尽职调查|意见书|风险审查)|尽职调查.{0,8}(?:法律|意见)|legal\s+(?:due\s+diligence|opinion|risk\s+review)|transaction\s+legal\s+review)/iu.test(prompt);
}

export function statePaths(workspaceRoot) {
  const root = resolveWithinWorkspace(resolve(workspaceRoot), STATE_DIRECTORY);
  return {
    config: resolve(root, STATE_FILES.config),
    sources: resolve(root, STATE_FILES.sources),
    facts: resolve(root, STATE_FILES.facts),
    matrices: resolve(root, STATE_FILES.matrices),
    issues: resolve(root, STATE_FILES.issues),
    authorities: resolve(root, STATE_FILES.authorities),
    coverage: resolve(root, STATE_FILES.coverage),
    proof: resolve(root, "completion-proof.json"),
  };
}

export function resolveWithinWorkspace(workspaceRoot, candidate) {
  if (typeof candidate !== "string" || candidate.trim() === "" || isAbsolute(candidate)) {
    throw new Error(`Path must be a non-empty workspace-relative path: ${String(candidate)}`);
  }
  const workspace = resolve(workspaceRoot);
  const resolved = resolve(workspace, candidate);
  if (resolved !== workspace && !resolved.startsWith(`${workspace}${sep}`)) {
    throw new Error(`Path escapes the workspace: ${candidate}`);
  }
  return resolved;
}

export async function resolveSafeWorkspacePath(workspaceRoot, candidate, options = {}) {
  const workspace = resolve(workspaceRoot);
  const resolved = resolveWithinWorkspace(workspace, candidate);
  const workspaceInfo = await lstat(workspace);
  if (workspaceInfo.isSymbolicLink() || !workspaceInfo.isDirectory()) {
    throw new Error(`Workspace root must be a real directory: ${workspace}`);
  }
  const canonicalWorkspace = await realpath(workspace);
  const segments = relative(workspace, resolved).split(sep).filter(Boolean);
  let current = workspace;
  let exists = true;
  for (const segment of segments) {
    current = resolve(current, segment);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (options.allowMissing === true && error?.code === "ENOENT") {
        exists = false;
        break;
      }
      throw error;
    }
    if (info.isSymbolicLink()) {
      throw new Error(`Symbolic links are not allowed in workspace paths: ${toWorkspacePath(workspace, current)}`);
    }
  }
  if (exists) {
    const canonical = await realpath(resolved);
    if (canonical !== canonicalWorkspace && !canonical.startsWith(`${canonicalWorkspace}${sep}`)) {
      throw new Error(`Path resolves outside the workspace: ${candidate}`);
    }
  }
  return resolved;
}

async function validateConfig(context) {
  const config = context.state.config;
  if (!isRecord(config)) return;
  requireSchemaVersion(context, "configuration", config, STATE_FILES.config);
  if (config.enabled !== true) add(context, "configuration", "plugin_not_enabled", "Set config.enabled to true.", STATE_FILES.config);
  if (!nonEmpty(config.jurisdiction)) add(context, "configuration", "jurisdiction_missing", "Record the governing jurisdiction in config.jurisdiction.", STATE_FILES.config);
  if (!nonEmpty(config.basisDate)) add(context, "configuration", "basis_date_missing", "Record the legal review basis date in config.basisDate.", STATE_FILES.config);
  if (!Array.isArray(config.inputRoots) || config.inputRoots.length === 0) {
    add(context, "configuration", "input_roots_missing", "Add at least one workspace-relative source path to config.inputRoots.", STATE_FILES.config);
  }
  if (!Array.isArray(config.deliverables) || config.deliverables.length === 0) {
    add(context, "configuration", "deliverables_missing", "Add at least one required legal deliverable to config.deliverables.", STATE_FILES.config);
    return;
  }
  const ids = new Set();
  const paths = new Set();
  for (const [index, deliverable] of config.deliverables.entries()) {
    const at = `${STATE_FILES.config}#deliverables[${index}]`;
    if (!isRecord(deliverable) || !nonEmpty(deliverable.id) || !nonEmpty(deliverable.path)) {
      add(context, "configuration", "deliverable_invalid", "Each deliverable requires non-empty id and path fields.", at);
      continue;
    }
    if (ids.has(deliverable.id)) add(context, "configuration", "deliverable_id_duplicate", `Duplicate deliverable id: ${deliverable.id}.`, at);
    if (paths.has(deliverable.path)) add(context, "configuration", "deliverable_path_duplicate", `Duplicate deliverable path: ${deliverable.path}.`, at);
    ids.add(deliverable.id);
    paths.add(deliverable.path);
    try {
      const filePath = await resolveSafeWorkspacePath(context.workspace, deliverable.path);
      if (deliverable.required !== false) {
        const info = await stat(filePath).catch(() => undefined);
        if (!info?.isFile() || info.size === 0) {
          add(context, "coverage", "deliverable_missing", `Required deliverable is missing or empty: ${deliverable.path}.`, deliverable.path);
        } else {
          const data = await readFile(filePath);
          context.deliverables.set(deliverable.path, { sha256: sha256(data), bytes: data.byteLength });
          if (TEXT_EXTENSIONS.has(extname(filePath).toLowerCase())) {
            context.deliverableContents.set(deliverable.path, data.toString("utf8"));
          }
        }
      }
    } catch (error) {
      add(context, "configuration", "deliverable_path_invalid", errorMessage(error), at);
    }
  }
}

async function validateSources(context) {
  const ledger = context.state.sources;
  if (!isRecord(ledger)) return;
  requireSchemaVersion(context, "sources", ledger, STATE_FILES.sources);
  if (!Array.isArray(ledger.sources)) {
    add(context, "sources", "sources_not_array", "sources.json must contain a sources array.", STATE_FILES.sources);
    return;
  }
  const paths = new Set();
  for (const [index, source] of ledger.sources.entries()) {
    const at = `${STATE_FILES.sources}#sources[${index}]`;
    if (!isRecord(source) || !nonEmpty(source.id) || !nonEmpty(source.path)) {
      add(context, "sources", "source_invalid", "Each source requires non-empty id and path fields.", at);
      continue;
    }
    uniqueId(context, context.sourceIds, source.id, "sources", "source_id_duplicate", at);
    if (paths.has(source.path)) add(context, "sources", "source_path_duplicate", `Source path is duplicated: ${source.path}.`, at);
    paths.add(source.path);
    if (!SOURCE_STATUSES.has(source.status)) add(context, "sources", "source_status_invalid", `Source ${source.id} has an invalid status.`, at);
    if (source.status === "pending") add(context, "sources", "source_pending", `Source ${source.id} is still pending review.`, at);
    if (source.status === "reviewed") {
      if (!nonEmpty(source.extractionMethod)) add(context, "sources", "extraction_method_missing", `Source ${source.id} requires extractionMethod.`, at);
      if (!EVIDENCE_CLASSES.has(source.evidenceClass)) add(context, "sources", "evidence_class_invalid", `Source ${source.id} requires a recognized evidenceClass.`, at);
      const factIds = stringArray(source.factIds);
      if (factIds.length === 0 && !nonEmpty(source.noMaterialFactsReason)) {
        add(context, "sources", "source_disposition_missing", `Source ${source.id} must list factIds or explain why it contains no material facts.`, at);
      }
    }
    if (source.status === "unreadable" && stringArray(source.unresolvedItems).length === 0) {
      add(context, "sources", "unreadable_source_unresolved", `Unreadable source ${source.id} must record unresolvedItems.`, at);
    }
    try {
      const sourcePath = await resolveSafeWorkspacePath(context.workspace, source.path);
      const info = await lstat(sourcePath).catch(() => undefined);
      if (!info?.isFile()) {
        add(context, "sources", "source_file_missing", `Inventoried source is missing or not a file: ${source.path}.`, source.path);
      } else {
        const data = await readFile(sourcePath);
        const actual = { sha256: sha256(data), bytes: data.byteLength };
        context.sources.set(source.path, actual);
        if (!/^[a-f0-9]{64}$/u.test(source.sha256 ?? "")) {
          add(context, "sources", "source_hash_missing", `Source ${source.id} must bind the SHA-256 recorded when it was reviewed.`, at);
        } else if (source.sha256 !== actual.sha256) {
          add(context, "sources", "source_hash_stale", `Source ${source.id} changed after its ledger row was reviewed. Re-inspect it and update the dependent ledgers before recording a new hash.`, source.path);
        }
      }
    } catch (error) {
      add(context, "sources", "source_path_invalid", errorMessage(error), at);
    }
  }

  const config = context.state.config;
  if (!isRecord(config) || !Array.isArray(config.inputRoots)) return;
  const discovered = new Set();
  for (const inputRoot of config.inputRoots) {
    if (!nonEmpty(inputRoot)) {
      add(context, "configuration", "input_root_invalid", "Every input root must be a non-empty workspace-relative path.", STATE_FILES.config);
      continue;
    }
    try {
      const root = await resolveSafeWorkspacePath(context.workspace, inputRoot);
      for (const path of await listSourceFiles(context.workspace, root)) discovered.add(path);
    } catch (error) {
      add(context, "sources", "input_root_unreadable", `Cannot inventory input root ${inputRoot}: ${errorMessage(error)}`, inputRoot);
    }
  }
  for (const path of discovered) {
    if (!paths.has(path)) add(context, "sources", "source_not_inventoried", `Source file is not represented in sources.json: ${path}.`, path);
  }
  for (const path of paths) {
    if (!discovered.has(path)) add(context, "sources", "source_outside_inputs", `Ledger source is not under a configured input root: ${path}.`, path);
  }
}

function validateFacts(context) {
  const ledger = context.state.facts;
  if (!isRecord(ledger)) return;
  requireSchemaVersion(context, "facts", ledger, STATE_FILES.facts);
  if (!Array.isArray(ledger.facts)) {
    add(context, "facts", "facts_not_array", "facts.json must contain a facts array.", STATE_FILES.facts);
    return;
  }
  if (ledger.facts.length === 0 && context.state.config?.allowNoMaterialFacts !== true) {
    add(context, "facts", "material_facts_missing", "Record source-grounded legal facts, or set config.allowNoMaterialFacts to true only when the entire reviewed source set is genuinely non-responsive.", STATE_FILES.facts);
  }
  for (const [index, fact] of ledger.facts.entries()) {
    const at = `${STATE_FILES.facts}#facts[${index}]`;
    if (!isRecord(fact) || !nonEmpty(fact.id)) {
      add(context, "facts", "fact_invalid", "Each fact requires a non-empty id.", at);
      continue;
    }
    uniqueId(context, context.factIds, fact.id, "facts", "fact_id_duplicate", at);
    for (const field of ["subject", "predicate"]) {
      if (!nonEmpty(fact[field])) add(context, "facts", `fact_${field}_missing`, `Fact ${fact.id} requires ${field}.`, at);
    }
    if (!hasValue(fact.value)) add(context, "facts", "fact_value_missing", `Fact ${fact.id} requires value.`, at);
    if (!nonEmpty(fact.dateOrPeriod) && !nonEmpty(fact.missingTimeReason)) {
      add(context, "facts", "fact_time_missing", `Fact ${fact.id} requires dateOrPeriod or missingTimeReason.`, at);
    }
    if (!EVIDENCE_CLASSES.has(fact.evidenceClass)) add(context, "facts", "fact_evidence_class_invalid", `Fact ${fact.id} requires a recognized evidenceClass.`, at);
    if (!VERIFICATION_STATUSES.has(fact.verificationStatus)) add(context, "facts", "fact_verification_invalid", `Fact ${fact.id} requires verificationStatus.`, at);
    if (!CONFLICT_STATUSES.has(fact.conflictStatus)) add(context, "facts", "fact_conflict_invalid", `Fact ${fact.id} requires conflictStatus.`, at);
    if (typeof fact.material !== "boolean" || typeof fact.critical !== "boolean") {
      add(context, "facts", "fact_materiality_missing", `Fact ${fact.id} requires boolean material and critical fields.`, at);
    }
    if (!Array.isArray(fact.sourceRefs) || fact.sourceRefs.length === 0) {
      add(context, "facts", "fact_sources_missing", `Fact ${fact.id} requires at least one source reference.`, at);
    } else {
      for (const ref of fact.sourceRefs) {
        if (!isRecord(ref) || !nonEmpty(ref.sourceId) || !nonEmpty(ref.locator)) {
          add(context, "facts", "fact_source_ref_invalid", `Fact ${fact.id} has an incomplete source reference.`, at);
        } else if (!context.sourceIds.has(ref.sourceId)) {
          add(context, "facts", "fact_source_unknown", `Fact ${fact.id} references unknown source ${ref.sourceId}.`, at);
        }
      }
    }
    validateThresholdAssessment(context, fact, at);
  }

  const sourceRows = Array.isArray(context.state.sources?.sources) ? context.state.sources.sources : [];
  for (const source of sourceRows) {
    if (!isRecord(source)) continue;
    for (const factId of stringArray(source.factIds)) {
      if (!context.factIds.has(factId)) add(context, "facts", "source_fact_unknown", `Source ${source.id} references unknown fact ${factId}.`, STATE_FILES.sources);
    }
  }
}

function validateMatrices(context) {
  const ledger = context.state.matrices;
  if (!isRecord(ledger)) return;
  requireSchemaVersion(context, "matrices", ledger, STATE_FILES.matrices);
  if (!Array.isArray(ledger.matrices)) {
    add(context, "matrices", "matrices_not_array", "matrices.json must contain a matrices array.", STATE_FILES.matrices);
    return;
  }
  const byId = new Map();
  const matrixFactIds = new Set();
  for (const [index, matrix] of ledger.matrices.entries()) {
    const at = `${STATE_FILES.matrices}#matrices[${index}]`;
    if (!isRecord(matrix) || !nonEmpty(matrix.id)) {
      add(context, "matrices", "matrix_invalid", "Each matrix requires a non-empty id.", at);
      continue;
    }
    if (byId.has(matrix.id)) add(context, "matrices", "matrix_duplicate", `Duplicate matrix ${matrix.id}.`, at);
    byId.set(matrix.id, matrix);
    if (!MATRIX_STATUSES.has(matrix.status)) add(context, "matrices", "matrix_status_invalid", `Matrix ${matrix.id} has an invalid status.`, at);
    if (matrix.status === "pending") add(context, "matrices", "matrix_pending", `Matrix ${matrix.id} is still pending.`, at);
    const entries = Array.isArray(matrix.entries) ? matrix.entries : [];
    if (matrix.status === "complete" && entries.length === 0) add(context, "matrices", "matrix_empty", `Complete matrix ${matrix.id} requires at least one entry.`, at);
    if (matrix.status === "not-applicable" && !nonEmpty(matrix.notApplicableReason)) {
      add(context, "matrices", "matrix_na_reason_missing", `Matrix ${matrix.id} requires notApplicableReason.`, at);
    }
    for (const entry of entries) {
      for (const factId of stringArray(entry?.factIds)) matrixFactIds.add(factId);
      validateMatrixEntry(context, matrix.id, entry, at);
    }
  }
  for (const id of REQUIRED_MATRICES) {
    if (!byId.has(id)) add(context, "matrices", "required_matrix_missing", `Required legal matrix is missing: ${id}.`, STATE_FILES.matrices);
  }
  const facts = Array.isArray(context.state.facts?.facts) ? context.state.facts.facts : [];
  for (const fact of facts) {
    if (isRecord(fact) && (fact.material === true || fact.critical === true) && !matrixFactIds.has(fact.id)) {
      add(context, "matrices", "material_fact_matrix_orphaned", `Material fact ${fact.id} must appear in at least one legal matrix entry.`, STATE_FILES.matrices);
    }
  }
}

function validateMatrixEntry(context, matrixId, entry, at) {
  if (!isRecord(entry) || !nonEmpty(entry.id) || !nonEmpty(entry.summary)) {
    add(context, "matrices", "matrix_entry_invalid", `Matrix ${matrixId} has an entry without id or summary.`, at);
    return;
  }
  const factIds = stringArray(entry.factIds);
  if (factIds.length === 0) add(context, "matrices", "matrix_entry_facts_missing", `Matrix entry ${entry.id} requires factIds.`, at);
  for (const factId of factIds) {
    if (!context.factIds.has(factId)) add(context, "matrices", "matrix_fact_unknown", `Matrix entry ${entry.id} references unknown fact ${factId}.`, at);
  }
  const signals = stringArray(entry.riskSignals);
  for (const signal of signals) {
    if (!Object.values(ISSUE_RULES).includes(signal)) add(context, "matrices", "risk_signal_unknown", `Matrix entry ${entry.id} has unknown risk signal ${signal}.`, at);
  }
  if (signals.length > 0 && stringArray(entry.issueIds).length === 0) {
    add(context, "issues", "risk_signal_orphaned", `Matrix entry ${entry.id} has risk signals but no issueIds.`, at);
  }
  if (matrixId === "legal-authority" && stringArray(entry.authorityIds).length === 0) {
    add(context, "authorities", "legal_authority_links_missing", `Legal-authority matrix entry ${entry.id} requires authorityIds.`, at);
  }
}

function validateIssues(context) {
  const ledger = context.state.issues;
  if (!isRecord(ledger)) return;
  requireSchemaVersion(context, "issues", ledger, STATE_FILES.issues);
  if (!Array.isArray(ledger.issues)) {
    add(context, "issues", "issues_not_array", "issues.json must contain an issues array.", STATE_FILES.issues);
    return;
  }
  const issuesByRule = new Map();
  for (const [index, legalIssue] of ledger.issues.entries()) {
    const at = `${STATE_FILES.issues}#issues[${index}]`;
    if (!isRecord(legalIssue) || !nonEmpty(legalIssue.id)) {
      add(context, "issues", "issue_invalid", "Each issue requires a non-empty id.", at);
      continue;
    }
    uniqueId(context, context.issueIds, legalIssue.id, "issues", "issue_id_duplicate", at);
    if (!Object.hasOwn(ISSUE_RULES, legalIssue.ruleId)) {
      add(context, "issues", "issue_rule_invalid", `Issue ${legalIssue.id} requires one of these ruleId values: ${Object.keys(ISSUE_RULES).join(", ")}. Matrix riskSignals use the separate underscore values.`, at);
    }
    if (!ISSUE_STATUSES.has(legalIssue.status)) add(context, "issues", "issue_status_invalid", `Issue ${legalIssue.id} requires status.`, at);
    if (!nonEmpty(legalIssue.analysis) || !nonEmpty(legalIssue.conclusion)) add(context, "issues", "issue_reasoning_missing", `Issue ${legalIssue.id} requires analysis and conclusion.`, at);
    if (typeof legalIssue.critical !== "boolean" || !nonEmpty(legalIssue.severity)) add(context, "issues", "issue_severity_missing", `Issue ${legalIssue.id} requires severity and critical.`, at);
    const factIds = stringArray(legalIssue.factIds);
    if (factIds.length === 0) add(context, "issues", "issue_facts_missing", `Issue ${legalIssue.id} requires factIds.`, at);
    for (const factId of factIds) {
      if (!context.factIds.has(factId)) add(context, "issues", "issue_fact_unknown", `Issue ${legalIssue.id} references unknown fact ${factId}.`, at);
    }
    if (stringArray(legalIssue.recommendations).length === 0) add(context, "issues", "issue_recommendations_missing", `Issue ${legalIssue.id} requires at least one recommendation or transaction control.`, at);
    const authorityIds = stringArray(legalIssue.authorityIds);
    if (legalIssue.critical === true && authorityIds.length === 0) {
      add(context, "authorities", "critical_issue_authority_missing", `Critical issue ${legalIssue.id} requires at least one authorityId; authorityNotRequiredReason cannot waive authority support for a critical legal conclusion.`, at);
    }
    const minimumFacts = ["timeline-collision", "rights-governance-conflict", "liquidity-relationship", "source-contradiction"].includes(legalIssue.ruleId) ? 2 : 1;
    if (factIds.length < minimumFacts) {
      add(context, "issues", "issue_relationship_incomplete", `Issue ${legalIssue.id} rule ${legalIssue.ruleId} requires at least ${minimumFacts} linked fact${minimumFacts === 1 ? "" : "s"}.`, at);
    }
    const list = issuesByRule.get(legalIssue.ruleId) ?? [];
    list.push(legalIssue);
    issuesByRule.set(legalIssue.ruleId, list);
  }

  const facts = Array.isArray(context.state.facts?.facts) ? context.state.facts.facts : [];
  for (const fact of facts) {
    if (!isRecord(fact) || !nonEmpty(fact.id)) continue;
    if (fact.conflictStatus === "unresolved" && !issueCoversFact(issuesByRule.get("source-contradiction"), fact.id)) {
      add(context, "issues", "unresolved_conflict_orphaned", `Unresolved fact conflict ${fact.id} requires a source-contradiction issue.`, STATE_FILES.issues);
    }
    if (fact.thresholdAssessment?.breached === true && !issueCoversFact(issuesByRule.get("threshold-breach"), fact.id)) {
      add(context, "issues", "threshold_breach_orphaned", `Threshold breach ${fact.id} requires a threshold-breach issue.`, STATE_FILES.issues);
    }
  }
  for (const collision of detectTimelineCollisions(facts)) {
    const covered = (issuesByRule.get("timeline-collision") ?? []).some((item) => collision.every((id) => stringArray(item.factIds).includes(id)));
    if (!covered) add(context, "issues", "timeline_collision_orphaned", `Conflicting dated facts ${collision.join(", ")} require a timeline-collision issue.`, STATE_FILES.issues);
  }
  const matrices = Array.isArray(context.state.matrices?.matrices) ? context.state.matrices.matrices : [];
  for (const matrix of matrices) {
    for (const entry of Array.isArray(matrix?.entries) ? matrix.entries : []) {
      for (const issueId of stringArray(entry?.issueIds)) {
        if (!context.issueIds.has(issueId)) add(context, "issues", "matrix_issue_unknown", `Matrix entry ${entry.id} references unknown issue ${issueId}.`, STATE_FILES.matrices);
      }
      for (const signal of stringArray(entry?.riskSignals)) {
        const ruleId = Object.keys(ISSUE_RULES).find((key) => ISSUE_RULES[key] === signal);
        const linked = stringArray(entry?.issueIds).some((issueId) => (ledger.issues ?? []).some((item) => item?.id === issueId && item?.ruleId === ruleId));
        if (!linked) add(context, "issues", "risk_signal_rule_mismatch", `Risk signal ${signal} on ${entry.id} requires a linked ${ruleId} issue.`, STATE_FILES.matrices);
      }
    }
  }
}

function validateAuthorities(context) {
  const ledger = context.state.authorities;
  if (!isRecord(ledger)) return;
  requireSchemaVersion(context, "authorities", ledger, STATE_FILES.authorities);
  if (!Array.isArray(ledger.authorities)) {
    add(context, "authorities", "authorities_not_array", "authorities.json must contain an authorities array.", STATE_FILES.authorities);
    return;
  }
  for (const [index, authority] of ledger.authorities.entries()) {
    const at = `${STATE_FILES.authorities}#authorities[${index}]`;
    if (!isRecord(authority) || !nonEmpty(authority.id)) {
      add(context, "authorities", "authority_invalid", "Each authority requires a non-empty id.", at);
      continue;
    }
    uniqueId(context, context.authorityIds, authority.id, "authorities", "authority_id_duplicate", at);
    if (!AUTHORITY_STATUSES.has(authority.verificationStatus)) add(context, "authorities", "authority_status_invalid", `Authority ${authority.id} requires verificationStatus.`, at);
    if (!nonEmpty(authority.name) || !nonEmpty(authority.supportedConclusion)) add(context, "authorities", "authority_content_missing", `Authority ${authority.id} requires name and supportedConclusion.`, at);
    if (authority.verificationStatus === "verified") {
      for (const field of ["article", "effectiveVersion", "effectiveDate", "sourceLocator"]) {
        if (!nonEmpty(authority[field])) add(context, "authorities", `authority_${field}_missing`, `Verified authority ${authority.id} requires ${field}.`, at);
      }
    }
    if (authority.verificationStatus === "pending-verification" && !nonEmpty(authority.pendingReason)) {
      add(context, "authorities", "authority_pending_reason_missing", `Pending authority ${authority.id} requires pendingReason.`, at);
    }
    const issueIds = stringArray(authority.supportedIssueIds);
    if (issueIds.length === 0 && authority.verificationStatus !== "not-applicable") add(context, "authorities", "authority_issues_missing", `Authority ${authority.id} must identify supportedIssueIds.`, at);
    for (const issueId of issueIds) {
      if (!context.issueIds.has(issueId)) add(context, "authorities", "authority_issue_unknown", `Authority ${authority.id} references unknown issue ${issueId}.`, at);
    }
  }
  const issues = Array.isArray(context.state.issues?.issues) ? context.state.issues.issues : [];
  for (const legalIssue of issues) {
    if (!isRecord(legalIssue)) continue;
    for (const authorityId of stringArray(legalIssue.authorityIds)) {
      if (!context.authorityIds.has(authorityId)) add(context, "authorities", "issue_authority_unknown", `Issue ${legalIssue.id} references unknown authority ${authorityId}.`, STATE_FILES.issues);
    }
  }
  const matrices = Array.isArray(context.state.matrices?.matrices) ? context.state.matrices.matrices : [];
  const legalAuthorityMatrix = matrices.find((matrix) => matrix?.id === "legal-authority");
  for (const entry of Array.isArray(legalAuthorityMatrix?.entries) ? legalAuthorityMatrix.entries : []) {
    for (const authorityId of stringArray(entry?.authorityIds)) {
      if (!context.authorityIds.has(authorityId)) {
        add(context, "authorities", "matrix_authority_unknown", `Legal-authority matrix entry ${entry.id} references unknown authority ${authorityId}.`, STATE_FILES.matrices);
      }
    }
  }
}

function validateRelationships(context) {
  const sources = recordMap(context.state.sources?.sources);
  const facts = recordMap(context.state.facts?.facts);
  const issues = recordMap(context.state.issues?.issues);
  const authorities = recordMap(context.state.authorities?.authorities);

  for (const source of sources.values()) {
    for (const factId of stringArray(source.factIds)) {
      const fact = facts.get(factId);
      if (fact && !factSourceIds(fact).includes(source.id)) {
        add(context, "facts", "source_fact_backlink_missing", `Source ${source.id} lists fact ${factId}, but that fact does not reference the source.`, STATE_FILES.facts);
      }
    }
  }
  for (const fact of facts.values()) {
    for (const sourceId of factSourceIds(fact)) {
      const source = sources.get(sourceId);
      if (source && !stringArray(source.factIds).includes(fact.id)) {
        add(context, "sources", "fact_source_backlink_missing", `Fact ${fact.id} references source ${sourceId}, but that source does not list the fact.`, STATE_FILES.sources);
      }
    }
  }

  for (const legalIssue of issues.values()) {
    for (const authorityId of stringArray(legalIssue.authorityIds)) {
      const authority = authorities.get(authorityId);
      if (authority && !stringArray(authority.supportedIssueIds).includes(legalIssue.id)) {
        add(context, "authorities", "authority_issue_backlink_missing", `Authority ${authorityId} must backlink issue ${legalIssue.id}.`, STATE_FILES.authorities);
      }
    }
  }
  for (const authority of authorities.values()) {
    for (const issueId of stringArray(authority.supportedIssueIds)) {
      const legalIssue = issues.get(issueId);
      if (legalIssue && !stringArray(legalIssue.authorityIds).includes(authority.id)) {
        add(context, "authorities", "issue_authority_backlink_missing", `Authority ${authority.id} lists issue ${issueId}, but that issue does not reference the authority.`, STATE_FILES.issues);
      }
    }
  }

  const matrices = Array.isArray(context.state.matrices?.matrices) ? context.state.matrices.matrices : [];
  for (const matrix of matrices) {
    if (!isRecord(matrix)) continue;
    for (const entry of Array.isArray(matrix.entries) ? matrix.entries : []) {
      if (!isRecord(entry)) continue;
      const entryFactIds = stringArray(entry.factIds);
      const entryIssueIds = stringArray(entry.issueIds);
      const entryAuthorityIds = stringArray(entry.authorityIds);
      for (const issueId of entryIssueIds) {
        const legalIssue = issues.get(issueId);
        if (legalIssue && !stringArray(legalIssue.factIds).some((factId) => entryFactIds.includes(factId))) {
          add(context, "issues", "matrix_issue_fact_mismatch", `Matrix entry ${entry.id} and linked issue ${issueId} must reference at least one common fact.`, STATE_FILES.matrices);
        }
      }
      for (const signal of stringArray(entry.riskSignals)) {
        const ruleId = Object.keys(ISSUE_RULES).find((key) => ISSUE_RULES[key] === signal);
        const matchingIssue = entryIssueIds
          .map((issueId) => issues.get(issueId))
          .find((legalIssue) => legalIssue?.ruleId === ruleId && entryFactIds.every((factId) => stringArray(legalIssue.factIds).includes(factId)));
        if (!matchingIssue) {
          add(context, "issues", "risk_signal_fact_mismatch", `Risk signal ${signal} on ${entry.id} requires a linked ${ruleId} issue covering all entry facts.`, STATE_FILES.matrices);
        }
      }
      if (matrix.id !== "legal-authority") continue;
      for (const authorityId of entryAuthorityIds) {
        const authority = authorities.get(authorityId);
        if (authority && !entryIssueIds.some((issueId) => stringArray(authority.supportedIssueIds).includes(issueId))) {
          add(context, "authorities", "matrix_authority_issue_mismatch", `Legal-authority matrix entry ${entry.id} links authority ${authorityId} without a supported issue from the same entry.`, STATE_FILES.matrices);
        }
      }
      for (const issueId of entryIssueIds) {
        const supported = entryAuthorityIds.some((authorityId) => {
          const authority = authorities.get(authorityId);
          const legalIssue = issues.get(issueId);
          return authority && legalIssue
            && stringArray(authority.supportedIssueIds).includes(issueId)
            && stringArray(legalIssue.authorityIds).includes(authorityId);
        });
        if (!supported) {
          add(context, "authorities", "matrix_issue_authority_mismatch", `Legal-authority matrix entry ${entry.id} issue ${issueId} requires a mutually linked authority from the same entry.`, STATE_FILES.matrices);
        }
      }
    }
  }
}

async function validateCoverage(context) {
  const manifest = context.state.coverage;
  if (!isRecord(manifest)) return;
  requireSchemaVersion(context, "coverage", manifest, STATE_FILES.coverage);
  const configDeliverables = Array.isArray(context.state.config?.deliverables) ? context.state.config.deliverables : [];
  const manifestDeliverables = Array.isArray(manifest.deliverables) ? manifest.deliverables : [];
  for (const deliverable of configDeliverables) {
    if (!isRecord(deliverable) || deliverable.required === false || !nonEmpty(deliverable.path)) continue;
    const actual = context.deliverables.get(deliverable.path);
    const record = manifestDeliverables.find((item) => item?.path === deliverable.path);
    if (!record) {
      add(context, "coverage", "deliverable_hash_missing", `Coverage manifest must bind required deliverable ${deliverable.path}.`, STATE_FILES.coverage);
    } else if (actual && record.sha256 !== actual.sha256) {
      add(context, "coverage", "deliverable_hash_stale", `Coverage hash is stale for ${deliverable.path}.`, STATE_FILES.coverage);
    }
  }

  const sourceCoverage = coverageMap(context, manifest.sources, "sourceId", "sources", context.sourceIds);
  const factCoverage = coverageMap(context, manifest.facts, "factId", "facts", context.factIds);
  const issueCoverage = coverageMap(context, manifest.issues, "issueId", "issues", context.issueIds);
  const authorityCoverage = coverageMap(context, manifest.authorities, "authorityId", "authorities", context.authorityIds);
  const sources = Array.isArray(context.state.sources?.sources) ? context.state.sources.sources : [];
  for (const source of sources) {
    if (!isRecord(source) || !nonEmpty(source.id)) continue;
    if ((source.status === "unreadable" || stringArray(source.unresolvedItems).length > 0) && sourceCoverage.get(source.id)?.status !== "unresolved") {
      add(context, "coverage", "unresolved_source_not_disclosed", `Source ${source.id} has unresolved review items and must be mapped as unresolved in final coverage.`, STATE_FILES.coverage);
    }
  }
  const facts = Array.isArray(context.state.facts?.facts) ? context.state.facts.facts : [];
  for (const fact of facts) {
    if (!isRecord(fact) || !(fact.material === true || fact.critical === true)) continue;
    const coverage = factCoverage.get(fact.id);
    if (!coverage) add(context, "coverage", "material_fact_orphaned", `Material fact ${fact.id} is not mapped to a final deliverable.`, STATE_FILES.coverage);
    if (coverage && context.deliverableContents.has(coverage.deliverablePath) && !factCoverageQuoteSupports(fact, coverage.quote)) {
      add(context, "coverage", "fact_coverage_quote_unsupported", `Coverage quote for material fact ${fact.id} must contain its subject and either its predicate, value, or date/period.`, STATE_FILES.coverage);
    }
    if (fact.conflictStatus === "unresolved" && coverage?.status !== "unresolved") {
      add(context, "coverage", "conflict_not_disclosed", `Unresolved fact ${fact.id} must be marked unresolved in final coverage.`, STATE_FILES.coverage);
    }
    if (fact.verificationStatus !== "verified" && coverage?.status !== "unresolved") {
      add(context, "coverage", "unverified_fact_not_disclosed", `Material or critical fact ${fact.id} is not fully verified and must be marked unresolved in final coverage.`, STATE_FILES.coverage);
    }
  }
  const issues = Array.isArray(context.state.issues?.issues) ? context.state.issues.issues : [];
  for (const legalIssue of issues) {
    if (!isRecord(legalIssue)) continue;
    const coverage = issueCoverage.get(legalIssue.id);
    if (!coverage) add(context, "coverage", "issue_orphaned", `Legal issue ${legalIssue.id} is not mapped to a final deliverable.`, STATE_FILES.coverage);
    if (coverage && context.deliverableContents.has(coverage.deliverablePath) && !issueCoverageQuoteSupports(legalIssue, coverage.quote)) {
      add(context, "coverage", "issue_coverage_quote_unsupported", `Coverage quote for issue ${legalIssue.id} must share specific reasoning or control language with its analysis, conclusion, or recommendations.`, STATE_FILES.coverage);
    }
    if (legalIssue.status === "unresolved" && coverage?.status !== "unresolved") {
      add(context, "coverage", "unresolved_issue_not_disclosed", `Unresolved issue ${legalIssue.id} must be marked unresolved in final coverage.`, STATE_FILES.coverage);
    }
  }
  const authorities = Array.isArray(context.state.authorities?.authorities) ? context.state.authorities.authorities : [];
  for (const authority of authorities) {
    if (!isRecord(authority) || authority.verificationStatus === "not-applicable") continue;
    const coverage = authorityCoverage.get(authority.id);
    if (!coverage) add(context, "coverage", "authority_orphaned", `Authority ${authority.id} is not mapped to a final deliverable.`, STATE_FILES.coverage);
    if (coverage && context.deliverableContents.has(coverage.deliverablePath) && !authorityCoverageQuoteSupports(authority, coverage.quote)) {
      add(context, "coverage", "authority_coverage_quote_unsupported", `Coverage quote for authority ${authority.id} must identify the authority and article and support its stated conclusion.`, STATE_FILES.coverage);
    }
    if (authority.verificationStatus === "pending-verification" && coverage?.status !== "unresolved") {
      add(context, "coverage", "pending_authority_not_disclosed", `Pending authority ${authority.id} must be marked unresolved in final coverage.`, STATE_FILES.coverage);
    }
  }
}

function coverageMap(context, rows, idField, group, knownIds) {
  const map = new Map();
  const quoteOwners = new Map();
  if (!Array.isArray(rows)) {
    add(context, "coverage", `${group}_coverage_not_array`, `coverage.json must contain a ${group} array.`, STATE_FILES.coverage);
    return map;
  }
  for (const [index, row] of rows.entries()) {
    const at = `${STATE_FILES.coverage}#${group}[${index}]`;
    if (!isRecord(row) || !nonEmpty(row[idField])) {
      add(context, "coverage", `${group}_coverage_invalid`, `Each ${group} coverage row requires ${idField}.`, at);
      continue;
    }
    if (map.has(row[idField])) add(context, "coverage", `${group}_coverage_duplicate`, `Duplicate coverage row for ${row[idField]}.`, at);
    map.set(row[idField], row);
    if (!knownIds.has(row[idField])) add(context, "coverage", `${group}_coverage_unknown`, `Coverage row references unknown ${idField} ${row[idField]}.`, at);
    if (!COVERAGE_STATUSES.has(row.status) || !nonEmpty(row.deliverablePath) || !nonEmpty(row.section) || !nonEmpty(row.claim) || !nonEmpty(row.locator)) {
      add(context, "coverage", `${group}_coverage_incomplete`, `Coverage row ${row[idField]} requires status (covered or unresolved), deliverablePath, section, claim, and locator.`, at);
      continue;
    }
    const deliverable = context.deliverables.get(row.deliverablePath);
    if (!deliverable) add(context, "coverage", "coverage_deliverable_unknown", `Coverage row ${row[idField]} references an unavailable deliverable ${row.deliverablePath}.`, at);
    const text = context.deliverableContents.get(row.deliverablePath);
    if (text !== undefined) {
      if (!nonEmpty(row.quote)) {
        add(context, "coverage", "coverage_quote_missing", `Text deliverable coverage for ${row[idField]} requires an exact quote.`, at);
      } else if (!text.includes(row.quote)) {
        add(context, "coverage", "coverage_quote_not_found", `Coverage quote for ${row[idField]} is not present in ${row.deliverablePath}.`, at);
      } else {
        const quoteKey = normalizeEvidenceText(row.quote);
        const owner = quoteOwners.get(quoteKey);
        if (owner && owner !== row[idField]) {
          add(context, "coverage", "coverage_quote_reused", `Coverage quote for ${row[idField]} is already used by ${owner}; each ${group} row needs distinct supporting text.`, at);
        } else {
          quoteOwners.set(quoteKey, row[idField]);
        }
      }
    }
  }
  return map;
}

function validateThresholdAssessment(context, fact, at) {
  if (fact.thresholdAssessment === undefined || fact.thresholdAssessment === null) return;
  const assessment = fact.thresholdAssessment;
  if (!isRecord(assessment) || !["gt", "gte", "lt", "lte", "eq"].includes(assessment.operator)
    || typeof assessment.actual !== "number" || typeof assessment.threshold !== "number" || typeof assessment.breached !== "boolean") {
    add(context, "facts", "threshold_assessment_invalid", `Fact ${fact.id} has an invalid thresholdAssessment.`, at);
    return;
  }
  const calculated = compareThreshold(assessment.actual, assessment.operator, assessment.threshold);
  if (calculated !== assessment.breached) add(context, "facts", "threshold_assessment_mismatch", `Fact ${fact.id} thresholdAssessment.breached does not match its numeric comparison.`, at);
}

function factCoverageQuoteSupports(fact, quote) {
  if (!nonEmpty(quote)) return false;
  const normalizedQuote = normalizeEvidenceText(quote);
  const subject = normalizeEvidenceText(fact.subject);
  if (subject.length < 2 || !normalizedQuote.includes(subject)) return false;
  const details = [fact.predicate, fact.dateOrPeriod, ...scalarValues(fact.value)]
    .map(normalizeEvidenceText)
    .filter((value) => value.length >= 2 && value !== subject);
  return details.some((value) => normalizedQuote.includes(value));
}

function issueCoverageQuoteSupports(legalIssue, quote) {
  return semanticOverlapCount(
    quote,
    [legalIssue.analysis, legalIssue.conclusion, ...stringArray(legalIssue.recommendations)],
  ) >= 2;
}

function authorityCoverageQuoteSupports(authority, quote) {
  if (!nonEmpty(quote) || !nonEmpty(authority.name) || !nonEmpty(authority.supportedConclusion)) return false;
  if (authority.verificationStatus === "verified" && !citationIdentitySupports(quote, authority.name, authority.article)) return false;
  return semanticOverlapCount(quote, [authority.supportedConclusion]) >= 2;
}

function citationIdentitySupports(quote, name, article) {
  if (!nonEmpty(name) || !nonEmpty(article)) return false;
  const normalizedName = normalizeEvidenceText(name);
  const normalizedArticle = normalizeEvidenceText(article);
  return String(quote)
    .split(/[;；。\n]+/u)
    .map(normalizeEvidenceText)
    .some((segment) => segment.includes(normalizedName) && segment.includes(normalizedArticle));
}

function semanticOverlapCount(quote, values) {
  if (!nonEmpty(quote)) return 0;
  const quoteAnchors = semanticAnchors(quote);
  const valueAnchors = new Set(values.filter(nonEmpty).flatMap(semanticAnchors));
  let count = 0;
  for (const anchor of quoteAnchors) if (valueAnchors.has(anchor)) count += 1;
  return count;
}

function semanticAnchors(value) {
  const text = normalize(value);
  const anchors = new Set();
  for (const token of text.match(/[\p{Script=Latin}\p{N}]{3,}/gu) ?? []) {
    if (!SEMANTIC_STOP_WORDS.has(token)) anchors.add(token);
  }
  for (const sequence of text.match(/[\p{Script=Han}]{2,}/gu) ?? []) {
    for (let index = 0; index < sequence.length - 1; index += 1) {
      const pair = sequence.slice(index, index + 2);
      if (!SEMANTIC_STOP_WORDS.has(pair)) anchors.add(pair);
    }
  }
  return [...anchors];
}

const SEMANTIC_STOP_WORDS = new Set([
  "and", "are", "for", "from", "that", "the", "this", "with",
  "公司", "法律", "问题", "交易", "风险", "要求", "存在", "相关",
]);

function scalarValues(value) {
  if (Array.isArray(value)) return value.flatMap(scalarValues);
  if (isRecord(value)) return Object.values(value).flatMap(scalarValues);
  if (typeof value === "string" || typeof value === "number") return [String(value)];
  return [];
}

function normalizeEvidenceText(value) {
  return normalize(value).replace(/[\p{P}\p{S}\s]+/gu, "");
}

function compareThreshold(actual, operator, threshold) {
  if (operator === "gt") return actual > threshold;
  if (operator === "gte") return actual >= threshold;
  if (operator === "lt") return actual < threshold;
  if (operator === "lte") return actual <= threshold;
  return actual === threshold;
}

function detectTimelineCollisions(facts) {
  const groups = new Map();
  for (const fact of facts) {
    if (!isRecord(fact) || !nonEmpty(fact.id) || !nonEmpty(fact.subject) || !nonEmpty(fact.predicate) || !nonEmpty(fact.dateOrPeriod)) continue;
    const key = [normalize(fact.subject), normalize(fact.predicate), normalize(fact.dateOrPeriod)].join("|");
    const list = groups.get(key) ?? [];
    list.push(fact);
    groups.set(key, list);
  }
  const collisions = [];
  for (const group of groups.values()) {
    if (group.length < 2) continue;
    const values = new Set(group.map((fact) => stableStringify(fact.value)));
    if (values.size > 1) collisions.push(group.map((fact) => fact.id).sort());
  }
  return collisions;
}

async function listSourceFiles(workspace, root) {
  await resolveSafeWorkspacePath(workspace, toWorkspacePath(workspace, root));
  const rootInfo = await lstat(root);
  if (rootInfo.isSymbolicLink()) throw new Error("Input roots may not be symbolic links.");
  if (rootInfo.isFile()) return [toWorkspacePath(workspace, root)];
  if (!rootInfo.isDirectory()) throw new Error("Input root must be a file or directory.");
  const files = [];
  const entries = await readdir(root, { withFileTypes: true });
  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (entry.name === ".DS_Store" || entry.name === ".git") continue;
    const fullPath = resolve(root, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Symbolic link is not allowed in an input root: ${toWorkspacePath(workspace, fullPath)}`);
    if (entry.isDirectory()) files.push(...await listSourceFiles(workspace, fullPath));
    if (entry.isFile()) files.push(toWorkspacePath(workspace, fullPath));
  }
  return files;
}

async function computeStateHash(context) {
  const state = {};
  for (const key of Object.keys(STATE_FILES)) state[key] = context.state[key];
  const deliverables = [...context.deliverables.entries()]
    .map(([path, value]) => ({ path, sha256: value.sha256, bytes: value.bytes }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const sources = [...context.sources.entries()]
    .map(([path, value]) => ({ path, sha256: value.sha256, bytes: value.bytes }))
    .sort((a, b) => a.path.localeCompare(b.path));
  return sha256(stableStringify({ validatorVersion: VALIDATOR_VERSION, state, sources, deliverables }));
}

async function writeJsonAtomic(filePath, value) {
  await mkdir(dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, filePath);
}

function requireSchemaVersion(context, phase, value, path) {
  if (value.schemaVersion !== 1) add(context, phase, "schema_version_invalid", `${path} must use schemaVersion 1.`, path);
}

function uniqueId(context, set, id, phase, code, path) {
  if (set.has(id)) add(context, phase, code, `Duplicate id: ${id}.`, path);
  set.add(id);
}

function add(context, phase, code, message, path) {
  context.errors.push(issue(phase, code, message, path));
}

function issue(phase, code, message, path) {
  return { phase, code, message, path };
}

function phaseForStateKey(key) {
  return key === "config" ? "configuration" : key;
}

function issueCoversFact(issues, factId) {
  return (issues ?? []).some((item) => stringArray(item.factIds).includes(factId));
}

function recordMap(rows) {
  const output = new Map();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (isRecord(row) && nonEmpty(row.id)) output.set(row.id, row);
  }
  return output;
}

function factSourceIds(fact) {
  return (Array.isArray(fact.sourceRefs) ? fact.sourceRefs : [])
    .filter(isRecord)
    .map((reference) => reference.sourceId)
    .filter(nonEmpty);
}

function toWorkspacePath(workspace, filePath) {
  return relative(workspace, filePath).split(sep).join("/");
}

function stringArray(value) {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string" && item.trim() !== "") : [];
}

function nonEmpty(value) {
  return typeof value === "string" && value.trim() !== "";
}

function hasValue(value) {
  return value !== undefined && value !== null && (!(typeof value === "string") || value.trim() !== "");
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function normalize(value) {
  return String(value).normalize("NFKC").trim().toLowerCase().replace(/\s+/gu, " ");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function errorMessage(error) {
  return error instanceof Error ? error.message : String(error);
}

async function pathExists(path) {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}
