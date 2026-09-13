/**
 * Host-owned immutable payload storage for oversized tool results.
 *
 * A storage instance is already bound to one persistent Gateway session.
 * The Gateway materializes a workspace-local cache for native `read_file`
 * and media-request behavior; callers must never receive this handle through
 * the remote SDK.
 */
export type ToolResultArtifactStorage = {
  write(artifactName: string, bytes: Uint8Array): void | Promise<void>;
  read(artifactName: string): Promise<Uint8Array | undefined>;
  delete(artifactName: string): void | Promise<void>;
  deleteAll(): void | Promise<void>;
};
