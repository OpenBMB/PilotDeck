import { createHash } from "node:crypto";
import { lstat, mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, extname, isAbsolute, relative, resolve, sep } from "node:path";

export const VALIDATOR_VERSION = "1.3.0";
export const STATE_DIRECTORY = ".pilotdeck/work/legal-coverage";
export const PROOF_PATH = `${STATE_DIRECTORY}/completion-proof.json`;
export const INPUT_MANIFEST_PATH = ".pilotdeck/input-manifest.json";

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
const SOURCE_REVIEW_FRAGMENT_PATTERN = /^source-review-[a-f0-9]{12}\.json$/u;
const SOURCE_REVIEW_FRAGMENT_TYPE = "legal-evidence-source-batch-review";
const SOURCE_REVIEW_FRAGMENT_MAX_BYTES = 262144;
const SOURCE_REVIEW_MERGE_MAX_SOURCES = 4;
const SOURCE_MERGE_MAX_FACTS = 32;
const SOURCE_REVIEW_MATERIALITIES = new Set(["non-material", "material", "critical", "uncertain"]);

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

export async function bootstrapSourcesFromManifest(workspaceRoot) {
  const initialized = await ensureWorkspace(workspaceRoot);
  const manifestContext = {
    workspace: initialized.workspace,
    errors: [],
    warnings: [],
    inputManifest: undefined,
    manifestSources: new Map(),
  };
  await loadInputManifest(manifestContext);
  if (!manifestContext.inputManifest || manifestContext.errors.length > 0) {
    const first = manifestContext.errors[0];
    throw legalCoverageError(
      first?.code ?? "input_manifest_unavailable",
      first?.message ?? `Cannot bootstrap sources without a valid ${INPUT_MANIFEST_PATH}.`,
    );
  }

  const ledger = JSON.parse(await readFile(initialized.paths.sources, "utf8"));
  if (!isRecord(ledger) || ledger.schemaVersion !== 1 || !Array.isArray(ledger.sources)) {
    throw legalCoverageError("sources_ledger_invalid", "sources.json must be a schemaVersion 1 object with a sources array.");
  }
  if (ledger.sources.some((source) => !isRecord(source) || !nonEmpty(source.id) || !nonEmpty(source.path))) {
    throw legalCoverageError("sources_ledger_invalid", "Every existing source row must have non-empty id and path fields.");
  }

  const existingPaths = new Set(ledger.sources.map((source) => source.path));
  const existingIds = new Set(ledger.sources.map((source) => source.id));
  const created = [];
  const preserved = [];
  const manifestSources = [...manifestContext.manifestSources.values()]
    .sort((left, right) => left.path.localeCompare(right.path));

  for (const source of manifestSources) {
    if (existingPaths.has(source.path)) {
      preserved.push({ path: source.path, reason: "already_inventoried" });
      continue;
    }
    const id = `SRC-${sha256(source.path).slice(0, 12).toUpperCase()}`;
    if (existingIds.has(id)) {
      throw legalCoverageError("source_id_collision", `Stable source ID collision for ${source.path}.`);
    }
    const row = {
      id,
      path: source.path,
      sha256: source.sha256,
      status: "pending",
      derivedArtifacts: source.derivations.map((artifact) => ({
        path: artifact.path,
        sha256: artifact.sha256,
        extractionMethod: artifact.extractionMethod,
        extractorVersion: artifact.extractorVersion,
      })),
    };
    ledger.sources.push(row);
    existingPaths.add(row.path);
    existingIds.add(row.id);
    created.push({ id: row.id, path: row.path });
  }

  if (created.length > 0) await writeJsonAtomic(initialized.paths.sources, ledger);
  const sourceReviewPlan = sourceReviewPlanFor(ledger.sources);
  return {
    bootstrapped: created.length,
    preserved: preserved.length,
    totalManifestSources: manifestSources.length,
    created,
    preservedSources: preserved,
    sourcesPath: `${STATE_DIRECTORY}/${STATE_FILES.sources}`,
    sourceReviewPlan,
  };
}

export async function pendingSourceReviewPlan(workspaceRoot, options = {}) {
  const loaded = await readWorkspaceState(workspaceRoot);
  const sourceRows = Array.isArray(loaded.state.sources?.sources) ? loaded.state.sources.sources : [];
  const receipts = await validSourceReviewReceipts(workspaceRoot, sourceRows, options);
  const mergePlan = sourceReviewMergePlanFor(sourceRows, receipts, options);
  if (!mergePlan) return sourceReviewPlanFor(sourceRows, options);
  const expectedStateHash = /^[a-f0-9]{64}$/u.test(String(options.expectedStateHash ?? ""))
    ? options.expectedStateHash
    : (await validateWorkspace({ workspaceRoot, writeProof: false })).stateHash;
  const proposalPlan = sourceMergeProposalPlanFor(mergePlan, expectedStateHash);
  const proposalReceipt = await validSourceMergeProposalReceipt(workspaceRoot, proposalPlan, receipts, loaded.state);
  if (proposalReceipt?.valid) return sourceMergeApplyPlanFor(proposalPlan, proposalReceipt);
  if (proposalReceipt?.error) {
    return {
      ...proposalPlan,
      proposal: { ...proposalPlan.proposal, validationError: proposalReceipt.error },
    };
  }
  return proposalPlan;
}

function sourceReviewPlanFor(sourceRows, options = {}) {
  const maxSourcesPerBatch = boundedInteger(options.maxSourcesPerBatch, 1, 12, 12);
  const maxBatches = boundedInteger(options.maxBatches, 1, 4, 4);
  const eligible = (Array.isArray(sourceRows) ? sourceRows : [])
    .filter((source) => isRecord(source) && nonEmpty(source.id) && nonEmpty(source.path))
    .map((source) => ({ id: source.id, path: source.path, status: source.status }))
    .sort((left, right) => left.path.localeCompare(right.path) || left.id.localeCompare(right.id));
  const pending = eligible.filter((source) => source.status === "pending");
  const pendingIds = new Set(pending.map((source) => source.id));
  const stableGroups = [];
  for (let offset = 0; offset < eligible.length; offset += maxSourcesPerBatch) {
    const rows = eligible.slice(offset, offset + maxSourcesPerBatch)
      .filter((source) => pendingIds.has(source.id));
    if (rows.length > 0) stableGroups.push(rows);
  }
  const selectedGroups = stableGroups.slice(0, maxBatches);
  const selected = selectedGroups.flat();
  const batches = [];
  for (const rows of selectedGroups) {
    const digest = sha256(rows.map((source) => source.id).join("\0")).slice(0, 12);
    const sourceIds = rows.map((source) => source.id);
    const fragmentPath = `${STATE_DIRECTORY}/fragments/source-review-${digest}.json`;
    batches.push({
      id: `source-review-${digest}`,
      sourceIds,
      fragmentPath,
      agentInput: {
        description: `Review source batch ${batches.length + 1}`,
        subagent_type: "general-purpose",
        prompt: sourceReviewWorkerPrompt(sourceIds, fragmentPath, `source-review-${digest}`),
      },
    });
  }
  return {
    phase: "sources",
    group: "pending-source-review",
    mode: eligible.length > 20 ? "delegated" : "main-agent",
    pending: pending.length,
    returned: selected.length,
    hasMore: selected.length < pending.length,
    limits: {
      maxBatches,
      maxSourcesPerBatch,
      maxRecords: 12,
      maxSerializedBytes: 24576,
    },
    dispatch: {
      tool: "agent",
      subagentType: "general-purpose",
      callMode: "parallel-same-response",
    },
    workerContract: {
      sourceLedger: `${STATE_DIRECTORY}/${STATE_FILES.sources}`,
      inspectOnlyAssignedSourceIds: true,
      mayWrite: ["assigned fragmentPath"],
      mustNotWrite: [
        "canonical legal-coverage ledgers",
        "completion-proof.json",
        "final deliverables",
      ],
      fragmentRequiredFields: [
        "schemaVersion",
        "fragmentType",
        "fragmentId",
        "assignedSourceIds",
        "sources",
        "sourceId",
        "sourcePath",
        "inspectionMethod",
        "facts",
        "evidenceClass",
        "verificationState",
        "conflicts",
        "unresolvedItems",
        "proposedMateriality",
      ],
      returnFormat: "Return only fragmentPath and a summary under 1000 characters.",
    },
    batches,
  };
}

function sourceReviewWorkerPrompt(sourceIds, fragmentPath, fragmentId) {
  return [
    "Review one disjoint legal-evidence source batch in the current workspace.",
    `Assigned source IDs: ${sourceIds.join(", ")}.`,
    `Resolve only those exact rows from ${STATE_DIRECTORY}/${STATE_FILES.sources}; inspect each original and every listed derivedArtifact.`,
    `Write one JSON evidence fragment only to ${fragmentPath}.`,
    `Use exactly this envelope: schemaVersion=1, fragmentType=${SOURCE_REVIEW_FRAGMENT_TYPE}, fragmentId=${fragmentId}, assignedSourceIds=[the IDs above in the same order], sources=[one row per assigned ID].`,
    "Each sources row must use exactly sourceId, sourcePath, inspectionMethod, facts, evidenceClass, verificationState, conflicts, unresolvedItems, and proposedMateriality.",
    "facts must be an array of {locator, statement}; if empty, include a non-empty noMaterialFactsReason. conflicts and unresolvedItems must be arrays of strings.",
    "evidenceClass must be official-record, executed-contract, company-disclosure, financial-record, third-party-record, interview, image-or-scan, or other; verificationState must be verified, partially-verified, or unverified; proposedMateriality must be non-material, material, critical, or uncertain.",
    "Do not use aliases such as reviews, reviewBatch, atomicFacts, findings, or batchSummary. Do not add unassigned source IDs.",
    "Do not edit canonical legal-coverage ledgers, completion-proof.json, or any final deliverable.",
    "Return only the fragment path and a summary under 1000 characters.",
  ].join(" ");
}

async function validSourceReviewReceipts(workspaceRoot, sourceRows, options = {}) {
  const maxSourcesPerBatch = boundedInteger(options.maxSourcesPerBatch, 1, 12, 12);
  const sourceById = new Map((Array.isArray(sourceRows) ? sourceRows : [])
    .filter((source) => isRecord(source) && nonEmpty(source.id) && nonEmpty(source.path))
    .map((source) => [source.id, source]));
  const stableGroupBySourceId = new Map();
  const sortedSourceIds = [...sourceById.values()]
    .sort((left, right) => left.path.localeCompare(right.path) || left.id.localeCompare(right.id))
    .map((source) => source.id);
  for (let offset = 0; offset < sortedSourceIds.length; offset += maxSourcesPerBatch) {
    const group = Math.floor(offset / maxSourcesPerBatch);
    for (const sourceId of sortedSourceIds.slice(offset, offset + maxSourcesPerBatch)) {
      stableGroupBySourceId.set(sourceId, group);
    }
  }
  const fragmentDirectory = `${STATE_DIRECTORY}/fragments`;
  const directoryPath = await resolveSafeWorkspacePath(workspaceRoot, fragmentDirectory, { allowMissing: true });
  let entries;
  try {
    entries = await readdir(directoryPath, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }

  const candidates = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isFile() || !SOURCE_REVIEW_FRAGMENT_PATTERN.test(entry.name)) continue;
    const fragmentPath = `${fragmentDirectory}/${entry.name}`;
    const path = await resolveSafeWorkspacePath(workspaceRoot, fragmentPath);
    const info = await stat(path);
    if (!info.isFile() || info.size <= 0 || info.size > SOURCE_REVIEW_FRAGMENT_MAX_BYTES) continue;
    const bytes = await readFile(path);
    let fragment;
    try {
      fragment = JSON.parse(bytes.toString("utf8"));
    } catch {
      continue;
    }
    const receipt = sourceReviewReceiptFor(
      fragment,
      fragmentPath,
      sourceById,
      stableGroupBySourceId,
      maxSourcesPerBatch,
      bytes,
    );
    if (receipt) candidates.push(receipt);
  }

  const sourceIdCounts = new Map();
  for (const receipt of candidates) {
    for (const sourceId of receipt.assignedSourceIds) {
      sourceIdCounts.set(sourceId, (sourceIdCounts.get(sourceId) ?? 0) + 1);
    }
  }
  return candidates.filter((receipt) => receipt.assignedSourceIds.every((sourceId) => sourceIdCounts.get(sourceId) === 1));
}

