import { isPilotDeckHookEvent } from "../protocol/events.js";
import type {
  PilotDeckHookCommand,
  PilotDeckHookMatcher,
  PilotDeckHooksSettings,
} from "../protocol/settings.js";

export type ParseHooksConfigResult = {
  settings: PilotDeckHooksSettings;
  diagnostics: string[];
};

export function parseHooksConfig(raw: unknown): ParseHooksConfigResult {
  const diagnostics: string[] = [];
  const settings: PilotDeckHooksSettings = {};

  if (raw === undefined || raw === null) {
    return { settings, diagnostics };
  }
  if (!isRecord(raw)) {
    return { settings, diagnostics: ["Hooks config must be an object."] };
  }

  for (const [eventName, rawMatchers] of Object.entries(raw)) {
    if (!isPilotDeckHookEvent(eventName)) {
      diagnostics.push(`Unsupported hook event ${eventName}.`);
      continue;
    }
    if (!Array.isArray(rawMatchers)) {
      diagnostics.push(`Hook event ${eventName} must contain an array of matchers.`);
      continue;
    }

    const matchers: PilotDeckHookMatcher[] = [];
    for (const rawMatcher of rawMatchers) {
      const matcher = parseMatcher(eventName, rawMatcher, diagnostics);
      if (matcher) {
        matchers.push(matcher);
      }
    }
    if (matchers.length > 0) {
      settings[eventName] = matchers;
    }
  }

  return { settings, diagnostics };
}

function parseMatcher(eventName: string, rawMatcher: unknown, diagnostics: string[]): PilotDeckHookMatcher | undefined {
  if (!isRecord(rawMatcher)) {
    diagnostics.push(`Hook matcher for ${eventName} must be an object.`);
    return undefined;
  }
  if (!Array.isArray(rawMatcher.hooks)) {
    diagnostics.push(`Hook matcher for ${eventName} must contain hooks array.`);
    return undefined;
  }

  const hooks: PilotDeckHookCommand[] = [];
  for (const rawHook of rawMatcher.hooks) {
    const hook = parseHookCommand(eventName, rawHook, diagnostics);
    if (hook) {
      hooks.push(hook);
    }
  }

  return {
    matcher: typeof rawMatcher.matcher === "string" ? rawMatcher.matcher : undefined,
    pluginName: typeof rawMatcher.pluginName === "string" ? rawMatcher.pluginName : undefined,
    pluginId: typeof rawMatcher.pluginId === "string" ? rawMatcher.pluginId : undefined,
    pluginRoot: typeof rawMatcher.pluginRoot === "string" ? rawMatcher.pluginRoot : undefined,
    hooks,
  };
}

function parseHookCommand(eventName: string, rawHook: unknown, diagnostics: string[]): PilotDeckHookCommand | undefined {
  if (!isRecord(rawHook) || typeof rawHook.type !== "string") {
    diagnostics.push(`Hook for ${eventName} must contain a type.`);
    return undefined;
  }

  const common = {
    if: stringOrUndefined(rawHook.if),
    statusMessage: stringOrUndefined(rawHook.statusMessage),
    once: booleanOrUndefined(rawHook.once),
    timeout: numberOrUndefined(rawHook.timeout),
  };

  switch (rawHook.type) {
    case "command":
      if (typeof rawHook.command !== "string") {
        diagnostics.push(`Command hook for ${eventName} must contain command.`);
        return undefined;
      }
      return {
        type: "command",
        command: rawHook.command,
        shell: rawHook.shell === "powershell" ? "powershell" : rawHook.shell === "bash" ? "bash" : undefined,
        async: booleanOrUndefined(rawHook.async),
        asyncRewake: booleanOrUndefined(rawHook.asyncRewake),
        ...common,
      };
    case "prompt":
      if (typeof rawHook.prompt !== "string") {
        diagnostics.push(`Prompt hook for ${eventName} must contain prompt.`);
        return undefined;
      }
      return { type: "prompt", prompt: rawHook.prompt, model: stringOrUndefined(rawHook.model), ...common };
    case "http":
      if (typeof rawHook.url !== "string") {
        diagnostics.push(`HTTP hook for ${eventName} must contain url.`);
        return undefined;
      }
      return {
        type: "http",
        url: rawHook.url,
        headers: isRecord(rawHook.headers) ? stringifyRecord(rawHook.headers) : undefined,
        allowedEnvVars: Array.isArray(rawHook.allowedEnvVars)
          ? rawHook.allowedEnvVars.filter((value): value is string => typeof value === "string")
          : undefined,
        ...common,
      };
    case "agent":
      if (typeof rawHook.prompt !== "string") {
        diagnostics.push(`Agent hook for ${eventName} must contain prompt.`);
        return undefined;
      }
      return { type: "agent", prompt: rawHook.prompt, model: stringOrUndefined(rawHook.model), ...common };
    case "callback":
      diagnostics.push(`Callback hook for ${eventName} is runtime-only and cannot be loaded from persistent config.`);
      return undefined;
    default:
      diagnostics.push(`Unsupported hook type ${rawHook.type} for ${eventName}.`);
      return undefined;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringOrUndefined(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function booleanOrUndefined(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function numberOrUndefined(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function stringifyRecord(record: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  );
}
