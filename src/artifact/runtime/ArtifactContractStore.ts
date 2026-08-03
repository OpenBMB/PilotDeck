import type { ArtifactContract, RegisteredArtifactContract } from "../protocol/types.js";

const MAX_CONTRACTS_PER_SOURCE = 32;
const MAX_ID_LENGTH = 128;
const MAX_PATH_LENGTH = 1024;
const MAX_OPTIONS_BYTES = 32 * 1024;

export class ArtifactContractStore {
  private readonly sessions = new Map<string, Map<string, RegisteredArtifactContract>>();

  register(sessionId: string, sourcePluginId: string, contracts: readonly ArtifactContract[]): void {
    if (contracts.length > MAX_CONTRACTS_PER_SOURCE) {
      throw new Error(`A plugin may register at most ${MAX_CONTRACTS_PER_SOURCE} artifact contracts at once.`);
    }
    for (const contract of contracts) validateContract(contract);
    const session = this.sessions.get(sessionId) ?? new Map<string, RegisteredArtifactContract>();
    for (const contract of contracts) {
      session.set(`${sourcePluginId}:${contract.id}`, { ...contract, sourcePluginId });
    }
    this.sessions.set(sessionId, session);
  }

  list(sessionId: string): readonly RegisteredArtifactContract[] {
    return [...(this.sessions.get(sessionId)?.values() ?? [])];
  }

  clear(sessionId: string): void {
    this.sessions.delete(sessionId);
  }
}

function validateContract(contract: ArtifactContract): void {
  if (!contract.id || contract.id.length > MAX_ID_LENGTH) throw new Error("Artifact contract id is missing or too long.");
  if (!contract.path || contract.path.length > MAX_PATH_LENGTH) throw new Error("Artifact contract path is missing or too long.");
  if (contract.options && Buffer.byteLength(JSON.stringify(contract.options), "utf8") > MAX_OPTIONS_BYTES) {
    throw new Error("Artifact contract options exceed the size limit.");
  }
}