function sourceReviewReceiptFor(fragment, fragmentPath, sourceById, stableGroupBySourceId, maxSourcesPerBatch, bytes) {
  if (!isRecord(fragment)
    || !hasOnlyKeys(fragment, ["schemaVersion", "fragmentType", "fragmentId", "assignedSourceIds", "sources"])
    || fragment.schemaVersion !== 1
    || fragment.fragmentType !== SOURCE_REVIEW_FRAGMENT_TYPE
    || !nonEmpty(fragment.fragmentId)
    || !Array.isArray(fragment.assignedSourceIds)
    || fragment.assignedSourceIds.length < 1
    || fragment.assignedSourceIds.length > maxSourcesPerBatch
    || fragment.assignedSourceIds.some((sourceId) => !nonEmpty(sourceId))
    || new Set(fragment.assignedSourceIds).size !== fragment.assignedSourceIds.length
    || !Array.isArray(fragment.sources)
    || fragment.sources.length !== fragment.assignedSourceIds.length) return undefined;

  const groupIds = new Set(fragment.assignedSourceIds.map((sourceId) => stableGroupBySourceId.get(sourceId)));
  if (groupIds.size !== 1 || groupIds.has(undefined)) return undefined;

  const digest = sha256(fragment.assignedSourceIds.join("\0")).slice(0, 12);
  const expectedId = `source-review-${digest}`;
  if (fragment.fragmentId !== expectedId
    || fragmentPath !== `${STATE_DIRECTORY}/fragments/${expectedId}.json`) return undefined;

  const rowsById = new Map();
  for (const row of fragment.sources) {
    if (!validSourceReviewFragmentRow(row, sourceById)) return undefined;
    if (rowsById.has(row.sourceId)) return undefined;
    rowsById.set(row.sourceId, row);
  }
  if (fragment.assignedSourceIds.some((sourceId) => !rowsById.has(sourceId))) return undefined;

  return {
    id: expectedId,
    fragmentPath,
    receiptSha256: sha256(bytes),
    assignedSourceIds: [...fragment.assignedSourceIds],
    sourceRows: fragment.sources,
  };
}

function validSourceReviewFragmentRow(row, sourceById) {
  if (!isRecord(row)
    || !hasOnlyKeys(row, [
      "sourceId",
      "sourcePath",
      "inspectionMethod",
      "facts",
      "noMaterialFactsReason",
      "evidenceClass",
      "verificationState",
      "conflicts",
      "unresolvedItems",
      "proposedMateriality",
    ])
    || !nonEmpty(row.sourceId) || !nonEmpty(row.sourcePath)
    || !nonEmpty(row.inspectionMethod) || !Array.isArray(row.facts)
    || !EVIDENCE_CLASSES.has(row.evidenceClass)
    || !VERIFICATION_STATUSES.has(row.verificationState)
    || !Array.isArray(row.conflicts) || row.conflicts.some((value) => !nonEmpty(value))
    || !Array.isArray(row.unresolvedItems) || row.unresolvedItems.some((value) => !nonEmpty(value))
    || !SOURCE_REVIEW_MATERIALITIES.has(row.proposedMateriality)) return false;
  const source = sourceById.get(row.sourceId);
  if (!source || row.sourcePath !== source.path) return false;
  if (row.facts.some((fact) => !isRecord(fact)
    || !hasOnlyKeys(fact, ["locator", "statement"])
    || !nonEmpty(fact.locator)
    || !nonEmpty(fact.statement))) return false;
  return (row.facts.length > 0 || nonEmpty(row.noMaterialFactsReason))
    && Buffer.byteLength(JSON.stringify(row)) <= 20000;
}

function sourceReviewMergePlanFor(sourceRows, receipts, options = {}) {
  const pendingIds = new Set((Array.isArray(sourceRows) ? sourceRows : [])
    .filter((source) => isRecord(source) && source.status === "pending" && nonEmpty(source.id))
    .map((source) => source.id));
  const eligible = receipts
    .map((receipt) => ({
      ...receipt,
      pendingSourceIds: receipt.assignedSourceIds.filter((sourceId) => pendingIds.has(sourceId)),
    }))
    .filter((receipt) => receipt.pendingSourceIds.length > 0);
  if (eligible.length === 0) return undefined;

  const maxRecords = boundedInteger(options.maxMergeSources, 1, SOURCE_REVIEW_MERGE_MAX_SOURCES, SOURCE_REVIEW_MERGE_MAX_SOURCES);
  const selected = eligible[0];
  const sourceIds = boundedReceiptSourceIds(selected, maxRecords, 24576);
  const remainingReceiptSources = eligible.reduce((count, receipt) => count + receipt.pendingSourceIds.length, 0);
  return {
    phase: "sources",
    group: "source-fragment-merge",
    mode: "main-agent-merge",
    pending: pendingIds.size,
    returned: sourceIds.length,
    hasMore: remainingReceiptSources > sourceIds.length,
    limits: {
      maxRecords,
      maxSerializedBytes: 24576,
    },
    receipts: eligible.map((receipt) => ({
      id: receipt.id,
      fragmentPath: receipt.fragmentPath,
      receiptSha256: receipt.receiptSha256,
      pendingSourceCount: receipt.pendingSourceIds.length,
    })),
    mergeItems: [{
      id: selected.id,
      fragmentPath: selected.fragmentPath,
      receiptSha256: selected.receiptSha256,
      sourceIds,
    }],
  };
}

function sourceMergeProposalPlanFor(mergePlan, expectedStateHash) {
  const item = mergePlan.mergeItems[0];
  const digest = sha256([
    item.id,
    item.receiptSha256,
    expectedStateHash,
    ...item.sourceIds,
  ].join("\0")).slice(0, 12);
  const proposalPath = `${STATE_DIRECTORY}/fragments/source-merge-${digest}.json`;
  return {
    ...mergePlan,
    proposal: {
      path: proposalPath,
      expectedStateHash,
      fragmentPath: item.fragmentPath,
      receiptSha256: item.receiptSha256,
      sourceIds: [...item.sourceIds],
      limits: {
        maxSources: item.sourceIds.length,
        maxFacts: SOURCE_MERGE_MAX_FACTS,
        maxSerializedBytes: mergePlan.limits.maxSerializedBytes,
      },
      template: {
        schemaVersion: 1,
        phase: "sources",
        group: "source-fragment-merge",
        expectedStateHash,
        fragmentPath: item.fragmentPath,
        receiptSha256: item.receiptSha256,
        sourceIds: [...item.sourceIds],
        facts: [{
          subject: "<legal subject>",
          predicate: "<atomic predicate>",
          value: "<source-grounded value>",
          unit: null,
          dateOrPeriod: null,
          missingTimeReason: "<why no usable time appears in the source>",
          sourceRefs: [{ sourceId: item.sourceIds[0], locator: "<exact fragment locator>" }],
          evidenceClass: "<fragment evidence class>",
          verificationStatus: "<verified|partially-verified|unverified>",
          conflictStatus: "<none|resolved|unresolved>",
          material: false,
          critical: false,
          thresholdAssessment: null,
        }],
        noMaterialFacts: [],
      },
    },
  };
}

function sourceMergeApplyPlanFor(proposalPlan, proposalReceipt) {
  return {
    ...proposalPlan,
    group: "source-fragment-apply",
    mode: "main-agent-apply",
    proposal: {
      ...proposalPlan.proposal,
      proposalSha256: proposalReceipt.sha256,
      validated: true,
      factCount: proposalReceipt.factCount,
      noMaterialFactCount: proposalReceipt.noMaterialFactCount,
      transactionBytes: proposalReceipt.transactionBytes,
    },
  };
}

function boundedReceiptSourceIds(receipt, maxRecords, maxSerializedBytes) {
  const rowsById = new Map(receipt.sourceRows.map((row) => [row.sourceId, row]));
  const selected = [];
  for (const sourceId of receipt.pendingSourceIds) {
    if (selected.length >= maxRecords) break;
    const candidate = [...selected, sourceId];
    const payload = {
      schemaVersion: 1,
      fragmentId: receipt.id,
      fragmentPath: receipt.fragmentPath,
      receiptSha256: receipt.receiptSha256,
      sources: candidate.map((id) => rowsById.get(id)),
    };
    if (Buffer.byteLength(JSON.stringify(payload)) > maxSerializedBytes) break;
    selected.push(sourceId);
  }
  return selected;
}

export async function sourceReviewFragmentSlice(workspaceRoot, options = {}) {
  const sourceIds = Array.isArray(options.sourceIds) ? options.sourceIds : [];
  const maxRecords = boundedInteger(options.maxRecords, 1, SOURCE_REVIEW_MERGE_MAX_SOURCES, SOURCE_REVIEW_MERGE_MAX_SOURCES);
  const maxSerializedBytes = boundedInteger(options.maxSerializedBytes, 1024, 24576, 24576);
  if (!nonEmpty(options.fragmentPath) || !SOURCE_REVIEW_FRAGMENT_PATTERN.test(options.fragmentPath.split("/").at(-1) ?? "")) {
    throw batchError("source_fragment_path_invalid", "fragment-slice requires a deterministic source-review fragment path.");
  }
  if (!/^[a-f0-9]{64}$/u.test(String(options.receiptSha256 ?? ""))) {
    throw batchError("source_fragment_receipt_hash_invalid", "fragment-slice requires the injected lowercase receipt SHA-256.");
  }
  if (sourceIds.length < 1 || sourceIds.length > maxRecords
    || sourceIds.some((sourceId) => !nonEmpty(sourceId))
    || new Set(sourceIds).size !== sourceIds.length) {
    throw batchError("source_fragment_source_ids_invalid", `fragment-slice requires 1..${maxRecords} unique source IDs.`);
  }

  const loaded = await readWorkspaceState(workspaceRoot);
  const rows = Array.isArray(loaded.state.sources?.sources) ? loaded.state.sources.sources : [];
  const receipts = await validSourceReviewReceipts(workspaceRoot, rows);
  const receipt = receipts.find((candidate) => candidate.fragmentPath === options.fragmentPath
    && candidate.receiptSha256 === options.receiptSha256);
  if (!receipt) {
    throw batchError("source_fragment_receipt_invalid", "The fragment is missing, changed, overlapping, or does not satisfy the source-review receipt contract.");
  }
  if (sourceIds.some((sourceId) => !receipt.assignedSourceIds.includes(sourceId))) {
    throw batchError("source_fragment_source_ids_out_of_scope", "Every requested source ID must belong to the validated fragment receipt.");
  }
  const rowsById = new Map(receipt.sourceRows.map((row) => [row.sourceId, row]));
  const result = {
    schemaVersion: 1,
    fragmentId: receipt.id,
    fragmentPath: receipt.fragmentPath,
    receiptSha256: receipt.receiptSha256,
    sources: sourceIds.map((sourceId) => rowsById.get(sourceId)),
  };
  const serializedBytes = Buffer.byteLength(JSON.stringify(result));
  if (serializedBytes > maxSerializedBytes) {
    throw batchError("source_fragment_slice_byte_limit", `fragment-slice output is ${serializedBytes} bytes; maximum is ${maxSerializedBytes}.`);
  }
  return result;
}

