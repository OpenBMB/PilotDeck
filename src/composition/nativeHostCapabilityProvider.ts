/**
 * Native PilotDeck provider for the public host-capability gateway.
 *
 * This adapter is intentionally limited to capabilities with a real PD
 * runtime owner.  Unsupported management/file/task operations are omitted
 * from `operations` and return a typed 501 if called through a stale client;
 * Bash background tasks are never presented as SOP/Knowledge jobs.
 */
import type { ModelConfig, CanonicalModelRequest } from "../model/protocol/canonical.js";
import type { ModelRuntime } from "../model/ModelRuntime.js";
import { validateModelRequest } from "../model/request/validateModelRequest.js";
import { ModelProviderError, ModelRequestError } from "../model/protocol/errors.js";
import type { ToolRegistry } from "../tool/registry/ToolRegistry.js";
import type { ToolRuntime } from "../tool/execution/ToolRuntime.js";
import type { PilotDeckToolRuntimeContext } from "../tool/protocol/types.js";
import type { SkillManager } from "../extension/skills/SkillManager.js";
import type {
  PublicModelSelection,
  PublicHostPortError,
} from "./publicHostPorts.js";

export type PublicHostPrincipal = {
  hostAdapter?: 'pilotdeck' | 'staffdeck';
  pilotDeckUserId: string;
  tenantId: string;
  actorUserId: string;
  agentId?: string;
};

export type PublicCapabilityResponse = {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
};

export type NativePublicHostRuntime = {
  modelConfig: ModelConfig;
  defaultSelection?: { provider: string; model: string };
  modelRuntime: ModelRuntime;
  tools: ToolRegistry;
  toolRuntime: ToolRuntime;
  /** Builds the existing per-session context; the provider never invents one. */
  toolContext: (principal: PublicHostPrincipal, signal?: AbortSignal) => PilotDeckToolRuntimeContext;
  skills: SkillManager;
  projectKey?: string | null;
};

export type PublicHostCapabilityProvider = {
  operations: readonly string[];
  call: (
    operation: string,
    input: unknown,
    options: { signal?: AbortSignal; principal: PublicHostPrincipal },
  ) => Promise<PublicCapabilityResponse>;
};

const SUPPORTED_OPERATIONS = Object.freeze([
  "list_tools",
  "test_tool",
  "list_general_skills",
  "import_general_skill",
  "list_model_catalog",
  "model_prepare",
  "model_stream",
]);

export const PUBLIC_HOST_CAPABILITY_GAPS = Object.freeze({
  create_tool: "ToolRegistry has no persisted descriptor management owner; ToolPort.execute is not a create/update operation.",
  update_tool: "ToolRegistry.replace is in-memory only and has no public descriptor persistence contract.",
  probe_unsaved_tool: "No mounted unsaved-descriptor probe primitive exists in the native ToolPort.",
  remove_tool: "ToolRegistry.unregister has no persisted management/source contract.",
  publish_general_skill: "SkillManager has no publish lifecycle operation; create/write is not publish.",
  archive_general_skill: "SkillManager.delete is removal and cannot be exposed as archive.",
  test_general_skill: "SkillManager has validation, not the required general-skill test execution contract.",
  extract_sop_text: "No mounted file parsing Port is available in the native runtime root.",
  task_start: "BackgroundTaskRuntime is Bash-only and is not a SOP preview/APIJob/Knowledge ingest task namespace.",
  task_status: "No public domain task status reader is mounted at the host root.",
  task_result: "No public domain task result reader is mounted at the host root.",
  task_cancel: "No domain cancel primitive is available; disconnect must not call Bash task cancellation.",
  task_events: "No resumable domain event cursor is mounted at the host root.",
});

const unsupported = (operation: string): PublicCapabilityResponse => ({
  status: 501,
  body: {
    code: "PUBLIC_HOST_CAPABILITY_UNAVAILABLE",
    operation,
    message: "No equivalent configured PilotDeck runtime capability is available.",
  } satisfies PublicHostPortError & { operation: string },
});

const invalid = (message: string): PublicCapabilityResponse => ({
  status: 400,
  body: { code: "PUBLIC_HOST_INPUT_INVALID", message },
});

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : undefined;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`${field} must be a non-empty string.`);
  return value;
}

function modelSelection(config: ModelConfig, requestedModelId: string): PublicModelSelection {
  const matches: PublicModelSelection[] = [];
  for (const provider of Object.values(config.providers)) {
    for (const model of Object.values(provider.models)) {
      if (requestedModelId === `${provider.id}/${model.id}`) {
        matches.push({ requestedModelId, selectedModelId: model.id, providerId: provider.id });
      }
    }
  }
  if (matches.length !== 1) {
    throw new Error(matches.length === 0 ? "model_not_found" : "model_id_ambiguous");
  }
  return matches[0];
}

function validateBudget(input: Record<string, unknown>, selection: PublicModelSelection, runtime: NativePublicHostRuntime): void {
  const budget = asRecord(input.budget);
  if (!budget) return;
  for (const field of ["maxOutputTokens", "maxInputTokens", "timeoutMs"]) {
    if (budget[field] !== undefined && (!Number.isInteger(budget[field]) || Number(budget[field]) <= 0)) {
      throw new ModelRequestError("invalid_budget", `${field} must be a positive integer.`);
    }
  }
  const maxOutput = budget.maxOutputTokens;
  const cap = runtime.modelRuntime.getCapabilities(selection.providerId, selection.selectedModelId).maxOutputTokens;
  if (typeof maxOutput === "number" && cap !== undefined && maxOutput > cap) {
    throw new ModelRequestError("invalid_budget", `maxOutputTokens exceeds the selected model cap (${cap}).`);
  }
}

