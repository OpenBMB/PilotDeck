export type RepositoryOperation = {
  operation: "init" | "stage" | "unstage" | "commit" | "push" | "fetch" | "checkout" | "remote" | "legacy";
  files?: string[];
  message?: string;
  branch?: string;
  remoteUrl?: string;
  expectedIndexTree?: string;
  expectedFiles?: Record<string, string>;
  legacyAction?: string;
};

export type FileVersion =
  | { kind: "file"; hash: string; size: number; mode: number; binary: boolean; fingerprint?: string }
  | { kind: "absent" }
  | { kind: "unprotected"; reason: string; fingerprint?: string };
export type FileChange = {
  path: string;
  before: FileVersion;
  after: FileVersion;
  source: "file_tool" | "observed";
  added: number;
  removed: number;
  uncertain?: boolean;
  beforeRevision?: string;
  afterRevision?: string;
  workspaceRevision?: string;
  /** Individual owned edits when another writer interrupted the file's chain. */
  segments?: FileChange[];
};
export type Checkpoint = {
  version: 1;
  id: string;
  sessionId: string;
  turnId: string;
  workspace: string;
  createdAt: string;
  phase: "before" | "after" | "before_restore" | "command";
  status: "complete" | "incomplete";
  files: Record<string, FileVersion>;
  contextHash?: string;
  beforeId?: string;
  changes?: FileChange[];
  /** Additive format marker: legacy full-directory checkpoints remain readable. */
  journalVersion?: 2;
  supersedesId?: string;
};
export type CheckpointSummary = Omit<Checkpoint, "files" | "changes" | "contextHash"> & {
  activeBranch?: boolean;
  changes: Array<Omit<FileChange, "before" | "after" | "segments"> & { operation: "created" | "updated" | "deleted"; restorable: boolean; binary: boolean }>;
  unprotected: number;
};
export type RestorePlan = {
  id: string;
  sessionId: string;
  checkpointId: string;
  createdAt: string;
  mode: "files" | "both" | "conversation";
  scope?: CheckpointRequest["scope"];
  files: Array<{ path: string; expected: FileVersion; target: FileVersion; status: "ready" | "conflict" | "unchanged" | "unprotected"; source: FileChange["source"]; expectedRevision?: string; resultRevision?: string; result?: FileVersion }>;
  contextHash?: string;
  contextBeforeHash?: string;
  visibleSequences?: number[];
  visibleBeforeSequences?: number[];
  undoOf?: string;
  workspaceRevision?: string;
};
export type RestoreOperation = RestorePlan & {
  status: "prepared" | "applying" | "complete" | "needs_recovery";
  beforeId: string;
  applied: string[];
  skipped: string[];
  pendingPath?: string;
};
export type CheckpointRequest = {
  projectKey: string;
  sessionKey: string;
  action: "list" | "diff" | "preview" | "restore" | "undo" | "git" | "filesystem";
  fileOperation?: { operation: "save" | "create" | "mkdir" | "rename" | "delete" | "upload"; path: string; newPath?: string; content?: string; expectedHash?: string; expectedContent?: string; stagedPath?: string; requestId?: string; cancel?: boolean };
  repositoryOperation?: RepositoryOperation;
  checkpointId?: string;
  planId?: string;
  operationId?: string;
  filePath?: string;
  paths?: string[];
  scope?: "turn" | "session" | "since";
  mode?: RestorePlan["mode"];
};
