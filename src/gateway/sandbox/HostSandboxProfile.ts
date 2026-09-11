import {
  BubblewrapSandboxCommandRunner,
  type BubblewrapSandboxCommandRunnerOptions,
} from "../../tool/builtin/bash/bubblewrapSandbox.js";
import type { PilotDeckCommandRunner } from "../../tool/builtin/bash/commandRunner.js";

export type GatewayHostSandboxRequest = {
  type: "host";
  profile: string;
  filesystem?: "read_only" | "deny";
  network?: "deny";
  process?: "deny";
};

export type GatewayHostSandboxContext = {
  profile: string;
  sessionKey: string;
  projectRoot: string;
  cwd: string;
  sandbox: GatewayHostSandboxRequest;
};

/**
 * A host-owned process boundary for one SDK session. The Gateway calls this
 * only after validating a requested profile; the SDK never receives runner,
 * process, filesystem or credential handles.
 */
export type GatewayHostSandboxProfile = {
  /**
   * The profile can run a process without mounting the Gateway workspace when
   * an SDK session requests `filesystem: "deny"`. Omit this flag unless the
   * host profile enforces that boundary itself; the Gateway otherwise keeps
   * Bash hidden for that session.
   */
  supportsFilesystemDeny?: boolean;
  /**
   * The profile enforces a read-only workspace for hosted processes. This is
   * required before the Gateway exposes `execute_code` under
   * `filesystem: "read_only"`, because Python can otherwise write directly.
   */
  supportsFilesystemReadOnly?: boolean;
  /**
   * The profile enforces a network-deny process boundary when requested.
   * Omit this flag unless the runner actually provides it; the Gateway keeps
   * Bash hidden for `network: "deny"` otherwise.
   */
  supportsNetworkDeny?: boolean;
  /**
   * The profile can execute the native `execute_code` Python runtime through
   * the same command boundary as Bash. The Gateway only exposes that tool
   * when no filesystem/network restriction would let its helper RPC calls
   * bypass a profile-owned boundary.
   */
  supportsExecuteCode?: boolean;
  /**
   * Explicit opt-in for `execute_code` under `toolIsolation: "strict"`.
   * The Gateway removes every PilotDeck helper from the generated Python
   * module in that mode, so the profile owns the only remaining process and
   * filesystem boundary. Omit this for existing profiles to preserve their
   * current strict-tool surface.
   */
  supportsStrictExecuteCode?: boolean;
  createCommandRunner(
    context: GatewayHostSandboxContext,
  ): PilotDeckCommandRunner | Promise<PilotDeckCommandRunner>;
};

export type GatewayHostSandboxProfiles = Record<string, GatewayHostSandboxProfile>;

export type CreateBubblewrapSandboxProfileOptions = Omit<
  BubblewrapSandboxCommandRunnerOptions,
  "workspaceRoot" | "readOnlyWorkspace" | "delegate"
> & {
  /** Optional test/host runner factory; production normally omits it. */
  createRunner?: (
    options: BubblewrapSandboxCommandRunnerOptions,
    context: GatewayHostSandboxContext,
  ) => PilotDeckCommandRunner;
  /** Opt in to strict `execute_code` with no Gateway helper RPC surface. */
  enableStrictExecuteCode?: boolean;
};

/**
 * Constructs a strict Bubblewrap host profile. It denies network by default,
 * forwards no host environment, changes the workspace bind to read-only when
 * requested, and can run a scratch-shell without mounting that workspace.
 */
export function createBubblewrapSandboxProfile(
  options: CreateBubblewrapSandboxProfileOptions = {},
): GatewayHostSandboxProfile {
  return {
    supportsFilesystemDeny: true,
    supportsFilesystemReadOnly: true,
    supportsNetworkDeny: true,
    supportsExecuteCode: true,
    ...(options.enableStrictExecuteCode === true ? { supportsStrictExecuteCode: true } : {}),
    createCommandRunner(context) {
      const runnerOptions: BubblewrapSandboxCommandRunnerOptions = {
        workspaceRoot: context.projectRoot,
        readOnlyWorkspace: context.sandbox.filesystem === "read_only",
        mountWorkspace: context.sandbox.filesystem !== "deny",
        ...(options.executable ? { executable: options.executable } : {}),
        ...(options.readOnlyPaths ? { readOnlyPaths: [...options.readOnlyPaths] } : {}),
        ...(options.environment ? { environment: { ...options.environment } } : {}),
      };
      return options.createRunner?.(runnerOptions, context)
        ?? new BubblewrapSandboxCommandRunner(runnerOptions);
    },
  };
}
