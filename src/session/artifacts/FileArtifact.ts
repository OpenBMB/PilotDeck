export type FileArtifactOperation = "created" | "updated";

export type FileArtifactSource = "tool" | "workspace_diff";

export type FileArtifactStatus = "complete" | "incomplete";

/**
 * A user-facing file produced or updated during one agent turn.
 *
 * `path` is always relative to the project root. Keeping absolute host paths
 * out of the transcript makes history portable and avoids leaking server
 * filesystem details to remote clients.
 */
export type FileArtifact = {
  id: string;
  name: string;
  path: string;
  operation: FileArtifactOperation;
  source: FileArtifactSource;
  status: FileArtifactStatus;
  size: number;
  sha256: string;
  mimeType?: string;
  createdAt: string;
};
