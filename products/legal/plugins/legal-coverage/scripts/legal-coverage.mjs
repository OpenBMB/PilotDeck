#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  applyAuthorityClosure,
  applyCoverageBatch,
  applyIssueClosure,
  applyMatrixProposal,
  applyMatrixSelection,
  applySourceMergeProposal,
  applySourceMergeRepair,
  bootstrapSourcesFromManifest,
  coverageBatchSchema,
  ensureWorkspace,
  initializeDeliverableSkeletons,
  bindMatrixAnalysisFragment,
  matrixFrontierPlan,
  nextCoverageBatch,
  prepareSourceMergeProposal,
  resolveSafeWorkspacePath,
  sourceReviewFragmentSlice,
  validateWorkspace,
} from "./lib/legal-coverage.mjs";

const [command = "status", ...args] = process.argv.slice(2);
const workspaceRoot = resolve(readOption(args, "--workspace") ?? process.cwd());
const REFERENCE_FILES = {
  "data-contracts": new URL("../skills/conduct-legal-due-diligence/references/data-contracts.txt", import.meta.url),
  "issue-rules": new URL("../skills/conduct-legal-due-diligence/references/issue-rules.txt", import.meta.url),
};

if (command === "init") {
  try {
    const initialized = await ensureWorkspace(workspaceRoot);
    const config = JSON.parse(await readFile(initialized.paths.config, "utf8"));
    const inputs = readOptions(args, "--input");
    const inputFromManifest = args.includes("--input-from-manifest");
    const deliverables = readOptions(args, "--deliverable");
    const jurisdiction = readOption(args, "--jurisdiction");
    const basisDate = readOption(args, "--basis-date");
    if (inputFromManifest && inputs.length > 0) {
      throw initCliError(
        "legal_coverage_init_input_ambiguous",
        "init accepts either --input-from-manifest or explicit --input values, not both.",
      );
    }
    if (inputFromManifest) {
      const manifestValidation = await validateWorkspace({ workspaceRoot, writeProof: false });
      if (!manifestValidation.inputManifest?.originalRoot) {
        throw initCliError(
          "legal_coverage_init_manifest_unavailable",
          "--input-from-manifest requires a valid .pilotdeck/input-manifest.json with a safe originalRoot.",
        );
      }
      config.inputRoots = [manifestValidation.inputManifest.originalRoot];
    } else if (inputs.length > 0) {
      config.inputRoots = [...new Set(inputs)];
    }
    if (deliverables.length > 0) {
      config.deliverables = deliverables.map((value, index) => {
        const separator = value.indexOf("=");
        return separator > 0
          ? { id: value.slice(0, separator), path: value.slice(separator + 1), required: true }
          : { id: `deliverable-${index + 1}`, path: value, required: true };
      });
    }
    if (jurisdiction) config.jurisdiction = jurisdiction;
    if (basisDate) config.basisDate = basisDate;
    if (args.includes("--allow-no-material-facts")) config.allowNoMaterialFacts = true;
    const deliverableSkeletons = await initializeDeliverableSkeletons(workspaceRoot, config.deliverables);
    await writeFile(initialized.paths.config, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    console.log(JSON.stringify({
      initialized: true,
      workspaceRoot,
      stateDirectory: ".pilotdeck/work/legal-coverage",
      deliverableSkeletons,
    }, null, 2));
    process.exitCode = 0;
  } catch (error) {
    console.error(JSON.stringify({
      error: {
        code: typeof error?.code === "string" ? error.code : "legal_coverage_init_failed",
        message: error instanceof Error ? error.message : String(error),
      },
    }));
    process.exitCode = 1;
  }
} else if (command === "bootstrap-sources") {
  try {
    if (!args.includes("--from-manifest")) {
      throw initCliError(
        "legal_coverage_source_bootstrap_mode_required",
        "bootstrap-sources requires --from-manifest.",
      );
    }
    const result = await bootstrapSourcesFromManifest(workspaceRoot);
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = 0;
  } catch (error) {
    console.error(JSON.stringify({
      error: {
        code: typeof error?.code === "string" ? error.code : "legal_coverage_source_bootstrap_failed",
        message: error instanceof Error ? error.message : String(error),
      },
    }));
    process.exitCode = 1;
  }
} else if (command === "reference") {
  const name = readOption(args, "--name");
  const reference = REFERENCE_FILES[name];
  if (!reference) {
    console.error(JSON.stringify({
      error: {
        code: "legal_coverage_reference_invalid",
        message: "reference requires --name " + Object.keys(REFERENCE_FILES).join(" or ") + ".",
      },
    }));
    process.exitCode = 1;
  } else {
    process.stdout.write(await readFile(reference, "utf8"));
    process.exitCode = 0;
  }
} else if (command === "schema") {
  console.log(JSON.stringify(coverageBatchSchema(), null, 2));
  process.exitCode = 0;
} else if (command === "matrix-frontier") {
  try {
    const result = await matrixFrontierPlan(workspaceRoot, {
      limit: readOption(args, "--limit"),
    });
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = 0;
  } catch (error) {
    console.error(JSON.stringify({
      error: {
        code: typeof error?.code === "string" ? error.code : "matrix_frontier_failed",
        message: error instanceof Error ? error.message : String(error),
      },
    }));
    process.exitCode = 1;
  }
} else if (command === "matrix-fragment-bind") {
  try {
    const result = await bindMatrixAnalysisFragment(workspaceRoot, {
      fragmentPath: readOption(args, "--fragment"),
      fragmentSha256: readOption(args, "--fragment-sha256"),
    });
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = 0;
  } catch (error) {
    console.error(JSON.stringify({
      error: {
        code: typeof error?.code === "string" ? error.code : "matrix_fragment_bind_failed",
        message: error instanceof Error ? error.message : String(error),
      },
    }));
    process.exitCode = 1;
  }
} else if (command === "fragment-slice") {
  try {
    const result = await sourceReviewFragmentSlice(workspaceRoot, {
      fragmentPath: readOption(args, "--fragment"),
      receiptSha256: readOption(args, "--receipt-sha256"),
      sourceIds: readOptions(args, "--source-id"),
      maxRecords: readOption(args, "--limit"),
      maxSerializedBytes: readOption(args, "--max-bytes"),
    });
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = 0;
  } catch (error) {
    console.error(JSON.stringify({
      error: {
        code: typeof error?.code === "string" ? error.code : "source_fragment_slice_failed",
        message: error instanceof Error ? error.message : String(error),
      },
    }));
    process.exitCode = 1;
  }
} else if (command === "source-merge-prepare") {
  try {
    const result = await prepareSourceMergeProposal(workspaceRoot, {
      readinessPath: readOption(args, "--checkpoint"),
      expectedStateHash: readOption(args, "--expected-state-hash"),
      fragmentPath: readOption(args, "--fragment"),
      receiptSha256: readOption(args, "--receipt-sha256"),
      sourceIds: readOptions(args, "--source-id"),
      maxRecords: readOption(args, "--limit"),
      maxSerializedBytes: readOption(args, "--max-bytes"),
    });
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = 0;
  } catch (error) {
    console.error(JSON.stringify({
      error: {
        code: typeof error?.code === "string" ? error.code : "source_merge_prepare_failed",
        message: error instanceof Error ? error.message : String(error),
      },
    }));
    process.exitCode = 1;
  }
} else if (command === "source-merge-apply") {
  try {
    const result = await applySourceMergeProposal(workspaceRoot, {
      proposalPath: readOption(args, "--input-file"),
      proposalSha256: readOption(args, "--proposal-sha256"),
      maxRecords: readOption(args, "--limit"),
      maxSerializedBytes: readOption(args, "--max-bytes"),
    });
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = 0;
  } catch (error) {
    console.error(JSON.stringify({
      error: {
        code: typeof error?.code === "string" ? error.code : "source_merge_apply_failed",
        message: error instanceof Error ? error.message : String(error),
      },
    }));
    process.exitCode = 1;
  }
} else if (command === "source-repair-apply") {
  try {
    const result = await applySourceMergeRepair(workspaceRoot, {
      repairPath: readOption(args, "--input-file"),
      repairSha256: readOption(args, "--repair-sha256"),
    });
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = 0;
  } catch (error) {
    console.error(JSON.stringify({
      error: {
        code: typeof error?.code === "string" ? error.code : "source_repair_apply_failed",
        message: error instanceof Error ? error.message : String(error),
      },
    }));
    process.exitCode = 1;
  }
} else if (command === "matrix-selection-apply") {
  try {
    const result = await applyMatrixSelection(workspaceRoot, {
      inputPath: readOption(args, "--input-file"),
    });
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = 0;
  } catch (error) {
    console.error(JSON.stringify({
      error: {
        code: typeof error?.code === "string" ? error.code : "matrix_selection_apply_failed",
        message: error instanceof Error ? error.message : String(error),
      },
    }));
    process.exitCode = 1;
  }
} else if (command === "matrix-proposal-apply") {
  try {
    const result = await applyMatrixProposal(workspaceRoot, {
      proposalPath: readOption(args, "--input-file"),
      proposalSha256: readOption(args, "--proposal-sha256"),
    });
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = 0;
  } catch (error) {
    console.error(JSON.stringify({
      error: {
        code: typeof error?.code === "string" ? error.code : "matrix_proposal_apply_failed",
        message: error instanceof Error ? error.message : String(error),
      },
    }));
    process.exitCode = 1;
  }
} else if (command === "issue-closure-apply") {
  try {
    const result = await applyIssueClosure(workspaceRoot, {
      proposalPath: readOption(args, "--input-file"),
      proposalSha256: readOption(args, "--proposal-sha256"),
    });
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = 0;
  } catch (error) {
    console.error(JSON.stringify({
      error: {
        code: typeof error?.code === "string" ? error.code : "issue_closure_apply_failed",
        message: error instanceof Error ? error.message : String(error),
      },
    }));
    process.exitCode = 1;
  }
} else if (command === "authority-closure-apply") {
  try {
    const result = await applyAuthorityClosure(workspaceRoot, {
      proposalPath: readOption(args, "--input-file"),
      proposalSha256: readOption(args, "--proposal-sha256"),
    });
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = 0;
  } catch (error) {
    console.error(JSON.stringify({
      error: {
        code: typeof error?.code === "string" ? error.code : "authority_closure_apply_failed",
        message: error instanceof Error ? error.message : String(error),
      },
    }));
    process.exitCode = 1;
  }
} else if (command === "next-batch") {
  if (readOption(args, "--phase") !== "coverage") {
    console.error("next-batch currently requires --phase coverage");
    process.exitCode = 1;
  } else {
    await ensureWorkspace(workspaceRoot);
    const result = await nextCoverageBatch(workspaceRoot, {
      limit: readOption(args, "--limit"),
      maxSerializedBytes: readOption(args, "--max-bytes"),
    });
    console.log(JSON.stringify(result, null, 2));
    process.exitCode = 0;
  }
} else if (command === "apply-batch") {
  if (readOption(args, "--phase") !== "coverage") {
    console.error(JSON.stringify({ error: { code: "batch_phase_invalid", message: "apply-batch currently requires --phase coverage" } }));
    process.exitCode = 1;
  } else {
    try {
      await ensureWorkspace(workspaceRoot);
      const input = readOption(args, "--input-file");
      if (!input) throw batchCliError("batch_input_missing", "apply-batch requires --input-file with a workspace-relative JSON path.");
      const inputPath = await resolveSafeWorkspacePath(workspaceRoot, input);
      const patch = JSON.parse(await readFile(inputPath, "utf8"));
      const result = await applyCoverageBatch(workspaceRoot, patch, {
        limit: readOption(args, "--limit"),
        maxSerializedBytes: readOption(args, "--max-bytes"),
      });
      console.log(JSON.stringify(result, null, 2));
      process.exitCode = 0;
    } catch (error) {
      console.error(JSON.stringify({
        error: {
          code: typeof error?.code === "string" ? error.code : "batch_apply_failed",
          message: error instanceof Error ? error.message : String(error),
        },
      }));
      process.exitCode = 1;
    }
  }
} else if (command === "validate" || command === "status") {
  await ensureWorkspace(workspaceRoot);
  const result = await validateWorkspace({ workspaceRoot, writeProof: args.includes("--write-proof") });
  console.log(JSON.stringify(result, null, 2));
  process.exitCode = result.passed || command === "status" ? 0 : 2;
} else {
  console.error("Usage: legal-coverage.mjs <init|bootstrap-sources|reference|schema|matrix-frontier|matrix-fragment-bind|fragment-slice|source-merge-prepare|source-merge-apply|source-repair-apply|matrix-selection-apply|matrix-proposal-apply|issue-closure-apply|authority-closure-apply|validate|status|next-batch|apply-batch> [--workspace PATH] [--from-manifest] [--name data-contracts|issue-rules] [--checkpoint PATH] [--expected-state-hash HASH] [--fragment PATH] [--fragment-sha256 HASH] [--receipt-sha256 HASH] [--source-id ID] [--phase coverage] [--input-file PATH] [--proposal-sha256 HASH] [--repair-sha256 HASH] [--limit 1..12] [--max-bytes 1024..24576] [--input PATH|--input-from-manifest] [--deliverable ID=PATH] [--jurisdiction NAME] [--basis-date DATE] [--allow-no-material-facts] [--write-proof]");
  process.exitCode = 1;
}

function readOption(args, name) {
  const index = args.indexOf(name);
  return index >= 0 ? args[index + 1] : undefined;
}

function readOptions(args, name) {
  const values = [];
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === name && typeof args[index + 1] === "string") values.push(args[index + 1]);
  }
  return values;
}

function batchCliError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function initCliError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}
