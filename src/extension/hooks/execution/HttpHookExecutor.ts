import type { PilotDeckHookInput } from "../protocol/input.js";
import type { PilotDeckHookCommand } from "../protocol/settings.js";
import { parseHookOutput } from "./parseHookOutput.js";
import type { CommandHookExecutionResult } from "./CommandHookExecutor.js";

export type HttpHookFetch = typeof fetch;

export class HttpHookExecutor {
  constructor(private readonly fetchImpl: HttpHookFetch = fetch) {}

  async execute(options: {
    hook: Extract<PilotDeckHookCommand, { type: "http" }>;
    hookInput: PilotDeckHookInput;
    env?: NodeJS.ProcessEnv;
    signal?: AbortSignal;
  }): Promise<CommandHookExecutionResult> {
    try {
      const response = await this.fetchImpl(options.hook.url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          ...resolveHeaders(options.hook.headers, options.hook.allowedEnvVars, options.env),
        },
        body: JSON.stringify(options.hookInput),
        signal: options.signal,
      });
      const stdout = await response.text();
      return {
        stdout,
        stderr: response.ok ? "" : `HTTP hook returned ${response.status}.`,
        exitCode: response.ok ? 0 : 1,
        outcome: response.ok ? "success" : "non_blocking_error",
        output: parseHookOutput(stdout),
      };
    } catch (error) {
      return {
        stdout: "",
        stderr: error instanceof Error ? error.message : String(error),
        outcome: "non_blocking_error",
        output: { type: "sync" },
      };
    }
  }
}

function resolveHeaders(
  headers: Record<string, string> | undefined,
  allowedEnvVars: string[] | undefined,
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const allowed = new Set(allowedEnvVars ?? []);
  const output: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers ?? {})) {
    output[key] = value.replace(/\$(\w+)|\$\{(\w+)\}/gu, (_match, bare: string | undefined, braced: string | undefined) => {
      const name = bare ?? braced ?? "";
      return allowed.has(name) ? env[name] ?? "" : "";
    });
  }
  return output;
}
