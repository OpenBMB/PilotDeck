import { lstat } from "node:fs/promises";
import { extname } from "node:path";
import type { ArtifactValidator } from "../protocol/types.js";

export class FileExistsValidator implements ArtifactValidator {
  readonly id = "core:file-exists";

  async validate(input: Parameters<ArtifactValidator["validate"]>[0]) {
    try {
      const info = await lstat(input.artifactPath);
      if (!info.isFile()) return failed(this.id, input.contract.id, "artifact_not_file", "Expected artifact is not a regular file.", input.artifactPath);
      if (info.size === 0) return failed(this.id, input.contract.id, "artifact_empty", "Required artifact is empty.", input.artifactPath);
      const expected = input.contract.expectedExtensions?.map((value) => value.toLowerCase());
      if (expected?.length && !expected.includes(extname(input.artifactPath).toLowerCase())) {
        return failed(this.id, input.contract.id, "artifact_extension_mismatch", `Expected one of: ${expected.join(", ")}.`, input.artifactPath);
      }
      return {
        validatorId: this.id,
        contractId: input.contract.id,
        status: "passed" as const,
        issues: [],
        evidence: { bytes: info.size },
      };
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT") {
        return failed(this.id, input.contract.id, "artifact_missing", "Required artifact does not exist.", input.artifactPath);
      }
      return {
        validatorId: this.id,
        contractId: input.contract.id,
        status: "error" as const,
        issues: [{ code: "artifact_validation_error", severity: "error" as const, message: String(error), path: input.artifactPath }],
      };
    }
  }
}

function failed(validatorId: string, contractId: string, code: string, message: string, path: string) {
  return {
    validatorId,
    contractId,
    status: "failed" as const,
    issues: [{ code, severity: "error" as const, message, path, recoverable: true }],
  };
}
