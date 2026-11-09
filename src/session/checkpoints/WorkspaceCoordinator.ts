import { AsyncLocalStorage } from "node:async_hooks";
import { realpathSync } from "node:fs";
import path from "node:path";

type Lease = { scope: string; kind: "file" | "directory"; owner: object; label: string };
type Waiter = Lease & { grant: (release: () => void) => void; reject: (error: Error) => void; signal?: AbortSignal; abort?: () => void };
const active = new Set<Lease>();
const waiting: Waiter[] = [];
const turns = new Set<{ workspace: string; sessionId: string; turnId: string }>();
export const operationContext = new AsyncLocalStorage<{ owner: object; command?: unknown }>();

export function canonicalWorkspacePath(value: string): string {
  const absolute = path.resolve(value);
  try { return realpathSync.native(absolute); }
  catch { return path.dirname(absolute) === absolute ? absolute : path.join(canonicalWorkspacePath(path.dirname(absolute)), path.basename(absolute)); }
}
export function overlappingPaths(left: string, right: string): boolean {
  const contains = (root: string, target: string) => {
    const relative = path.relative(root, target);
    return !relative || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
  };
  return contains(left, right) || contains(right, left);
}
function conflicts(left: Lease, right: Lease): boolean {
  if (!overlappingPaths(left.scope, right.scope)) return false;
  // Only nested operations inherit an owner. Two independent file mutations
  // still serialize, including when called concurrently from the same script.
  return !(left.owner === right.owner && (left.kind === "directory" || right.kind === "directory"));
}
function aborted(): Error { return Object.assign(new Error("File operation cancelled while waiting."), { code: "ABORTED" }); }
function drain(): void {
  for (let index = 0; index < waiting.length;) {
    const item = waiting[index];
    const nested = [...active].some(lease => lease.owner === item.owner && lease.kind === "directory" && overlappingPaths(lease.scope, item.scope));
    if ([...active].some(lease => conflicts(lease, item)) || (!nested && waiting.slice(0, index).some(lease => conflicts(lease, item)))) { index++; continue; }
    waiting.splice(index, 1);
    item.signal?.removeEventListener("abort", item.abort!);
    active.add(item);
    let released = false;
    item.grant(() => { if (!released) { released = true; active.delete(item); drain(); } });
  }
}
export function acquireWorkspaceOperation(scope: string, options: { kind?: Lease["kind"]; signal?: AbortSignal; owner?: object; label?: string } = {}): Promise<() => void> {
  if (options.signal?.aborted) return Promise.reject(aborted());
  return new Promise((grant, reject) => {
    const item: Waiter = { scope: canonicalWorkspacePath(scope), kind: options.kind ?? "directory", owner: options.owner ?? {}, label: options.label ?? "正在修改项目文件", signal: options.signal, grant, reject };
    item.abort = () => {
      const index = waiting.indexOf(item);
      if (index < 0) return;
      waiting.splice(index, 1); item.signal?.removeEventListener("abort", item.abort!); reject(aborted()); drain();
    };
    waiting.push(item); item.signal?.addEventListener("abort", item.abort, { once: true }); drain();
  });
}
export function workspaceOperationState(workspace: string): { busy: boolean; reason?: string } {
  const root = canonicalWorkspacePath(workspace);
  const lease = [...active, ...waiting].find(item => overlappingPaths(root, item.scope));
  return { busy: !!lease, reason: lease?.label };
}
export function registerWorkspaceTurn(workspace: string, sessionId: string, turnId: string): () => void {
  const turn = { workspace: canonicalWorkspacePath(workspace), sessionId, turnId };
  turns.add(turn); return () => { turns.delete(turn); };
}
export function hasWorkspaceTurn(workspace: string, sessionId?: string, turnId?: string): boolean {
  const root = canonicalWorkspacePath(workspace);
  return [...turns].some(turn => overlappingPaths(root, turn.workspace) && (sessionId === undefined || turn.sessionId === sessionId) && (turnId === undefined || turn.turnId === turnId));
}
