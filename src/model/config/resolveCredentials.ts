import { ModelConfigError } from "../protocol/errors.js";

export type CredentialEnv = Record<string, string | undefined>;

const ENV_REFERENCE_PATTERN = /^\$\{([A-Za-z_][A-Za-z0-9_]*)\}$/;

/**
 * Resolve a provider apiKey from raw config.
 *
 * Whitespace handling: `value` and any `${VAR}`-resolved env value are both
 * trimmed before use. A stray space inside a YAML literal (e.g.
 * `apiKey: " sk-..."`) or an env variable that ships a trailing newline
 * would otherwise be pasted verbatim into `Authorization: Bearer  sk-...`,
 * which most providers reject as `invalid_token` / `无效的令牌`. Trimming at
 * the source guarantees every downstream caller (streamModel, AlwaysOn,
 * Cron, plugins) sees the cleaned value.
 */
export function resolveApiKey(value: unknown, env: CredentialEnv = process.env): string {
  if (typeof value !== "string") {
    throw new ModelConfigError("missing_api_key", "Provider apiKey must be a non-empty string.");
  }

  const trimmed = value.trim();
  if (trimmed.length === 0) {
    throw new ModelConfigError("missing_api_key", "Provider apiKey must be a non-empty string.");
  }

  const match = ENV_REFERENCE_PATTERN.exec(trimmed);
  if (!match) {
    return trimmed;
  }

  const envName = match[1];
  const rawResolved = env[envName];
  const resolved = typeof rawResolved === "string" ? rawResolved.trim() : "";
  if (!resolved) {
    throw new ModelConfigError("missing_api_key", `Environment variable ${envName} is not set.`, {
      envName,
    });
  }

  return resolved;
}
