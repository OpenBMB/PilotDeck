export type ArtifactContract = {
  id: string;
  path: string;
  required?: boolean;
  validatorIds?: readonly string[];
  expectedExtensions?: readonly string[];
  options?: Readonly<Record<string, unknown>>;
  domainId?: string;
};

export type RegisteredArtifactContract = ArtifactContract & {
  sourcePluginId: string;
};

export type ArtifactValidationIssue = {
  code: string;
  severity: "error" | "warning";
  message: string;
  path?: string;
  recoverable?: boolean;
};

export type ArtifactValidationResult = {
  validatorId: string;
  contractId: string;
  status: "passed" | "failed" | "skipped" | "error";
  issues: readonly ArtifactValidationIssue[];
  evidence?: Readonly<Record<string, string | number | boolean>>;
};

export type ArtifactValidatorInput = {
  contract: RegisteredArtifactContract;
  workspaceRoot: string;
  artifactPath: string;
  sessionId: string;
  turnId: string;
  signal?: AbortSignal;
};

export interface ArtifactValidator {
  readonly id: string;
  validate(input: ArtifactValidatorInput): Promise<ArtifactValidationResult>;
}

export type ArtifactValidationSummary = {
  passed: boolean;
  results: readonly ArtifactValidationResult[];
};
