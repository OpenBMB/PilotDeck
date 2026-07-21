import type { ArtifactValidationResult, ArtifactValidationSummary, ArtifactValidator } from "../protocol/types.js";
import type { ArtifactContractStore } from "./ArtifactContractStore.js";
import { resolveArtifactPath } from "./resolveArtifactPath.js";

export class ArtifactValidationRuntime {
  private readonly validators: Map<string, ArtifactValidator>;

  constructor(
    private readonly contracts: ArtifactContractStore,
    validators: readonly ArtifactValidator[],
  ) {
    this.validators = new Map();
    for (const validator of validators) {
      if (this.validators.has(validator.id)) {
        throw new Error(`Duplicate artifact validator id: ${validator.id}`);
      }
      this.validators.set(validator.id, validator);
    }
  }

  async validate(input: {
    sessionId: string;
    turnId: string;
    workspaceRoot: string;
    signal?: AbortSignal;
  }): Promise<ArtifactValidationSummary> {
    const results: ArtifactValidationResult[] = [];
    let failedRequired = false;
    for (const contract of this.contracts.list(input.sessionId)) {
      let artifactPath: string;
      try {
        artifactPath = await resolveArtifactPath(input.workspaceRoot, contract.path);
      } catch (error) {
        const result: ArtifactValidationResult = {
          validatorId: "core:path-boundary",
          contractId: contract.id,
          status: "failed",
          issues: [{ code: "artifact_path_invalid", severity: "error", message: String(error), path: contract.path }],
        };
        results.push(result);
        if (contract.required !== false) failedRequired = true;
        continue;
      }
      for (const validatorId of contract.validatorIds?.length ? contract.validatorIds : ["core:file-exists"]) {
        const validator = this.validators.get(validatorId);
        if (!validator) {
          const result: ArtifactValidationResult = {
            validatorId,
            contractId: contract.id,
            status: "error",
            issues: [{ code: "artifact_validator_missing", severity: "error", message: `Validator ${validatorId} is not registered.` }],
          };
          results.push(result);
          if (contract.required !== false) failedRequired = true;
          continue;
        }
        let result: ArtifactValidationResult;
        try {
          result = await validator.validate({ ...input, contract, artifactPath });
        } catch (error) {
          result = {
            validatorId,
            contractId: contract.id,
            status: "error",
            issues: [{
              code: "artifact_validator_error",
              severity: "error",
              message: error instanceof Error ? error.message : String(error),
              path: artifactPath,
            }],
          };
        }
        results.push(result);
        if (contract.required !== false && (result.status === "failed" || result.status === "error")) {
          failedRequired = true;
        }
      }
    }
    return { passed: !failedRequired, results };
  }
}

export function formatArtifactCorrectionPrompt(summary: ArtifactValidationSummary): string {
  const issues = summary.results.flatMap((result) => result.issues.map((issue) => `- [${result.contractId}/${issue.code}] ${issue.message}${issue.path ? ` (${issue.path})` : ""}`));
  return [
    "Artifact validation failed. Fix the required deliverables before finishing.",
    ...issues,
    "Do not submit helper scripts as final artifacts. Re-run the relevant validators after writing the deliverables.",
  ].join("\n");
}