async function validSourceMergeProposalReceipt(workspaceRoot, plan, receipts, state) {
  try {
    const proposalPath = await resolveSafeWorkspacePath(workspaceRoot, plan.proposal.path);
    const bytes = await readFile(proposalPath);
    if (bytes.byteLength > plan.proposal.limits.maxSerializedBytes) return undefined;
    const patch = JSON.parse(bytes.toString("utf8"));
    const receipt = receipts.find((candidate) => candidate.fragmentPath === plan.proposal.fragmentPath
      && candidate.receiptSha256 === plan.proposal.receiptSha256);
    if (!receipt) return undefined;
    const normalized = validateSourceMergeProposal(patch, plan, receipt, state, bytes.byteLength);
    return {
      valid: true,
      sha256: sha256(bytes),
      factCount: normalized.facts.length,
      noMaterialFactCount: normalized.noMaterialFacts.length,
      transactionBytes: normalized.transactionBytes,
    };
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    return {
      valid: false,
      error: {
        code: typeof error?.code === "string" ? error.code : "source_merge_proposal_invalid",
        message: errorMessage(error),
      },
    };
  }
}

export async function applySourceMergeProposal(workspaceRoot, options = {}) {
  if (!nonEmpty(options.proposalPath) || !/^source-merge-[a-f0-9]{12}\.json$/u.test(options.proposalPath.split("/").at(-1) ?? "")) {
    throw batchError("source_merge_proposal_path_invalid", "source-merge-apply requires the injected deterministic proposal path.");
  }
  if (!/^[a-f0-9]{64}$/u.test(String(options.proposalSha256 ?? ""))) {
    throw batchError("source_merge_proposal_hash_invalid", "source-merge-apply requires the injected lowercase proposal SHA-256.");
  }
  const maxRecords = boundedInteger(options.maxRecords, 1, SOURCE_REVIEW_MERGE_MAX_SOURCES, SOURCE_REVIEW_MERGE_MAX_SOURCES);
  const maxSerializedBytes = boundedInteger(options.maxSerializedBytes, 1024, 24576, 24576);
  const proposalPath = await resolveSafeWorkspacePath(workspaceRoot, options.proposalPath);
  const proposalBytes = await readFile(proposalPath);
  if (sha256(proposalBytes) !== options.proposalSha256) {
    throw batchError("source_merge_proposal_changed", "The source merge proposal changed after validation; request a fresh apply command.");
  }
  if (proposalBytes.byteLength > maxSerializedBytes) {
    throw batchError("source_merge_proposal_byte_limit", `Source merge proposal is ${proposalBytes.byteLength} bytes; maximum is ${maxSerializedBytes}.`);
  }
  let patch;
  try {
    patch = JSON.parse(proposalBytes.toString("utf8"));
  } catch (error) {
    throw batchError("source_merge_proposal_json_invalid", errorMessage(error));
  }

  const before = await validateWorkspace({ workspaceRoot, writeProof: false });
  if (patch.expectedStateHash !== before.stateHash) {
    throw batchError(
      "stale_state_hash",
      `expectedStateHash ${String(patch.expectedStateHash)} does not match current state ${before.stateHash}. Request a fresh source merge proposal.`,
    );
  }
  const loaded = await readWorkspaceState(workspaceRoot);
  const sourceRows = Array.isArray(loaded.state.sources?.sources) ? loaded.state.sources.sources : [];
  const receipts = await validSourceReviewReceipts(workspaceRoot, sourceRows);
  const mergePlan = sourceReviewMergePlanFor(sourceRows, receipts, { maxMergeSources: maxRecords });
  if (!mergePlan) throw batchError("source_merge_not_applicable", "No validated pending source fragment is currently mergeable.");
  const proposalPlan = sourceMergeProposalPlanFor(mergePlan, before.stateHash);
  if (proposalPlan.proposal.path !== options.proposalPath) {
    throw batchError("source_merge_proposal_out_of_scope", "The proposal path is not the current bounded source merge transaction.");
  }
  const receipt = receipts.find((candidate) => candidate.fragmentPath === proposalPlan.proposal.fragmentPath
    && candidate.receiptSha256 === proposalPlan.proposal.receiptSha256);
  if (!receipt) throw batchError("source_fragment_receipt_invalid", "The source fragment receipt is no longer valid.");
  const normalized = validateSourceMergeProposal(patch, proposalPlan, receipt, loaded.state, proposalBytes.byteLength);

  const selectedIds = new Set(proposalPlan.proposal.sourceIds);
  const fragmentRows = new Map(receipt.sourceRows.map((row) => [row.sourceId, row]));
  const factIdsBySource = new Map(proposalPlan.proposal.sourceIds.map((sourceId) => [sourceId, []]));
  for (const fact of normalized.facts) {
    for (const reference of fact.sourceRefs) factIdsBySource.get(reference.sourceId)?.push(fact.id);
  }
  const noMaterialBySource = new Map(normalized.noMaterialFacts.map((item) => [item.sourceId, item.reason]));
  const nextSources = {
    ...loaded.state.sources,
    sources: sourceRows.map((source) => {
      if (!isRecord(source) || !selectedIds.has(source.id)) return source;
      const fragmentRow = fragmentRows.get(source.id);
      const factIds = [...new Set(factIdsBySource.get(source.id) ?? [])].sort();
      const unresolvedItems = [...new Set([
        ...stringArray(fragmentRow.unresolvedItems),
        ...stringArray(fragmentRow.conflicts).map((conflict) => `Conflict: ${conflict}`),
      ])];
      const next = {
        ...source,
        status: "reviewed",
        extractionMethod: fragmentRow.inspectionMethod,
        evidenceClass: fragmentRow.evidenceClass,
        factIds,
        unresolvedItems,
      };
      if (factIds.length === 0) next.noMaterialFactsReason = noMaterialBySource.get(source.id);
      else delete next.noMaterialFactsReason;
      return next;
    }),
  };
  const existingFacts = Array.isArray(loaded.state.facts?.facts) ? loaded.state.facts.facts : [];
  const nextFacts = {
    ...loaded.state.facts,
    facts: [...existingFacts, ...normalized.facts],
  };

  await writeJsonAtomic(loaded.paths.facts, nextFacts);
  try {
    await writeJsonAtomic(loaded.paths.sources, nextSources);
  } catch (error) {
    try {
      await writeJsonAtomic(loaded.paths.facts, loaded.state.facts);
    } catch (rollbackError) {
      throw batchError(
        "source_merge_rollback_failed",
        `Source ledger write failed (${errorMessage(error)}) and fact-ledger rollback also failed (${errorMessage(rollbackError)}).`,
      );
    }
    throw error;
  }

  const after = await validateWorkspace({ workspaceRoot, writeProof: true });
  return {
    applied: true,
    phase: "sources",
    group: "source-fragment-merge",
    sourceCount: selectedIds.size,
    factCount: normalized.facts.length,
    previousStateHash: before.stateHash,
    stateHash: after.stateHash,
    passed: after.passed,
    errorCountBefore: before.errors.length,
    errorCountAfter: after.errors.length,
  };
}

