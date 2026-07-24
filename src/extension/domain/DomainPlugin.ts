import type { ArtifactContract, ArtifactValidator } from "../../artifact/index.js";

export type DomainTaskInput = {
  sessionId: string;
  cwd: string;
  prompt: string;
};

export type DomainActivation = {
  domainId: string;
  confidence: number;
  skillIds?: readonly string[];
  contextPointer?: string;
};

export interface DomainPlugin {
  readonly id: string;
  readonly skillIds?: readonly string[];
  readonly validators?: readonly ArtifactValidator[];
  detectTask?(input: DomainTaskInput): Promise<DomainActivation | null>;
  artifactContracts?(input: DomainTaskInput): Promise<readonly ArtifactContract[]>;
}
