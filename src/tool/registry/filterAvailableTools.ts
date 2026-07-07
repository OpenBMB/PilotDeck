import type {
  PilotDeckToolAvailability,
  PilotDeckToolAvailabilityContext,
  PilotDeckToolDefinition,
} from "../protocol/types.js";
import { ToolRegistry } from "./ToolRegistry.js";

export type PilotDeckUnavailableToolDiagnostic = {
  toolName: string;
  code: Exclude<PilotDeckToolAvailability, { ok: true }>["code"];
  reason: string;
};

export type FilterAvailableToolsResult = {
  registry: ToolRegistry;
  unavailable: PilotDeckUnavailableToolDiagnostic[];
};

export async function filterAvailableTools(
  registry: ToolRegistry,
  context: PilotDeckToolAvailabilityContext,
): Promise<FilterAvailableToolsResult> {
  const filtered = new ToolRegistry();
  const unavailable: PilotDeckUnavailableToolDiagnostic[] = [];
  const checkCache = new Map<
    NonNullable<PilotDeckToolDefinition["checkAvailability"]>,
    Promise<PilotDeckToolAvailability>
  >();

  for (const tool of registry.list()) {
    const availability = await resolveToolAvailability(tool, context, checkCache);
    if (availability.ok) {
      filtered.register(tool);
      continue;
    }

    unavailable.push({
      toolName: tool.name,
      code: availability.code,
      reason: availability.reason,
    });
  }

  return { registry: filtered, unavailable };
}

async function resolveToolAvailability(
  tool: PilotDeckToolDefinition,
  context: PilotDeckToolAvailabilityContext,
  cache: Map<NonNullable<PilotDeckToolDefinition["checkAvailability"]>, Promise<PilotDeckToolAvailability>>,
): Promise<PilotDeckToolAvailability> {
  const check = tool.checkAvailability;
  if (!check) {
    return { ok: true };
  }

  let promise = cache.get(check);
  if (!promise) {
    promise = Promise.resolve()
      .then(() => check(context))
      .catch((error): PilotDeckToolAvailability => ({
        ok: false,
        code: "failed_check",
        reason: error instanceof Error ? error.message : String(error),
      }));
    cache.set(check, promise);
  }

  return promise;
}