function validateSourceMergeProposal(patch, plan, receipt, state, serializedBytes) {
  if (!isRecord(patch)) throw batchError("source_merge_proposal_not_object", "Source merge proposal must be a JSON object.");
  const expectedKeys = [
    "expectedStateHash",
    "facts",
    "fragmentPath",
    "group",
    "noMaterialFacts",
    "phase",
    "receiptSha256",
    "schemaVersion",
    "sourceIds",
  ];
  if (JSON.stringify(Object.keys(patch).sort()) !== JSON.stringify(expectedKeys)) {
    throw batchError("source_merge_proposal_keys_invalid", `Source merge proposal must contain only: ${expectedKeys.join(", ")}.`);
  }
  if (patch.schemaVersion !== 1 || patch.phase !== "sources" || patch.group !== "source-fragment-merge") {
    throw batchError("source_merge_proposal_identity_invalid", "Source merge proposal requires schemaVersion 1, phase sources, and group source-fragment-merge.");
  }
  if (patch.expectedStateHash !== plan.proposal.expectedStateHash
    || patch.fragmentPath !== plan.proposal.fragmentPath
    || patch.receiptSha256 !== plan.proposal.receiptSha256
    || JSON.stringify(patch.sourceIds) !== JSON.stringify(plan.proposal.sourceIds)) {
    throw batchError("source_merge_proposal_scope_mismatch", "Proposal state, fragment receipt, and ordered source IDs must exactly match the injected bounded merge transaction.");
  }
  if (serializedBytes > plan.proposal.limits.maxSerializedBytes) {
    throw batchError("source_merge_proposal_byte_limit", `Source merge proposal is ${serializedBytes} bytes; maximum is ${plan.proposal.limits.maxSerializedBytes}.`);
  }
  if (!Array.isArray(patch.facts) || patch.facts.length > plan.proposal.limits.maxFacts) {
    throw batchError("source_merge_fact_limit", `Proposal facts must be an array with at most ${plan.proposal.limits.maxFacts} rows.`);
  }
  if (!Array.isArray(patch.noMaterialFacts) || patch.noMaterialFacts.length > plan.proposal.sourceIds.length) {
    throw batchError("source_merge_no_material_invalid", "noMaterialFacts must be a bounded array covering only selected source IDs.");
  }

  const selectedIds = new Set(plan.proposal.sourceIds);
  const fragmentRows = new Map(receipt.sourceRows.map((row) => [row.sourceId, row]));
  const referencedSources = new Set();
  const existingFactIds = new Set((Array.isArray(state.facts?.facts) ? state.facts.facts : [])
    .filter(isRecord).map((fact) => fact.id).filter(nonEmpty));
  const generatedFactIds = new Set();
  const facts = patch.facts.map((fact, index) => {
    if (!isRecord(fact) || !hasOnlyKeys(fact, [
      "subject",
      "predicate",
      "value",
      "unit",
      "dateOrPeriod",
      "missingTimeReason",
      "sourceRefs",
      "evidenceClass",
      "verificationStatus",
      "conflictStatus",
      "material",
      "critical",
      "thresholdAssessment",
    ])) throw batchError("source_merge_fact_keys_invalid", `Proposal fact ${index + 1} contains unsupported fields.`);
    if (!nonEmpty(fact.subject) || !nonEmpty(fact.predicate) || !hasValue(fact.value)
      || containsProposalPlaceholder(fact.subject) || containsProposalPlaceholder(fact.predicate)
      || containsProposalPlaceholder(fact.value)) {
      throw batchError("source_merge_fact_content_missing", `Proposal fact ${index + 1} requires subject, predicate, and value.`);
    }
    const hasDate = nonEmpty(fact.dateOrPeriod);
    const hasMissingTimeReason = nonEmpty(fact.missingTimeReason);
    if (hasDate === hasMissingTimeReason
      || containsProposalPlaceholder(fact.dateOrPeriod)
      || containsProposalPlaceholder(fact.missingTimeReason)) {
      throw batchError("source_merge_fact_time_invalid", `Proposal fact ${index + 1} requires exactly one of dateOrPeriod or missingTimeReason, without template placeholders.`);
    }
    if (fact.unit !== undefined && fact.unit !== null
      && (!nonEmpty(fact.unit) || containsProposalPlaceholder(fact.unit))) {
      throw batchError("source_merge_fact_unit_invalid", `Proposal fact ${index + 1} unit must be a non-empty string, null, or omitted.`);
    }
    if (!EVIDENCE_CLASSES.has(fact.evidenceClass)
      || !VERIFICATION_STATUSES.has(fact.verificationStatus)
      || !CONFLICT_STATUSES.has(fact.conflictStatus)) {
      throw batchError("source_merge_fact_classification_invalid", `Proposal fact ${index + 1} has an invalid evidence, verification, or conflict classification.`);
    }
    if (typeof fact.material !== "boolean" || typeof fact.critical !== "boolean" || (fact.critical && !fact.material)) {
      throw batchError("source_merge_fact_materiality_invalid", `Proposal fact ${index + 1} requires boolean material/critical fields and critical implies material.`);
    }
    if (!Array.isArray(fact.sourceRefs) || fact.sourceRefs.length === 0) {
      throw batchError("source_merge_fact_sources_missing", `Proposal fact ${index + 1} requires sourceRefs.`);
    }
    const seenRefs = new Set();
    const sourceRefs = fact.sourceRefs.map((reference) => {
      if (!isRecord(reference) || !hasOnlyKeys(reference, ["sourceId", "locator"])
        || !selectedIds.has(reference.sourceId) || !nonEmpty(reference.locator)) {
        throw batchError("source_merge_fact_source_out_of_scope", `Proposal fact ${index + 1} has an invalid or out-of-scope source reference.`);
      }
      const key = `${reference.sourceId}\0${reference.locator}`;
      if (seenRefs.has(key)) throw batchError("source_merge_fact_source_duplicate", `Proposal fact ${index + 1} repeats a source reference.`);
      seenRefs.add(key);
      const fragmentRow = fragmentRows.get(reference.sourceId);
      const allowedLocators = new Set((Array.isArray(fragmentRow?.facts) ? fragmentRow.facts : []).map((item) => item.locator));
      if (!allowedLocators.has(reference.locator)) {
        throw batchError("source_merge_fact_locator_unverified", `Proposal fact ${index + 1} locator is not present in the validated fragment row for ${reference.sourceId}.`);
      }
      referencedSources.add(reference.sourceId);
      return { sourceId: reference.sourceId, locator: reference.locator };
    }).sort((left, right) => left.sourceId.localeCompare(right.sourceId) || left.locator.localeCompare(right.locator));
    const referencedEvidenceClasses = new Set(sourceRefs.map((reference) => fragmentRows.get(reference.sourceId)?.evidenceClass));
    if (!referencedEvidenceClasses.has(fact.evidenceClass)) {
      throw batchError("source_merge_fact_evidence_mismatch", `Proposal fact ${index + 1} evidenceClass must match at least one referenced fragment source.`);
    }
    validateProposedThresholdAssessment(fact.thresholdAssessment, index + 1);
    const normalized = {
      subject: fact.subject,
      predicate: fact.predicate,
      value: fact.value,
      ...(nonEmpty(fact.unit) ? { unit: fact.unit } : {}),
      ...(hasDate ? { dateOrPeriod: fact.dateOrPeriod } : { missingTimeReason: fact.missingTimeReason }),
      sourceRefs,
      evidenceClass: fact.evidenceClass,
      verificationStatus: fact.verificationStatus,
      conflictStatus: fact.conflictStatus,
      material: fact.material,
      critical: fact.critical,
      ...(fact.thresholdAssessment === undefined || fact.thresholdAssessment === null
        ? {}
        : { thresholdAssessment: fact.thresholdAssessment }),
    };
    const id = `F-${sha256(stableStringify(normalized)).slice(0, 12).toUpperCase()}`;
    if (existingFactIds.has(id) || generatedFactIds.has(id)) {
      throw batchError("source_merge_fact_id_conflict", `Proposal fact ${index + 1} collides with fact ID ${id}.`);
    }
    generatedFactIds.add(id);
    return { id, ...normalized };
  });

  const noMaterialSources = new Set();
  const noMaterialFacts = patch.noMaterialFacts.map((item) => {
    if (!isRecord(item) || !hasOnlyKeys(item, ["sourceId", "reason"])
      || !selectedIds.has(item.sourceId) || !nonEmpty(item.reason) || containsProposalPlaceholder(item.reason)) {
      throw batchError("source_merge_no_material_invalid", "Each noMaterialFacts row requires one selected sourceId and a specific reason.");
    }
    if (noMaterialSources.has(item.sourceId)) throw batchError("source_merge_no_material_duplicate", `Duplicate noMaterialFacts source ${item.sourceId}.`);
    noMaterialSources.add(item.sourceId);
    return { sourceId: item.sourceId, reason: item.reason };
  });
  for (const sourceId of selectedIds) {
    const hasFacts = referencedSources.has(sourceId);
    const hasNoMaterialReason = noMaterialSources.has(sourceId);
    if (hasFacts === hasNoMaterialReason) {
      throw batchError("source_merge_source_disposition_invalid", `Selected source ${sourceId} must have fact references or one noMaterialFacts reason, but not both.`);
    }
  }
  const factIdsBySource = new Map(plan.proposal.sourceIds.map((sourceId) => [sourceId, []]));
  for (const fact of facts) {
    for (const reference of fact.sourceRefs) factIdsBySource.get(reference.sourceId)?.push(fact.id);
  }
  const noMaterialBySource = new Map(noMaterialFacts.map((item) => [item.sourceId, item.reason]));
  const transactionSources = plan.proposal.sourceIds.map((sourceId) => {
    const fragmentRow = fragmentRows.get(sourceId);
    const factIds = [...new Set(factIdsBySource.get(sourceId) ?? [])].sort();
    return {
      sourceId,
      status: "reviewed",
      extractionMethod: fragmentRow.inspectionMethod,
      evidenceClass: fragmentRow.evidenceClass,
      factIds,
      unresolvedItems: [...new Set([
        ...stringArray(fragmentRow.unresolvedItems),
        ...stringArray(fragmentRow.conflicts).map((conflict) => `Conflict: ${conflict}`),
      ])],
      ...(factIds.length === 0 ? { noMaterialFactsReason: noMaterialBySource.get(sourceId) } : {}),
    };
  });
  const transactionBytes = Buffer.byteLength(JSON.stringify({ sources: transactionSources, facts }));
  if (transactionBytes > plan.proposal.limits.maxSerializedBytes) {
    throw batchError(
      "source_merge_transaction_byte_limit",
      `Projected source/fact transaction is ${transactionBytes} bytes; maximum is ${plan.proposal.limits.maxSerializedBytes}. Reduce fact detail without dropping material evidence.`,
    );
  }
  return { facts, noMaterialFacts, transactionBytes };
}

function validateProposedThresholdAssessment(assessment, factNumber) {
  if (assessment === undefined || assessment === null) return;
  if (!isRecord(assessment) || !hasOnlyKeys(assessment, ["operator", "actual", "threshold", "unit", "breached"])
    || !["gt", "gte", "lt", "lte", "eq"].includes(assessment.operator)
    || typeof assessment.actual !== "number" || typeof assessment.threshold !== "number"
    || typeof assessment.breached !== "boolean"
    || (assessment.unit !== undefined && assessment.unit !== null
      && (!nonEmpty(assessment.unit) || containsProposalPlaceholder(assessment.unit)))
    || compareThreshold(assessment.actual, assessment.operator, assessment.threshold) !== assessment.breached) {
    throw batchError("source_merge_threshold_invalid", `Proposal fact ${factNumber} has an invalid thresholdAssessment.`);
  }
}

function containsProposalPlaceholder(value) {
  if (typeof value === "string") return /^<[^<>]+>$/u.test(value.trim());
  if (Array.isArray(value)) return value.some(containsProposalPlaceholder);
  if (isRecord(value)) return Object.values(value).some(containsProposalPlaceholder);
  return false;
}

