import { createHash } from "node:crypto";
import type { PilotDeckMcpToolSpec } from "../protocol/types.js";

/** One advertised contract binds model schema, permission flags and dispatch. */
export function toolContractFingerprint(tool: PilotDeckMcpToolSpec): string {
  const contract = { name: tool.toolName, description: tool.description, inputSchema: tool.inputSchema, annotations: tool.annotations ?? {} };
  const serialized = JSON.stringify(contract, (_key, value: unknown) => {
    if (!value || typeof value !== "object" || Array.isArray(value)) return value;
    const record = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(record).sort().map(key => [key, record[key]]));
  });
  return createHash("sha256").update(serialized).digest("hex");
}
