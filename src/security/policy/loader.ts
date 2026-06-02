import { resolve } from "node:path";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { DEFAULT_SECURITY_POLICY, type SecurityPolicy } from "./types.js";

const POLICY_FILE_NAME = "security-policy.json";

const TEMPLATE = {
  _comment: [
    "Security policy for PilotDeck. Values here are MERGED with defaults —",
    "arrays are concatenated, objects are deep-merged, scalars are replaced.",
    "Remove a key to use the built-in default. Remove this file to reset.",
  ],
  mcp: {
    _comment: "MCP (Model Context Protocol) server instruction sanitization",
    instructionMaxLength: DEFAULT_SECURITY_POLICY.mcp.instructionMaxLength,
    _instructionMaxLength: "Max characters per MCP server's instructions (default: 4096)",
    detectSuspiciousCommands: DEFAULT_SECURITY_POLICY.mcp.detectSuspiciousCommands,
    _detectSuspiciousCommands: "Scan instructions for patterns like curl, eval, bash -c",
    suspiciousPatterns: DEFAULT_SECURITY_POLICY.mcp.suspiciousPatterns,
    _suspiciousPatterns: "Regex patterns (case-insensitive) matched against MCP instructions",
  },
  hook: {
    _comment: "Hook guard — detects sensitive data in tool outputs",
    additionalContextMaxLength: DEFAULT_SECURITY_POLICY.hook.additionalContextMaxLength,
    _additionalContextMaxLength: "Max length of additionalContext injected by security guards",
    validateUpdatedInput: DEFAULT_SECURITY_POLICY.hook.validateUpdatedInput,
    _validateUpdatedInput: "Validate input after hook updates",
    addSourceMarkers: DEFAULT_SECURITY_POLICY.hook.addSourceMarkers,
    _addSourceMarkers: "Add source markers to outputs containing sensitive data",
  },
  web: {
    _comment: "Web fetch guard — prevents prompt injection from fetched content",
    addBoundaryMarkers: DEFAULT_SECURITY_POLICY.web.addBoundaryMarkers,
    _addBoundaryMarkers: "Wrap fetched content in boundary markers",
    detectInjection: DEFAULT_SECURITY_POLICY.web.detectInjection,
    _detectInjection: "Scan fetched content for injection patterns",
    injectionPatterns: DEFAULT_SECURITY_POLICY.web.injectionPatterns,
    _injectionPatterns: "Regex patterns (case-insensitive) that signal prompt injection",
  },
  annotation: {
    _comment: "Annotation guard — detects MCP tools that lie about being read-only",
    validateReadOnlyHint: DEFAULT_SECURITY_POLICY.annotation.validateReadOnlyHint,
    _validateReadOnlyHint: "Flag read-only tools whose name/params suggest mutating behavior",
    suspiciousToolNames: DEFAULT_SECURITY_POLICY.annotation.suspiciousToolNames,
    _suspiciousToolNames: "Tool name keywords that conflict with a read-only annotation",
    suspiciousParamNames: DEFAULT_SECURITY_POLICY.annotation.suspiciousParamNames,
    _suspiciousParamNames: "Parameter name keywords that conflict with a read-only annotation",
  },
} as const;

function generatePolicyTemplate(policyPath: string): void {
  const dir = resolve(policyPath, "..");
  mkdirSync(dir, { recursive: true });
  writeFileSync(policyPath, JSON.stringify(TEMPLATE, null, 2) + "\n", "utf-8");
}

export function loadSecurityPolicy(pilotHome: string): SecurityPolicy {
  const policyPath = resolve(pilotHome, POLICY_FILE_NAME);
  if (!existsSync(policyPath)) {
    generatePolicyTemplate(policyPath);
    return structuredClone(DEFAULT_SECURITY_POLICY);
  }

  let userPolicy: Partial<SecurityPolicy>;
  try {
    userPolicy = JSON.parse(readFileSync(policyPath, "utf-8"));
  } catch {
    return structuredClone(DEFAULT_SECURITY_POLICY);
  }

  return deepMerge(DEFAULT_SECURITY_POLICY, userPolicy);
}

function deepMerge<T extends Record<string, unknown>>(
  base: T,
  override: Partial<T>,
): T {
  const result: Record<string, unknown> = { ...base };
  for (const key of Object.keys(result)) {
    const overrideVal = (override as Record<string, unknown>)[key];
    const baseVal = result[key];
    if (
      overrideVal !== undefined &&
      typeof overrideVal === "object" &&
      !Array.isArray(overrideVal) &&
      overrideVal !== null &&
      typeof baseVal === "object" &&
      !Array.isArray(baseVal) &&
      baseVal !== null
    ) {
      result[key] = deepMerge(
        baseVal as Record<string, unknown>,
        overrideVal as Record<string, unknown>,
      );
    } else if (Array.isArray(baseVal) && Array.isArray(overrideVal)) {
      result[key] = [...baseVal, ...overrideVal];
    } else if (overrideVal !== undefined) {
      result[key] = overrideVal;
    }
  }
  return result as T;
}