export async function initializeDeliverableSkeletons(workspaceRoot, deliverables) {
  const workspace = resolve(workspaceRoot);
  const result = { created: [], preserved: [], unsupported: [] };
  const missingTextDeliverables = [];

  for (const deliverable of Array.isArray(deliverables) ? deliverables : []) {
    if (isRecord(deliverable) && deliverable.required === false) continue;
    if (!isRecord(deliverable) || !nonEmpty(deliverable.path)) {
      throw deliverableSkeletonError("deliverable_skeleton_invalid", "Every deliverable skeleton requires a non-empty workspace-relative path.");
    }

    let filePath;
    try {
      filePath = await resolveSafeWorkspacePath(workspace, deliverable.path, { allowMissing: true });
    } catch (error) {
      throw deliverableSkeletonError("deliverable_skeleton_path_invalid", errorMessage(error));
    }

    const info = await lstat(filePath).catch((error) => {
      if (error?.code === "ENOENT") return undefined;
      throw error;
    });
    if (info) {
      if (!info.isFile()) {
        throw deliverableSkeletonError(
          "deliverable_skeleton_target_invalid",
          `Existing deliverable target is not a regular file: ${deliverable.path}.`,
        );
      }
      result.preserved.push({ path: deliverable.path, reason: "already_exists" });
      continue;
    }

    const extension = extname(filePath).toLowerCase();
    if (!TEXT_EXTENSIONS.has(extension)) {
      result.unsupported.push({ path: deliverable.path, reason: "non_text_format" });
      continue;
    }
    missingTextDeliverables.push({ path: deliverable.path, filePath, extension });
  }

  for (const deliverable of missingTextDeliverables) {
    const parentPath = dirname(deliverable.filePath);
    const parentWorkspacePath = toWorkspacePath(workspace, parentPath) || ".";
    try {
      await resolveSafeWorkspacePath(workspace, parentWorkspacePath, { allowMissing: true });
      await mkdir(parentPath, { recursive: true });
      await resolveSafeWorkspacePath(workspace, parentWorkspacePath);
      await resolveSafeWorkspacePath(workspace, deliverable.path, { allowMissing: true });
      await writeFile(deliverable.filePath, deliverableSkeletonContent(deliverable.extension), {
        encoding: "utf8",
        flag: "wx",
        mode: 0o600,
      });
      result.created.push({ path: deliverable.path });
    } catch (error) {
      if (error?.code === "EEXIST") {
        try {
          const existingPath = await resolveSafeWorkspacePath(workspace, deliverable.path);
          const info = await lstat(existingPath);
          if (!info.isFile()) throw new Error(`Existing target is not a regular file: ${deliverable.path}.`);
          result.preserved.push({ path: deliverable.path, reason: "created_concurrently" });
          continue;
        } catch (existingError) {
          throw deliverableSkeletonError("deliverable_skeleton_target_invalid", errorMessage(existingError));
        }
      }
      throw deliverableSkeletonError("deliverable_skeleton_write_failed", errorMessage(error));
    }
  }

  return result;
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

export async function nextCoverageBatch(workspaceRoot, options = {}) {
  const loaded = await readWorkspaceState(workspaceRoot);
  const limit = boundedInteger(options.limit, 1, 12, 12);
  const maxSerializedBytes = boundedInteger(options.maxSerializedBytes, 1024, 24576, 24576);
  const validation = options.validationResult
    ?? await validateWorkspace({ workspaceRoot: loaded.workspace, writeProof: false });
  const coverage = isRecord(loaded.state.coverage) ? loaded.state.coverage : {};
  const groups = [];

  const deliverableRows = Array.isArray(coverage.deliverables) ? coverage.deliverables : [];
  const deliverables = [];
  for (const deliverable of Array.isArray(loaded.state.config?.deliverables) ? loaded.state.config.deliverables : []) {
    if (!isRecord(deliverable) || deliverable.required === false || !nonEmpty(deliverable.path)) continue;
    let actualSha256;
    try {
      const path = await resolveSafeWorkspacePath(loaded.workspace, deliverable.path);
      actualSha256 = sha256(await readFile(path));
    } catch {}
    const existingCoverage = deliverableRows.find((row) => row?.path === deliverable.path);
    if (!actualSha256 || existingCoverage?.sha256 !== actualSha256) {
      deliverables.push({
        id: deliverable.id,
        path: deliverable.path,
        actualSha256: actualSha256 ?? null,
        existingCoverage: isRecord(existingCoverage) ? existingCoverage : null,
      });
    }
  }
  groups.push({ group: "deliverables", items: deliverables });

  const sourceRows = Array.isArray(coverage.sources) ? coverage.sources : [];
  groups.push({
    group: "sources",
    items: (Array.isArray(loaded.state.sources?.sources) ? loaded.state.sources.sources : [])
      .filter((source) => isRecord(source) && nonEmpty(source.id)
        && (source.status === "unreadable" || stringArray(source.unresolvedItems).length > 0))
      .map((source) => ({
        sourceId: source.id,
        path: source.path,
        status: source.status,
        unresolvedItems: stringArray(source.unresolvedItems),
        requiredStatus: "unresolved",
        existingCoverage: coverageRowFor(sourceRows, "sourceId", source.id),
      }))
      .filter((item) => coverageRowNeedsRepair(item.existingCoverage, true)),
  });

  const factRows = Array.isArray(coverage.facts) ? coverage.facts : [];
  groups.push({
    group: "facts",
    items: (Array.isArray(loaded.state.facts?.facts) ? loaded.state.facts.facts : [])
      .filter((fact) => isRecord(fact) && nonEmpty(fact.id) && (fact.material === true || fact.critical === true))
      .map((fact) => {
        const unresolved = fact.conflictStatus === "unresolved" || fact.verificationStatus !== "verified";
        return {
          factId: fact.id,
          subject: fact.subject,
          predicate: fact.predicate,
          value: fact.value,
          unit: fact.unit,
          dateOrPeriod: fact.dateOrPeriod,
          sourceRefs: fact.sourceRefs,
          requiredStatus: unresolved ? "unresolved" : "covered",
          existingCoverage: coverageRowFor(factRows, "factId", fact.id),
        };
      })
      .filter((item) => coverageRowNeedsRepair(item.existingCoverage, item.requiredStatus === "unresolved")),
  });

  const issueRows = Array.isArray(coverage.issues) ? coverage.issues : [];
  groups.push({
    group: "issues",
    items: (Array.isArray(loaded.state.issues?.issues) ? loaded.state.issues.issues : [])
      .filter((legalIssue) => isRecord(legalIssue) && nonEmpty(legalIssue.id))
      .map((legalIssue) => ({
        issueId: legalIssue.id,
        status: legalIssue.status,
        severity: legalIssue.severity,
        analysis: legalIssue.analysis,
        conclusion: legalIssue.conclusion,
        recommendations: legalIssue.recommendations,
        requiredStatus: legalIssue.status === "unresolved" ? "unresolved" : "covered",
        existingCoverage: coverageRowFor(issueRows, "issueId", legalIssue.id),
      }))
      .filter((item) => coverageRowNeedsRepair(item.existingCoverage, item.requiredStatus === "unresolved")),
  });

  const authorityRows = Array.isArray(coverage.authorities) ? coverage.authorities : [];
  groups.push({
    group: "authorities",
    items: (Array.isArray(loaded.state.authorities?.authorities) ? loaded.state.authorities.authorities : [])
      .filter((authority) => isRecord(authority) && nonEmpty(authority.id) && authority.verificationStatus !== "not-applicable")
      .map((authority) => ({
        authorityId: authority.id,
        name: authority.name,
        article: authority.article,
        verificationStatus: authority.verificationStatus,
        supportedConclusion: authority.supportedConclusion,
        requiredStatus: authority.verificationStatus === "pending-verification" ? "unresolved" : "covered",
        existingCoverage: coverageRowFor(authorityRows, "authorityId", authority.id),
      }))
      .filter((item) => coverageRowNeedsRepair(item.existingCoverage, item.requiredStatus === "unresolved")),
  });

  const selected = groups.find((group) => group.items.length > 0);
  if (selected) return packCoverageBatch(
    selected.group,
    selected.items,
    limit,
    maxSerializedBytes,
    validation.stateHash,
  );

  const errors = validation.errors.filter((error) => error.phase === "coverage");
  return packCoverageBatch("validation-errors", errors, limit, maxSerializedBytes, validation.stateHash);
}

export function coverageBatchSchema() {
  return {
    schemaVersion: 1,
    command: "apply-batch",
    input: {
      type: "object",
      required: ["schemaVersion", "phase", "group", "expectedStateHash", "items"],
      additionalProperties: false,
      properties: {
        schemaVersion: { const: 1 },
        phase: { const: "coverage" },
        group: { enum: ["deliverables", "sources", "facts", "issues", "authorities"] },
        expectedStateHash: { type: "string", pattern: "^[a-f0-9]{64}$" },
        items: { type: "array", minItems: 1, maxItems: 12, items: { type: "object" } },
      },
    },
    limits: { maxRecords: 12, maxSerializedBytes: 24576 },
    identityFields: coverageIdentityFields(),
  };
}

export async function applyCoverageBatch(workspaceRoot, patch, options = {}) {
  const maxRecords = boundedInteger(options.limit, 1, 12, 12);
  const maxSerializedBytes = boundedInteger(options.maxSerializedBytes, 1024, 24576, 24576);
  validateCoverageBatchPatch(patch, { maxRecords, maxSerializedBytes });

  const before = await validateWorkspace({ workspaceRoot, writeProof: false });
  if (patch.expectedStateHash !== before.stateHash) {
    throw batchError(
      "stale_state_hash",
      `expectedStateHash ${patch.expectedStateHash} does not match current state ${before.stateHash}. Run next-batch again.`,
    );
  }

  const current = await nextCoverageBatch(workspaceRoot, {
    limit: maxRecords,
    maxSerializedBytes,
    validationResult: before,
  });
  if (current.group === "validation-errors") {
    throw batchError("batch_not_applicable", "Current coverage errors require direct ledger or deliverable repair, not apply-batch.");
  }
  if (patch.group !== current.group) {
    throw batchError("batch_group_mismatch", `Current batch group is ${current.group}, not ${patch.group}.`);
  }

  const identityField = coverageIdentityFields()[patch.group];
  const allowedIds = new Set(current.items.map((item) => coverageBatchItemIdentity(patch.group, item)).filter(nonEmpty));
  const seen = new Set();
  for (const item of patch.items) {
    const id = item[identityField];
    if (!nonEmpty(id)) throw batchError("batch_identity_missing", `${patch.group} item requires ${identityField}.`);
    if (seen.has(id)) throw batchError("batch_identity_duplicate", `Duplicate ${identityField} ${id} in apply-batch input.`);
    if (!allowedIds.has(id)) throw batchError("batch_item_out_of_scope", `${identityField} ${id} is not in the current next-batch slice.`);
    seen.add(id);
  }

  const loaded = await readWorkspaceState(workspaceRoot);
  const coverage = loaded.state.coverage;
  if (!isRecord(coverage) || !Array.isArray(coverage[patch.group])) {
    throw batchError("coverage_state_invalid", `coverage.json must contain a ${patch.group} array before apply-batch.`);
  }
  const updates = new Map(patch.items.map((item) => [item[identityField], item]));
  const untouched = coverage[patch.group].filter((row) => !isRecord(row) || !updates.has(row[identityField]));
  const nextRows = [...untouched, ...patch.items]
    .sort((left, right) => String(left?.[identityField] ?? "").localeCompare(String(right?.[identityField] ?? "")));
  const nextCoverage = { ...coverage, [patch.group]: nextRows };
  await writeJsonAtomic(loaded.paths.coverage, nextCoverage);

  const after = await validateWorkspace({ workspaceRoot, writeProof: true });
  const nextBatch = after.passed ? null : await nextCoverageBatch(workspaceRoot, {
    limit: maxRecords,
    maxSerializedBytes,
    validationResult: after,
  });
  return {
    applied: true,
    phase: "coverage",
    group: patch.group,
    updated: patch.items.length,
    previousStateHash: before.stateHash,
    stateHash: after.stateHash,
    passed: after.passed,
    errorCountBefore: before.errors.length,
    errorCountAfter: after.errors.length,
    nextBatch,
  };
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
    inputManifest: undefined,
    manifestSources: new Map(),
    proofPathSafe: true,
  };

  try {
    await resolveSafeWorkspacePath(workspace, PROOF_PATH, { allowMissing: true });
  } catch (error) {
    context.proofPathSafe = false;
    add(context, "configuration", "proof_path_invalid", errorMessage(error), PROOF_PATH);
  }

  await loadInputManifest(context);
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
        ...(context.inputManifest
          ? { inputManifest: {
              path: INPUT_MANIFEST_PATH,
              sha256: context.inputManifest.sha256,
              originalRoot: context.inputManifest.originalRoot,
              derivedRoot: context.inputManifest.derivedRoot,
            } }
          : {}),
        sources: [...context.sources.entries()]
          .map(([path, value]) => context.inputManifest
            ? { path, sha256: value.sha256, bytes: value.bytes, derivedArtifacts: value.derivedArtifacts ?? [] }
            : { path, sha256: value.sha256, bytes: value.bytes })
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
    ...(context.inputManifest
      ? { inputManifest: {
          path: INPUT_MANIFEST_PATH,
          sha256: context.inputManifest.sha256,
          originalRoot: context.inputManifest.originalRoot,
          derivedRoot: context.inputManifest.derivedRoot,
        } }
      : {}),
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
  const initialize = initializerCommandFor(result, cliPath);
  const reference = referenceCommandFor(first?.phase, cliPath);
  const sourceBootstrap = sourceBootstrapCommandFor(result, cliPath);
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
    sourceBootstrap ? `Bootstrap the manifest-bound source ledger with: ${sourceBootstrap}` : undefined,
    reference ? `Load the bundled legal guidance through its stable CLI interface before the next canonical write: ${reference}` : undefined,
    `After the fix, run: ${command}`,
    "Do not claim completion and do not create completion-proof.json manually.",
  ].filter(Boolean).join("\n");
}

export function milestoneDigest(result, workItems) {
  const first = result.errors[0];
  const repeatedErrorCount = result.errors.filter((error) => error.code === first?.code).length;
  return sha256(JSON.stringify({
    milestone: milestoneName(result),
    passed: result.passed,
    phase: first?.phase ?? null,
    code: first?.code ?? null,
    repeatedErrorCount,
    errorCount: result.errors.length,
    counts: result.counts,
    workItemsDigest: workItems ? sha256(JSON.stringify(workItems)) : null,
    validatedStateHash: result.passed ? result.stateHash : null,
  }));
}

export function convergenceStateHash(result, workItems) {
  return sha256(JSON.stringify({
    validatorStateHash: result.stateHash,
    operationalWorkDigest: workItems ? sha256(JSON.stringify(convergenceWorkProjection(workItems))) : null,
  }));
}

function convergenceWorkProjection(workItems) {
  if (!workItems?.proposal?.validationError) return workItems;
  const proposal = { ...workItems.proposal };
  delete proposal.validationError;
  // A first rejection must reach the model before the steady-state lease can
  // fail closed. Keep every rejected revision on one stable repair marker so
  // rewriting invalid proposals cannot manufacture unlimited progress.
  proposal.repairRequired = true;
  return { ...workItems, proposal };
}

