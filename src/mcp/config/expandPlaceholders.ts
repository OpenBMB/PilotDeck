import { homedir } from "node:os";

/**
 * Expand MCP config placeholders in a single string:
 * - `${env:NAME}` → process.env[NAME] (fallback empty string)
 * - `${userHome}` → user home directory
 * - `~/` or `~\` prefix → user home directory (kept for backward compat)
 */
export function expandMcpString(value: string): string {
  let result = value
    .replace(/\$\{env:([^}]+)\}/g, (_m, name: string) => process.env[name] ?? "")
    .replace(/\$\{userHome\}/g, process.env.HOME ?? process.env.USERPROFILE ?? homedir());
  if (result.startsWith("~/") || result.startsWith("~\\")) {
    result = homedir() + result.slice(1);
  } else if (result === "~") {
    result = homedir();
  }
  return result;
}

/** Recursively expand all string values in an object/array tree. */
export function expandMcpConfig(value: unknown): unknown {
  if (typeof value === "string") return expandMcpString(value);
  if (Array.isArray(value)) return value.map(expandMcpConfig);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, expandMcpConfig(v)]),
    );
  }
  return value;
}
