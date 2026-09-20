import {
  BackgroundTaskRuntime,
  type BackgroundTaskCompletionHandler,
} from "../../task/runtime/BackgroundTaskRuntime.js";
import { JsonFileBackgroundTaskSnapshotStore } from "../../task/storage/BackgroundTaskSnapshotStore.js";
import { join } from "node:path";
import {
  createNodeAttachmentDeliveryPort,
  type AttachmentDeliveryPort,
} from "./AttachmentDeliveryPort.js";
import type { CodeRuntimePort } from "./CodeRuntimePort.js";
import { createNodeCodeRuntimePort } from "./NodeCodeRuntimePort.js";
import { createNodeExecutionWorkspacePort } from "./NodeExecutionWorkspacePort.js";
import { createNodeFsPort } from "./NodeFsPort.js";
import { createNodeSandboxPort } from "./NodeSandboxPort.js";
import { createNodePlanStoragePort, type PlanStoragePort } from "./PlanStoragePort.js";
import { createNodeDetachedShellPort, type DetachedShellPort } from "./DetachedShellPort.js";
import { createNodeExecutionTransportPort, type ExecutionTransportPort } from "./ExecutionTransportPort.js";
import type { ExecutionWorkspacePort } from "./ExecutionWorkspacePort.js";
import type { FsPort } from "./FsPort.js";
import {
  DEFAULT_SANDBOX_MODE,
  type SandboxMode,
  type SandboxPolicy,
  type SandboxPort,
} from "./SandboxPort.js";
import { createNodeSandboxedFsPort } from "./SandboxedFsPort.js";
import { createNodeShellPort, type ShellPort } from "./ShellPort.js";
import { createNodeSandboxedDetachedShellPort } from "./SandboxedDetachedShellPort.js";
import { createNodeSandboxedShellPort } from "./SandboxedShellPort.js";
import { createNodeSubprocessPort, type SubprocessPort } from "./SubprocessPort.js";

/** Execution-world policy supplied to the execute_code consumer. */
export type ExecuteCodeSandbox = {
  port: SandboxPort;
  /** The selected native mode, when the host can state it explicitly. */
  mode?: SandboxMode;
  resolvePolicy(input: { workspaceRoot: string; executionRoot: string }): SandboxPolicy;
};

/**
 * One project-scoped execution-world composition. It owns only providers
 * with a project lifetime; per-run workspaces and transports remain owned by
 * their respective consumers.
 */
export type ExecutionWorldBundle = {
  readonly fs: FsPort;
  readonly subprocess: SubprocessPort;
  readonly shell: ShellPort;
  readonly detachedShell: DetachedShellPort;
  readonly attachmentDelivery: AttachmentDeliveryPort;
  readonly planStorage: PlanStoragePort;
  readonly executionWorkspace: ExecutionWorkspacePort;
  readonly codeRuntime: CodeRuntimePort;
  readonly executionTransport: ExecutionTransportPort;
  readonly executeCodeSandbox: ExecuteCodeSandbox;
  readonly backgroundTasks: BackgroundTaskRuntime;
  /** Stop new execution work and drain every project-owned provider. */
  dispose(): Promise<void>;
};

export type ExecutionWorldBundleParts = Omit<ExecutionWorldBundle, "dispose">;

export type CreateNodeExecutionWorldBundleOptions = {
  now?: () => Date;
  onBackgroundTaskCompletion?: BackgroundTaskCompletionHandler;
  /** File-effect policy selected by the project profile for process execution. */
  sandboxMode?: SandboxMode;
  /** Project identity selected by application composition for durable task state. */
  projectRoot?: string;
  /** Explicit state root for tests or alternate project storage providers. */
  backgroundTaskStateDir?: string;
};

/** Compose selected execution providers into one lifecycle owner. */
export function createExecutionWorldBundle(parts: ExecutionWorldBundleParts): ExecutionWorldBundle {
  let disposePromise: Promise<void> | undefined;
  return {
    ...parts,
    dispose: () => {
      if (!disposePromise) disposePromise = disposeOwnedProviders(parts);
      return disposePromise;
    },
  };
}

/** Native project-scoped execution-world provider selection. */
export function createNodeExecutionWorldBundle(
  options: CreateNodeExecutionWorldBundleOptions = {},
): ExecutionWorldBundle {
  const subprocess = createNodeSubprocessPort();
  const sandboxMode = options.sandboxMode ?? DEFAULT_SANDBOX_MODE;
  const sandbox = createNodeSandboxPort();
  const nodeFs = createNodeFsPort();
  const fs = sandboxMode === "danger-full-access"
    ? nodeFs
    : createNodeSandboxedFsPort({ fs: nodeFs, sandboxMode });
  const detachedShell = sandboxMode === "danger-full-access"
    ? createNodeDetachedShellPort()
    : createNodeSandboxedDetachedShellPort({
        sandbox,
        resolvePolicy: ({ workspaceRoot }) => ({ mode: sandboxMode, workspaceRoot }),
      });
  const shell = sandboxMode === "danger-full-access"
    ? createNodeShellPort(subprocess)
    : createNodeSandboxedShellPort({
        sandbox,
        subprocess,
        resolvePolicy: ({ workspaceRoot }) => ({ mode: sandboxMode, workspaceRoot }),
      });
  const backgroundTaskStateDir = options.backgroundTaskStateDir
    ?? (options.projectRoot ? join(options.projectRoot, ".pilotdeck", "background-tasks") : undefined);
  const snapshotStore = backgroundTaskStateDir
    ? new JsonFileBackgroundTaskSnapshotStore({ filePath: join(backgroundTaskStateDir, "state.json") })
    : undefined;
  return createExecutionWorldBundle({
    fs,
    subprocess,
    shell,
    detachedShell,
    attachmentDelivery: createNodeAttachmentDeliveryPort(),
    planStorage: createNodePlanStoragePort(),
    executionWorkspace: createNodeExecutionWorkspacePort(),
    codeRuntime: createNodeCodeRuntimePort(),
    executionTransport: createNodeExecutionTransportPort(),
    executeCodeSandbox: {
      port: sandbox,
      mode: sandboxMode,
      resolvePolicy: ({ workspaceRoot, executionRoot }) => ({
        mode: sandboxMode,
        workspaceRoot,
        executionRoot,
      }),
    },
    backgroundTasks: new BackgroundTaskRuntime({
      now: options.now,
      shell: detachedShell,
      onCompletion: options.onBackgroundTaskCompletion,
      ...(backgroundTaskStateDir ? { diskSpillDir: join(backgroundTaskStateDir, "output") } : {}),
      ...(snapshotStore ? { snapshotStore } : {}),
    }),
  });
}

async function disposeOwnedProviders(parts: ExecutionWorldBundleParts): Promise<void> {
  const results = await Promise.allSettled([
    parts.codeRuntime.dispose?.() ?? Promise.resolve(),
    parts.backgroundTasks.dispose(),
  ]);
  const failures = results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => result.reason);
  if (failures.length === 1) throw failures[0];
  if (failures.length > 1) {
    throw new AggregateError(failures, "Failed to dispose execution-world providers.");
  }
}