export function milestoneEnvelopeFor(result, cliPath, workItems) {
  const first = result.errors[0];
  const sameCode = result.errors.filter((error) => error.code === first?.code);
  const command = `node ${JSON.stringify(cliPath)} validate --workspace \"$PWD\" --write-proof`;
  const initialize = initializerCommandFor(result, cliPath);
  const reference = referenceCommandFor(first?.phase, cliPath);
  const sourceBootstrap = sourceBootstrapCommandFor(result, cliPath);
  const sourceFragment = sourceFragmentSliceCommandFor(workItems, cliPath);
  const sourceMergeApply = sourceMergeApplyCommandFor(workItems, cliPath);
  const mutationContract = phaseMutationContractFor(result);
  const milestone = milestoneName(result);
  const representativePaths = sameCode
    .slice(0, 4)
    .map((error) => error.path)
    .filter((path) => typeof path === "string" && path.length > 0);
  const envelope = {
    milestone,
    objective: result.passed
      ? "Preserve the validated legal deliverable state while completing remaining task-specific QA."
      : objectiveForPhase(first?.phase),
    invariants: [
      "Do not invent missing legal facts or silently resolve disputed evidence.",
      "Preserve source-to-fact-to-issue-to-deliverable links.",
      "Do not create or edit completion-proof.json manually.",
    ],
    artifactPointers: result.passed
      ? ["state://legal-coverage", `workspace://${PROOF_PATH}`]
      : ["state://legal-coverage", `workspace://${STATE_DIRECTORY}/${stateFileForPhase(first?.phase)}`],
    knownGaps: result.passed ? [] : [{
      phase: first?.phase ?? "configuration",
      code: first?.code ?? "state_file_invalid",
      occurrences: sameCode.length,
      representativePaths,
    }],
    progress: result.counts,
    ...(result.passed ? {} : { workBatch: workBatchFor(first?.phase) }),
    ...(first?.phase === "configuration" ? { initializerCommand: initialize } : {}),
    ...(sourceBootstrap ? { sourceBootstrapCommand: sourceBootstrap } : {}),
    ...(sourceFragment ? { sourceFragmentCommand: sourceFragment } : {}),
    ...(sourceMergeApply ? { sourceMergeApplyCommand: sourceMergeApply } : {}),
    ...(reference ? { guidanceCommand: reference } : {}),
    ...(mutationContract ? { mutationContract } : {}),
    ...(workItems ? { workItems } : {}),
    nextAction: nextActionFor(result, sameCode.length, command, initialize, reference, sourceBootstrap, sourceFragment, sourceMergeApply, workItems),
    completionSignal: result.passed ? "legal-coverage-validated" : "legal-coverage-blocked",
  };
  return `<legal_coverage_state>\n${JSON.stringify(envelope, null, 2)}\n</legal_coverage_state>`;
}

function initializerCommandFor(result, cliPath) {
  const inputOption = result.inputManifest?.originalRoot
    ? "--input-from-manifest"
    : "--input <source-root>";
  return `node ${JSON.stringify(cliPath)} init --workspace \"$PWD\" ${inputOption} --deliverable <id>=<path> --jurisdiction <name> --basis-date <date>`;
}

function sourceBootstrapCommandFor(result, cliPath) {
  const first = result.errors[0];
  if (!result.inputManifest?.originalRoot || first?.phase !== "sources") return undefined;
  if (first.code !== "source_not_inventoried" && first.code !== "manifest_original_not_inventoried") return undefined;
  return `node ${JSON.stringify(cliPath)} bootstrap-sources --workspace \"$PWD\" --from-manifest`;
}

function sourceFragmentSliceCommandFor(workItems, cliPath) {
  if (workItems?.group !== "source-fragment-merge" || workItems?.proposal?.validationError) return undefined;
  const item = workItems.mergeItems?.[0];
  if (!item) return undefined;
  const sourceOptions = item.sourceIds.map((sourceId) => `--source-id ${JSON.stringify(sourceId)}`).join(" ");
  return `node ${JSON.stringify(cliPath)} fragment-slice --workspace "$PWD" `
    + `--fragment ${JSON.stringify(item.fragmentPath)} --receipt-sha256 ${item.receiptSha256} `
    + `${sourceOptions} --limit ${workItems.limits.maxRecords} --max-bytes ${workItems.limits.maxSerializedBytes}`;
}

function sourceMergeApplyCommandFor(workItems, cliPath) {
  if (workItems?.group !== "source-fragment-apply" || workItems?.proposal?.validated !== true) return undefined;
  return `node ${JSON.stringify(cliPath)} source-merge-apply --workspace "$PWD" `
    + `--input-file ${JSON.stringify(workItems.proposal.path)} `
    + `--proposal-sha256 ${workItems.proposal.proposalSha256} `
    + `--limit ${workItems.limits.maxRecords} --max-bytes ${workItems.limits.maxSerializedBytes}`;
}

function milestoneName(result) {
  if (result.passed) return "COMPLETE";
  switch (result.errors[0]?.phase) {
    case "configuration": return "INIT";
    case "sources": return "SOURCE_REVIEW";
    case "facts": return "SOURCES_READY";
    case "matrices":
    case "issues":
    case "authorities": return "EVIDENCE_READY";
    case "coverage": return "VALIDATING";
    default: return "INIT";
  }
}

function workBatchFor(phase) {
  switch (phase) {
    case "sources": return { scope: "one source batch", maxRecords: 12, maxSerializedBytes: 24576, validateAfterWrite: true };
    case "facts": return { scope: "one evidence fragment", maxRecords: 12, maxSerializedBytes: 24576, validateAfterWrite: true };
    case "matrices": return { scope: "one matrix", maxRecords: 1, maxSerializedBytes: 24576, validateAfterWrite: true };
    case "issues": return { scope: "one issue group", maxRecords: 8, maxSerializedBytes: 24576, validateAfterWrite: true };
    case "authorities": return { scope: "one authority group", maxRecords: 8, maxSerializedBytes: 24576, validateAfterWrite: true };
    case "coverage": return { scope: "one coverage group", maxRecords: 12, maxSerializedBytes: 24576, validateAfterWrite: true };
    default: return { scope: "one configuration repair", maxRecords: 1, maxSerializedBytes: 24576, validateAfterWrite: true };
  }
}

function phaseMutationContractFor(result) {
  const first = result.errors[0];
  if (first?.phase !== "matrices") return undefined;
  const batch = workBatchFor(first.phase);
  return {
    schemaVersion: 1,
    phase: "matrices",
    writer: "main-agent-only",
    strategy: "bounded-direct-canonical-json-write",
    canonicalPath: `${STATE_DIRECTORY}/${STATE_FILES.matrices}`,
    target: {
      errorCode: first.code,
      recordId: first.recordId ?? null,
      collectionIndex: Number.isInteger(first.collectionIndex) ? first.collectionIndex : null,
      validatorPath: first.path ?? STATE_FILES.matrices,
    },
    limits: {
      maxChangedRecords: batch.maxRecords,
      maxSerializedBytes: batch.maxSerializedBytes,
      preserveUnchangedRecords: true,
      validateAfterWrite: true,
    },
    prerequisites: [
      "Load guidanceCommand exactly if issue-rules has not already been loaded.",
      `Read ${STATE_DIRECTORY}/${STATE_FILES.matrices} and ${STATE_DIRECTORY}/${STATE_FILES.facts} before writing.`,
      "Base every entry or not-applicable reason on the canonical facts; preserve uncertainty.",
    ],
    interface: {
      kind: "workspace-file-write",
      phaseApplyCommandAvailable: false,
      instruction: "Update the canonical JSON document directly with the workspace file-write tool. Do not probe for or invent a phase-specific apply command.",
    },
    documentSchema: {
      schemaVersion: 1,
      collectionKey: "matrices",
      requiredRecordIds: REQUIRED_MATRICES,
      record: {
        required: ["id", "status", "entries"],
        statusValues: [...MATRIX_STATUSES],
        completeRequires: "at least one fact-grounded entry",
        notApplicableRequires: "a specific fact-grounded notApplicableReason",
      },
      entry: {
        required: ["id", "summary", "factIds"],
        optional: ["riskSignals", "issueIds", "authorityIds"],
      },
    },
  };
}

function nextActionFor(result, occurrenceCount, command, initialize, reference, sourceBootstrap, sourceFragment, sourceMergeApply, workItems) {
  if (result.passed) {
    return "Run any remaining task-specific deliverable QA; rerun legal coverage validation after any bound artifact changes.";
  }
  const first = result.errors[0];
  if (first?.phase === "configuration") {
    return `Use the initializer as the next tool call before inspecting plugin or validator source. `
      + `Replace placeholders from the user request and ${INPUT_MANIFEST_PATH}; if a required value is absent, `
      + `record an explicit pending-confirmation value instead of delaying initialization. Initializer: ${initialize}. `
      + `Then run: ${command}`;
  }
  if (first?.code === "deliverable_missing" && nonEmpty(first.path)) {
    return `Create a non-empty user deliverable skeleton at the exact configured workspace-relative path `
      + `${JSON.stringify(first.path)} with write_file, then run: ${command}. `
      + `Do not change the configured path or move the user deliverable into ${STATE_DIRECTORY} merely because it does not exist yet.`;
  }
  if (sourceBootstrap) {
    const guidance = reference
      ? `Load the bundled data contract with: ${reference}. `
      : "";
    return `Execute this exact deterministic source bootstrap before manually listing manifest rows: ${sourceBootstrap}. `
      + guidance
      + `Then delegate disjoint pending-source batches, merge returned fragments as the single canonical writer, and run: ${command}`;
  }
  if (first?.phase === "sources" && first.code === "source_pending"
    && workItems?.group === "source-fragment-merge") {
    if (workItems.proposal?.validationError) {
      return `The source-merge proposal at ${JSON.stringify(workItems.proposal.path)} was rejected with `
        + `${workItems.proposal.validationError.code}: ${workItems.proposal.validationError.message}. `
        + `Rewrite that proposal from the already returned bounded fragment slice and injected proposal.template. `
        + `Set thresholdAssessment to null unless the source supports a numeric threshold comparison; when present it must be `
        + `an object with operator, numeric actual, numeric threshold, optional unit, and boolean breached, never prose. `
        + `Do not re-read fragments or raw sources, and do not edit canonical ledgers.`;
    }
    const item = workItems.mergeItems?.[0];
    return `A validated worker receipt is ready. In the same assistant response, execute sourceFragmentCommand exactly and issue sibling read_file calls for current sources.json and facts.json: ${sourceFragment}. `
      + `In the next response, without another inspection call, write one source-merge proposal to ${JSON.stringify(workItems.proposal.path)} using the injected proposal.template for only source IDs ${(item?.sourceIds ?? []).join(", ")}. `
      + `Replace every placeholder with your source-grounded legal judgment, remove unused optional null fields when appropriate, and use only exact locators returned by sourceFragmentCommand. `
      + `Set thresholdAssessment to null unless the source supports a numeric threshold comparison; when present it must be `
      + `an object with operator, numeric actual, numeric threshold, optional unit, and boolean breached, never prose. `
      + `Do not re-dispatch workers or re-read raw sources. Do not edit canonical ledgers. The Legal Plugin will validate the proposal receipt before exposing an apply command.`;
  }
  if (first?.phase === "sources" && first.code === "source_pending"
    && workItems?.group === "source-fragment-apply") {
    return `The bounded source-merge proposal is valid and state-bound. Execute sourceMergeApplyCommand exactly as the next tool call: ${sourceMergeApply}. `
      + `Do not inspect or edit either canonical ledger manually. The command atomically projects the accepted facts into facts.json and their reciprocal links into sources.json, then validates the resulting state.`;
  }
  if (first?.phase === "sources" && first.code === "source_pending" && workItems?.mode === "delegated") {
    return "Dispatch every injected workItems.batches entry now with one agent tool call per batch in the same assistant response. "
      + "Pass each batch.agentInput object to the agent tool verbatim. Do not call bash, read_file, glob, or grep first; "
      + "do not re-list sources that are already partitioned. After all workers return, execute guidanceCommand if it has not already "
      + "been loaded, read only their fragments, merge one bounded canonical batch, and run: " + command;
  }
  const batch = workBatchFor(first?.phase);
  if (first?.phase === "coverage") {
    const inspect = command.replace(" validate ", " next-batch --phase coverage --limit 12 --max-bytes 24576 ")
      .replace(" --write-proof", "");
    const apply = command.replace(" validate ", " apply-batch --phase coverage --input-file <workspace-relative-patch.json> ")
      .replace(" --write-proof", "");
    return `Use the injected workItems as the next deterministic coverage slice. If it contains only a pointer, inspect it with: ${inspect}. `
      + `Write one patch matching the bundled schema, then apply it atomically with: ${apply}. `
      + `Repair at most ${batch.maxRecords} records and ${batch.maxSerializedBytes} serialized bytes, then run: ${command}. `
      + "Repeat only after validation reports progress.";
  }
  const guidance = reference
    ? `Before the next canonical write, load the bundled guidance with this exact command instead of guessing a workspace-relative references path: ${reference}. `
    : "";
  if (first?.phase === "matrices") {
    const target = first.recordId ? ` ${JSON.stringify(first.recordId)}` : " identified by mutationContract.target";
    return guidance + `Follow mutationContract as the complete write interface. Read its canonicalPath and facts.json, then as the sole canonical writer update only matrix${target} `
      + `with the workspace file-write tool while preserving every other record. Change at most one matrix and ${batch.maxSerializedBytes} serialized bytes. `
      + `There is no phase-specific apply command for this write; do not inspect CLI help, probe for, or invent one. Then run: ${command}. `
      + "Repeat only after validation reports progress.";
  }
  return guidance + `Repair the next ${batch.scope} for ${first?.code ?? "state_file_invalid"} `
    + `(up to ${batch.maxRecords} records and ${batch.maxSerializedBytes} serialized bytes; `
    + `${occurrenceCount} occurrence(s) currently visible), then run: ${command}. `
    + "Repeat with the next bounded batch only after validation reports progress.";
}