function descriptor(tool: ReturnType<ToolRegistry["list"]>[number]) {
  return {
    name: tool.name,
    aliases: tool.aliases,
    title: tool.title,
    description: tool.description,
    kind: tool.kind,
    inputSchema: tool.inputSchema,
    outputSchema: tool.outputSchema,
    maxResultBytes: tool.maxResultBytes,
    shouldDefer: tool.shouldDefer,
    alwaysLoad: tool.alwaysLoad,
    searchHint: tool.searchHint,
  };
}

function skillInput(input: Record<string, unknown>, projectKey: string | null | undefined) {
  return {
    scope: input.scope,
    slug: input.slug,
    projectKey: input.projectKey ?? projectKey,
    name: input.name,
    description: input.description,
    body: input.body,
    content: input.content,
  } as never;
}

/** Build the real native provider from the selected PD runtime objects. */
export function createNativeHostCapabilityProvider(runtime: NativePublicHostRuntime): PublicHostCapabilityProvider {
  const call = async (
    operation: string,
    rawInput: unknown,
    options: { signal?: AbortSignal; principal: PublicHostPrincipal },
  ): Promise<PublicCapabilityResponse> => {
    if (!SUPPORTED_OPERATIONS.includes(operation)) return unsupported(operation);
    const input = asRecord(rawInput);
    if (!input) return invalid("input must be an object.");
    if (options.signal?.aborted) return { status: 499, body: { code: "PUBLIC_HOST_CANCELLED" } };
    try {
      switch (operation) {
        case "list_tools":
          return { status: 200, body: { data: runtime.tools.list().map(descriptor) } };
        case "test_tool": {
          const name = requireString(input.toolId ?? input.name, "toolId");
          const testInput = Object.hasOwn(input, "input") ? input.input : input.body;
          if (testInput === undefined) return invalid("test_tool requires body/input.");
          const result = await runtime.toolRuntime.execute(
            { id: `public-test-${name}`, name, input: testInput },
            runtime.toolContext(options.principal, options.signal),
          );
          return { status: 200, body: result };
        }
        case "list_general_skills": {
          const result = await runtime.skills.list({
            projectKey: runtime.projectKey,
            scope: input.scope as never,
            query: input.query as string | undefined,
            cursor: input.cursor as string | undefined,
            limit: input.limit as number | undefined,
          });
          return {
            status: 200,
            body: {
              data: result.items,
              next_cursor: result.nextCursor ?? null,
              builtin: result.builtin,
              user: result.user,
              project: result.project,
              projectPath: result.projectPath,
            },
          };
        }
        case "import_general_skill": {
          const payload = asRecord(input.body) ?? input;
          return { status: 200, body: await runtime.skills.create(skillInput(payload, runtime.projectKey)) };
        }
        case "list_model_catalog": {
          const data = Object.values(runtime.modelConfig.providers).flatMap((provider) =>
            Object.values(provider.models).map((model) => ({
              id: `${provider.id}/${model.id}`,
              name: model.displayName ?? model.id,
              model: model.id,
              provider: provider.id,
              enabled: true,
              is_default: runtime.defaultSelection?.provider === provider.id && runtime.defaultSelection.model === model.id,
            })),
          );
          return { status: 200, body: { data } };
        }
        case "model_prepare": {
          const request = asRecord(input.request) as Partial<CanonicalModelRequest> | undefined;
          const requestedModelId = requireString(input.modelId ?? request?.model, "modelId");
          const selection = modelSelection(runtime.modelConfig, requestedModelId);
          validateBudget(input, selection, runtime);
          const preparedRequest = { ...request, model: selection.selectedModelId, provider: selection.providerId } as CanonicalModelRequest;
          validateModelRequest(preparedRequest, runtime.modelConfig);
          return {
            status: 200,
            body: {
              requestId: requireString(input.requestId, "requestId"),
              selection,
              request: preparedRequest,
            },
          };
        }
        case "model_stream": {
          const request = asRecord(input.request) as Partial<CanonicalModelRequest> | undefined;
          const requestedModelId = requireString(input.modelId ?? request?.model, "modelId");
          const selection = modelSelection(runtime.modelConfig, requestedModelId);
          const canonicalRequest = {
            ...request,
            model: selection.selectedModelId,
            provider: selection.providerId,
          } as CanonicalModelRequest;
          validateModelRequest(canonicalRequest, runtime.modelConfig);
          const events = runtime.modelRuntime.stream(canonicalRequest, { signal: options.signal });
          return {
            status: 200,
            headers: {
              "content-type": "application/x-ndjson",
              "x-pilotdeck-model-id": selection.selectedModelId,
              "x-pilotdeck-provider-id": selection.providerId,
            },
            body: events,
          };
        }
        default:
          return unsupported(operation);
      }
    } catch (error) {
      if (options.signal?.aborted) return { status: 499, body: { code: "PUBLIC_HOST_CANCELLED" } };
      if (error instanceof ModelProviderError) {
        return { status: error.error.status ?? 502, body: error.error };
      }
      if (error instanceof ModelRequestError) {
        return { status: 400, body: { code: error.code, message: error.message, details: error.details } };
      }
      const message = error instanceof Error ? error.message : String(error);
      return { status: 502, body: { code: "PUBLIC_HOST_PROVIDER_ERROR", operation, message } };
    }
  };
  return { operations: SUPPORTED_OPERATIONS, call };
}
