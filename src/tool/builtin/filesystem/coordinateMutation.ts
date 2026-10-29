import type { PilotDeckToolRuntimeContext } from "../../protocol/types.js";
import { acquireWorkspaceOperation, operationContext, workspaceOperationState } from "../../../session/checkpoints/WorkspaceCoordinator.js";

function reportWait(context: PilotDeckToolRuntimeContext, scope: string): void {
  if (operationContext.getStore()?.command) return;
  const state = workspaceOperationState(scope);
  if (!state.busy) return;
  context.progress?.({ type: "tool_progress", sessionId: context.sessionId, turnId: context.turnId,
    toolCallId: context.currentToolCallId ?? "", toolName: "filesystem", message: state.reason ?? "等待文件操作完成",
    createdAt: new Date().toISOString() });
}

/** Include freshness validation, backup, publication and journal commit in one file lease. */
export async function withFileMutation<T>(context: PilotDeckToolRuntimeContext, filePath: string, task: () => Promise<T>): Promise<T> {
  reportWait(context, filePath);
  if (context.fileHistory?.runEdit) return context.fileHistory.runEdit(filePath, task, context.abortSignal);
  const owner = operationContext.getStore()?.owner ?? {};
  const release = await acquireWorkspaceOperation(filePath, { kind: "file", owner, signal: context.abortSignal });
  try { return await operationContext.run({ ...operationContext.getStore(), owner }, task); } finally { release(); }
}

export async function withCommandMutation<T>(context: PilotDeckToolRuntimeContext, task: () => Promise<T>): Promise<T> {
  reportWait(context, context.cwd);
  if (context.fileHistory?.runCommand) return context.fileHistory.runCommand(task, { signal: context.abortSignal });
  const finish = await context.fileHistory?.trackCommand?.({ signal: context.abortSignal });
  try { return await task(); } finally { await finish?.(); }
}