function referenceCommandFor(phase, cliPath) {
  if (phase === "sources" || phase === "facts" || phase === "coverage") {
    return `node ${JSON.stringify(cliPath)} reference --name data-contracts`;
  }
  if (phase === "matrices" || phase === "issues" || phase === "authorities") {
    return `node ${JSON.stringify(cliPath)} reference --name issue-rules`;
  }
  return undefined;
}

function legalCoverageError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function objectiveForPhase(phase) {
  switch (phase) {
    case "sources": return "Complete source inventory and evidence review.";
    case "facts": return "Complete sourced legal fact records without unsupported conclusions.";
    case "matrices": return "Complete only the due-diligence projections required by this workflow.";
    case "issues": return "Resolve or disclose material legal issues and contradictions.";
    case "authorities": return "Verify and link controlling legal authorities.";
    case "coverage": return "Reconcile reviewed records with the requested deliverables.";
    default: return "Configure the legal coverage workspace for this task.";
  }
}

function stateFileForPhase(phase) {
  switch (phase) {
    case "sources": return "sources.json";
    case "facts": return "facts.json";
    case "matrices": return "matrices.json";
    case "issues": return "issues.json";
    case "authorities": return "authorities.json";
    case "coverage": return "coverage.json";
    default: return "config.json";
  }
}

function coverageRowFor(rows, idField, id) {
  const row = rows.find((candidate) => candidate?.[idField] === id);
  return isRecord(row) ? row : null;
}

function coverageRowNeedsRepair(row, requireUnresolved) {
  if (!isRecord(row)) return true;
  if (!COVERAGE_STATUSES.has(row.status) || (requireUnresolved && row.status !== "unresolved")) return true;
  return !nonEmpty(row.deliverablePath) || !nonEmpty(row.section) || !nonEmpty(row.claim) || !nonEmpty(row.locator);
}

function packCoverageBatch(group, candidates, limit, maxSerializedBytes, stateHash) {
  const items = [];
  let serializedBytes = 0;
  for (const candidate of candidates.slice(0, limit)) {
    const candidateBytes = Buffer.byteLength(JSON.stringify(candidate));
    if (candidateBytes > maxSerializedBytes) {
      if (items.length === 0) {
        items.push({
          id: candidate.factId ?? candidate.issueId ?? candidate.authorityId ?? candidate.sourceId ?? candidate.id ?? null,
          oversizedRecord: true,
          serializedBytes: candidateBytes,
          recordPointer: `state://legal-coverage/${group}`,
        });
      }
      break;
    }
    if (serializedBytes + candidateBytes > maxSerializedBytes) break;
    items.push(candidate);
    serializedBytes += candidateBytes;
  }
  return {
    phase: "coverage",
    group,
    stateHash,
    remaining: candidates.length,
    returned: items.length,
    hasMore: candidates.length > items.length,
    limits: { maxRecords: limit, maxSerializedBytes },
    serializedBytes,
    items,
  };
}

function coverageIdentityFields() {
  return {
    deliverables: "path",
    sources: "sourceId",
    facts: "factId",
    issues: "issueId",
    authorities: "authorityId",
  };
}

function coverageBatchItemIdentity(group, item) {
  if (!isRecord(item)) return undefined;
  if (group === "deliverables") return item.path;
  return item[coverageIdentityFields()[group]];
}

function validateCoverageBatchPatch(patch, limits) {
  if (!isRecord(patch)) throw batchError("batch_not_object", "apply-batch input must be a JSON object.");
  const keys = Object.keys(patch).sort();
  const expectedKeys = ["expectedStateHash", "group", "items", "phase", "schemaVersion"];
  if (JSON.stringify(keys) !== JSON.stringify(expectedKeys)) {
    throw batchError("batch_keys_invalid", `apply-batch input must contain only: ${expectedKeys.join(", ")}.`);
  }
  if (patch.schemaVersion !== 1) throw batchError("batch_schema_version_invalid", "apply-batch schemaVersion must be 1.");
  if (patch.phase !== "coverage") throw batchError("batch_phase_invalid", "apply-batch phase must be coverage.");
  if (!Object.hasOwn(coverageIdentityFields(), patch.group)) {
    throw batchError("batch_group_invalid", `Unsupported coverage group: ${String(patch.group)}.`);
  }
  if (!/^[a-f0-9]{64}$/u.test(String(patch.expectedStateHash ?? ""))) {
    throw batchError("batch_state_hash_invalid", "expectedStateHash must be a lowercase SHA-256 value.");
  }
  if (!Array.isArray(patch.items) || patch.items.length === 0 || patch.items.length > limits.maxRecords) {
    throw batchError("batch_record_limit", `apply-batch items must contain 1..${limits.maxRecords} records.`);
  }
  if (patch.items.some((item) => !isRecord(item))) {
    throw batchError("batch_item_invalid", "Every apply-batch item must be a JSON object.");
  }
  const serializedBytes = Buffer.byteLength(JSON.stringify(patch));
  if (serializedBytes > limits.maxSerializedBytes) {
    throw batchError("batch_byte_limit", `apply-batch input is ${serializedBytes} bytes; maximum is ${limits.maxSerializedBytes}.`);
  }
}

