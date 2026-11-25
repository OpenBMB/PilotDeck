export type SandboxBackend = "windows-job" | "macos-seatbelt" | "linux-landlock" | "unsupported";

export interface SpawnSandboxedOptions {
  command: string;
  args: string[];
  cwd: string;
  env?: Record<string, string>;
  allowNetwork?: boolean;
  windowsVerbatimArguments?: boolean;
}

export interface SandboxOutputEvent {
  kind: "stdout" | "stderr" | "exit" | "error";
  data?: Buffer;
  exitCode?: number | null;
  error?: string;
}

export function sandboxBackend(): SandboxBackend;

export function startSandboxed(
  options: SpawnSandboxedOptions,
  onEvent: (err: Error | null, event: SandboxOutputEvent) => void,
): number;

export function killSandboxed(id: number): boolean;

