#!/usr/bin/env node
import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  applyCoverageBatch,
  coverageBatchSchema,
  ensureWorkspace,
  nextCoverageBatch,
  resolveSafeWorkspacePath,
  validateWorkspace,
} from "./lib/legal-coverage.mjs";

const [command = "status", ...args] = process.argv.slice(2);
const workspaceRoot = resolve(readOption(args, "--workspace") ?? process.cwd());

if (command === "init") {
  const initialized = await ensureWorkspace(workspaceRoot);
  const config = JSON.parse(await readFile(initialized.paths.config, "utf8"));
  const inputs = readOptions(args, "--input");
  const deliverables = readOptions(args, "--deliverable");
  const jurisdiction = readOption(args, "--jurisdiction");
  const basisDate = readOption(args, "--basis-date");
  if (inputs.length > 0) config.inputRoots = [...new Set(inputs)];
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
  await writeFile(initialized.paths.config, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
  console.log(JSON.stringify({ initialized: true, workspaceRoot, stateDirectory: ".pilotdeck/work/legal-coverage" }, null, 2));
  process.exitCode = 0;
} else if (command === "schema") {
  console.log(JSON.stringify(coverageBatchSchema(), null, 2));
  process.exitCode = 0;
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
  console.error("Usage: legal-coverage.mjs <init|schema|validate|status|next-batch|apply-batch> [--workspace PATH] [--phase coverage] [--input-file PATH] [--limit 1..12] [--max-bytes 1024..24576] [--input PATH] [--deliverable ID=PATH] [--jurisdiction NAME] [--basis-date DATE] [--allow-no-material-facts] [--write-proof]");
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