function batchError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function boundedInteger(value, minimum, maximum, fallback) {
  const number = Number(value);
  if (!Number.isInteger(number)) return fallback;
  return Math.min(maximum, Math.max(minimum, number));
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

async function loadInputManifest(context) {
  let manifestBytes;
  try {
    const manifestPath = await resolveSafeWorkspacePath(context.workspace, INPUT_MANIFEST_PATH, { allowMissing: true });
    manifestBytes = await readFile(manifestPath);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    add(context, "sources", "input_manifest_unreadable", `Cannot read ${INPUT_MANIFEST_PATH}: ${errorMessage(error)}`, INPUT_MANIFEST_PATH);
    return;
  }

  let manifest;
  try {
    manifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch (error) {
    add(context, "sources", "input_manifest_invalid", `${INPUT_MANIFEST_PATH} is not valid JSON: ${errorMessage(error)}`, INPUT_MANIFEST_PATH);
    return;
  }
  if (!isRecord(manifest) || manifest.schemaVersion !== 1 || manifest.createdBy !== "pilotdeck-eval-runner") {
    add(context, "sources", "input_manifest_invalid", `${INPUT_MANIFEST_PATH} must be a pilotdeck-eval-runner schemaVersion 1 object.`, INPUT_MANIFEST_PATH);
    return;
  }

  let originalRoot;
  let derivedRoot;
  try {
    originalRoot = normalizeManifestWorkspacePath(manifest.originalRoot, "originalRoot");
    derivedRoot = normalizeManifestWorkspacePath(manifest.derivedRoot, "derivedRoot");
    await resolveSafeWorkspacePath(context.workspace, originalRoot);
    await resolveSafeWorkspacePath(context.workspace, derivedRoot);
    if (workspacePathWithin(originalRoot, STATE_DIRECTORY)
      || workspacePathWithin(STATE_DIRECTORY, originalRoot)
      || workspacePathWithin(derivedRoot, STATE_DIRECTORY)
      || workspacePathWithin(STATE_DIRECTORY, derivedRoot)) {
      throw new Error("Input manifest roots must not use legal-coverage mutable work state.");
    }
    if (workspacePathWithin(originalRoot, derivedRoot) || workspacePathWithin(derivedRoot, originalRoot)) {
      throw new Error("Input manifest originalRoot and derivedRoot must be disjoint.");
    }
  } catch (error) {
    add(context, "sources", "input_manifest_roots_invalid", errorMessage(error), INPUT_MANIFEST_PATH);
    return;
  }

  if (!Array.isArray(manifest.entries)) {
    add(context, "sources", "input_manifest_entries_invalid", `${INPUT_MANIFEST_PATH} must contain an entries array.`, INPUT_MANIFEST_PATH);
    return;
  }

  const originalPaths = new Set();
  const derivedPaths = new Set();
  for (const [index, entry] of manifest.entries.entries()) {
    const at = `${INPUT_MANIFEST_PATH}#entries[${index}]`;
    if (!isRecord(entry) || !isRecord(entry.original) || !Array.isArray(entry.derivations)) {
      add(context, "sources", "input_manifest_entry_invalid", "Each input manifest entry requires original and derivations records.", at);
      continue;
    }
    let originalRelative;
    try {
      originalRelative = normalizeManifestRelativePath(entry.original.path, "original.path");
      validateManifestDigestRecord(entry.original, "original");
    } catch (error) {
      add(context, "sources", "input_manifest_entry_invalid", errorMessage(error), at);
      continue;
    }
    const originalPath = `${originalRoot}/${originalRelative}`;
    if (originalPaths.has(originalPath)) {
      add(context, "sources", "input_manifest_original_duplicate", `Duplicate original input path: ${originalPath}.`, at);
      continue;
    }
    originalPaths.add(originalPath);
    const actualOriginal = await verifyManifestFile(context, originalPath, entry.original, "input_manifest_original_stale", at);

    const derivations = [];
    for (const [derivationIndex, derivation] of entry.derivations.entries()) {
      const derivationAt = `${at}.derivations[${derivationIndex}]`;
      if (!isRecord(derivation)) {
        add(context, "sources", "input_manifest_derivation_invalid", "Each derivation must be an object.", derivationAt);
        continue;
      }
      let derivedRelative;
      try {
        derivedRelative = normalizeManifestRelativePath(derivation.path, "derivation.path");
        validateManifestDigestRecord(derivation, "derivation");
        if (!nonEmpty(derivation.method) || !nonEmpty(derivation.version)) {
          throw new Error("Derivations require method and version.");
        }
      } catch (error) {
        add(context, "sources", "input_manifest_derivation_invalid", errorMessage(error), derivationAt);
        continue;
      }
      const derivedPath = `${derivedRoot}/${derivedRelative}`;
      if (derivedPaths.has(derivedPath)) {
        add(context, "sources", "input_manifest_derivation_duplicate", `Duplicate derived input path: ${derivedPath}.`, derivationAt);
        continue;
      }
      derivedPaths.add(derivedPath);
      const actualDerived = await verifyManifestFile(context, derivedPath, derivation, "input_manifest_derivation_stale", derivationAt);
      derivations.push({
        path: derivedPath,
        sha256: derivation.sha256,
        bytes: derivation.bytes,
        extractionMethod: derivation.method,
        extractorVersion: derivation.version,
        actual: actualDerived,
      });
    }
    context.manifestSources.set(originalPath, {
      path: originalPath,
      sha256: entry.original.sha256,
      bytes: entry.original.bytes,
      actual: actualOriginal,
      derivations,
    });
  }

  context.inputManifest = {
    sha256: sha256(manifestBytes),
    originalRoot,
    derivedRoot,
  };
}

async function verifyManifestFile(context, path, record, code, at) {
  try {
    const resolved = await resolveSafeWorkspacePath(context.workspace, path);
    const info = await lstat(resolved);
    if (!info.isFile()) throw new Error("Path is not a file.");
    const data = await readFile(resolved);
    const actual = { sha256: sha256(data), bytes: data.byteLength };
    if (actual.sha256 !== record.sha256 || actual.bytes !== record.bytes) {
      add(context, "sources", code, `Input manifest digest is stale for ${path}.`, path);
    }
    return actual;
  } catch (error) {
    add(context, "sources", code, `Input manifest file is missing or unsafe for ${path}: ${errorMessage(error)}`, at);
    return undefined;
  }
}

function validateManifestDigestRecord(record, label) {
  if (!/^[a-f0-9]{64}$/u.test(record.sha256 ?? "")) throw new Error(`${label} requires a lowercase SHA-256.`);
  if (!Number.isSafeInteger(record.bytes) || record.bytes < 0) throw new Error(`${label} requires a non-negative integer byte count.`);
}

function normalizeManifestWorkspacePath(value, field) {
  const path = normalizeManifestRelativePath(value, field);
  if (path === "." || path === STATE_DIRECTORY) throw new Error(`${field} is not a valid immutable input root.`);
  return path;
}

function normalizeManifestRelativePath(value, field) {
  if (!nonEmpty(value) || isAbsolute(value) || value.includes("\\")) {
    throw new Error(`${field} must be a non-empty POSIX workspace-relative path.`);
  }
  const segments = value.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new Error(`${field} contains an unsafe path segment.`);
  }
  return segments.join("/");
}

function workspacePathWithin(candidate, root) {
  return candidate === root || candidate.startsWith(`${root}/`);
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
  } else {
    for (const [index, inputRoot] of config.inputRoots.entries()) {
      if (!nonEmpty(inputRoot)) continue;
      const at = `${STATE_FILES.config}#inputRoots[${index}]`;
      try {
        const normalizedRoot = toWorkspacePath(context.workspace, resolveWithinWorkspace(context.workspace, inputRoot)) || ".";
        if (normalizedRoot === "." || workspacePathWithin(normalizedRoot, STATE_DIRECTORY) || workspacePathWithin(STATE_DIRECTORY, normalizedRoot)) {
          add(context, "configuration", "input_root_uses_mutable_state", `Input root must not contain legal-coverage mutable work state: ${inputRoot}.`, at);
        }
        if (context.inputManifest && !workspacePathWithin(normalizedRoot, context.inputManifest.originalRoot)) {
          add(context, "configuration", "input_root_not_original", `When ${INPUT_MANIFEST_PATH} is present, input roots must select original files under ${context.inputManifest.originalRoot}.`, at);
        }
      } catch (error) {
        add(context, "configuration", "input_root_invalid", errorMessage(error), at);
      }
    }
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
      const filePath = await resolveSafeWorkspacePath(context.workspace, deliverable.path, { allowMissing: true });
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
        const manifestSource = context.manifestSources.get(source.path);
        const derivedArtifacts = context.inputManifest
          ? validateSourceDerivedArtifacts(context, source, manifestSource, at)
          : [];
        context.sources.set(source.path, { ...actual, derivedArtifacts });
        if (!/^[a-f0-9]{64}$/u.test(source.sha256 ?? "")) {
          add(context, "sources", "source_hash_missing", `Source ${source.id} must bind the SHA-256 recorded when it was reviewed.`, at);
        } else if (source.sha256 !== actual.sha256) {
          add(context, "sources", "source_hash_stale", `Source ${source.id} changed after its ledger row was reviewed. Re-inspect it and update the dependent ledgers before recording a new hash.`, source.path);
        }
      }
    } catch (error) {
      add(context, "sources", "source_path_invalid", errorMessage(error), at);
    }
    if (context.inputManifest && !context.manifestSources.has(source.path)) {
      add(context, "sources", "source_not_in_input_manifest", `Source ${source.id} must bind an original file listed by ${INPUT_MANIFEST_PATH}, not a derived or Agent-created file.`, source.path);
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
  if (context.inputManifest) {
    for (const path of context.manifestSources.keys()) {
      if (!paths.has(path)) add(context, "sources", "manifest_original_not_inventoried", `Input-manifest original is not represented in sources.json: ${path}.`, path);
    }
  }
}

function validateSourceDerivedArtifacts(context, source, manifestSource, at) {
  const recorded = Array.isArray(source.derivedArtifacts) ? source.derivedArtifacts : [];
  if (!manifestSource) {
    if (recorded.length > 0) add(context, "sources", "source_derivation_unbound", `Source ${source.id} records derivations without a matching input-manifest original.`, at);
    return [];
  }

  const expected = new Map(manifestSource.derivations.map((item) => [item.path, item]));
  const requiresDerivation = source.status === "reviewed" && !TEXT_EXTENSIONS.has(extname(source.path).toLowerCase());
  if (requiresDerivation && expected.size === 0) {
    add(context, "sources", "source_derivation_unavailable", `Reviewed non-text source ${source.id} has no verified derivation in ${INPUT_MANIFEST_PATH}.`, at);
  }
  if (requiresDerivation && recorded.length === 0) {
    add(context, "sources", "source_derivation_missing", `Reviewed non-text source ${source.id} must record the derivedArtifacts used for inspection.`, at);
  }

  const seen = new Set();
  const verified = [];
  for (const [index, artifact] of recorded.entries()) {
    const artifactAt = `${at}.derivedArtifacts[${index}]`;
    if (!isRecord(artifact) || !nonEmpty(artifact.path)) {
      add(context, "sources", "source_derivation_invalid", `Source ${source.id} has an invalid derivedArtifacts row.`, artifactAt);
      continue;
    }
    if (seen.has(artifact.path)) {
      add(context, "sources", "source_derivation_duplicate", `Source ${source.id} repeats derived artifact ${artifact.path}.`, artifactAt);
      continue;
    }
    seen.add(artifact.path);
    const expectedArtifact = expected.get(artifact.path);
    if (!expectedArtifact) {
      add(context, "sources", "source_derivation_not_in_manifest", `Derived artifact ${artifact.path} is not bound to original source ${source.path}.`, artifactAt);
      continue;
    }
    if (artifact.sha256 !== expectedArtifact.sha256
      || artifact.extractionMethod !== expectedArtifact.extractionMethod
      || artifact.extractorVersion !== expectedArtifact.extractorVersion) {
      add(context, "sources", "source_derivation_stale", `Derived artifact metadata for ${artifact.path} does not match ${INPUT_MANIFEST_PATH}.`, artifactAt);
      continue;
    }
    if (!expectedArtifact.actual
      || expectedArtifact.actual.sha256 !== expectedArtifact.sha256
      || expectedArtifact.actual.bytes !== expectedArtifact.bytes) {
      add(context, "sources", "source_derivation_stale", `Derived artifact bytes for ${artifact.path} no longer match ${INPUT_MANIFEST_PATH}.`, artifactAt);
      continue;
    }
    verified.push({
      path: expectedArtifact.path,
      sha256: expectedArtifact.sha256,
      bytes: expectedArtifact.bytes,
      extractionMethod: expectedArtifact.extractionMethod,
      extractorVersion: expectedArtifact.extractorVersion,
    });
  }
  if (requiresDerivation) {
    for (const path of expected.keys()) {
      if (!seen.has(path)) add(context, "sources", "source_derivation_not_recorded", `Source ${source.id} did not record required derived artifact ${path}.`, at);
    }
  }
  return verified.sort((left, right) => left.path.localeCompare(right.path));
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
    if (matrix.status === "pending") {
      add(
        context,
        "matrices",
        "matrix_pending",
        `Matrix ${matrix.id} is still pending.`,
        at,
        { recordId: matrix.id, collectionIndex: index },
      );
    }
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
    .map(([path, value]) => ({
      path,
      sha256: value.sha256,
      bytes: value.bytes,
      derivedArtifacts: value.derivedArtifacts ?? [],
    }))
    .sort((a, b) => a.path.localeCompare(b.path));
  const inputManifest = context.inputManifest
    ? {
        path: INPUT_MANIFEST_PATH,
        sha256: context.inputManifest.sha256,
        originalRoot: context.inputManifest.originalRoot,
        derivedRoot: context.inputManifest.derivedRoot,
      }
    : null;
  return sha256(stableStringify({ validatorVersion: VALIDATOR_VERSION, state, inputManifest, sources, deliverables }));
}

async function writeJsonAtomic(filePath, value) {
  await mkdir(dirname(filePath), { recursive: true });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  await rename(temporary, filePath);
}

function deliverableSkeletonContent(extension) {
  if (extension === ".html" || extension === ".htm") {
    return "<!doctype html>\n<html><head><meta charset=\"utf-8\"><title>Draft legal deliverable</title></head><body><h1>Draft legal deliverable</h1><p>Status: initialized; legal analysis pending.</p></body></html>\n";
  }
  if (extension === ".csv") {
    return "section,status,notes\ninitialization,draft,legal analysis pending\n";
  }
  if (extension === ".md") {
    return "# Draft legal deliverable\n\nStatus: initialized; legal analysis pending.\n";
  }
  return "Draft legal deliverable\nStatus: initialized; legal analysis pending.\n";
}

function deliverableSkeletonError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function requireSchemaVersion(context, phase, value, path) {
  if (value.schemaVersion !== 1) add(context, phase, "schema_version_invalid", `${path} must use schemaVersion 1.`, path);
}

function uniqueId(context, set, id, phase, code, path) {
  if (set.has(id)) add(context, phase, code, `Duplicate id: ${id}.`, path);
  set.add(id);
}

function add(context, phase, code, message, path, details) {
  context.errors.push(issue(phase, code, message, path, details));
}

function issue(phase, code, message, path, details) {
  return { phase, code, message, path, ...(isRecord(details) ? details : {}) };
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

function hasOnlyKeys(value, allowedKeys) {
  const allowed = new Set(allowedKeys);
  return Object.keys(value).every((key) => allowed.has(key));
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
