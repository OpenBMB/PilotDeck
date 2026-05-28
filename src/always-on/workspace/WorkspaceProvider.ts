import type { WorkspaceHandle, WorkspaceStrategyId } from "../protocol/types.js";

export type WorkspaceProviderId = WorkspaceStrategyId;

export type WorkspacePrepareInput = {
  projectRoot: string;
  runId: string;
};

export type WorkspacePublishOutput = {
  commit?: string;
  diff?: string;
};

export interface WorkspaceProvider {
  readonly id: WorkspaceProviderId;
  /** Lower numbers win. Built-ins: git-worktree=1, snapshot-copy=2. */
  readonly priority: number;
  isApplicable(projectRoot: string): Promise<boolean>;
  prepare(input: WorkspacePrepareInput): Promise<WorkspaceHandle>;
  publish(handle: WorkspaceHandle): Promise<WorkspacePublishOutput>;
  dispose(handle: WorkspaceHandle, options: { keep: boolean }): Promise<void>;
}
