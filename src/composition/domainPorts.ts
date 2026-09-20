import type { PluginSkillContribution } from "../extension/plugins/runtime/PluginRuntime.js";
import type {
  SkillAddressInput,
  SkillCreateInput,
  SkillCreateResult,
  SkillDeleteInput,
  SkillDeleteResult,
  SkillImportInput,
  SkillImportResult,
  SkillManagementPort,
  SkillReadResult,
  SkillScanInput,
  SkillScanResult,
  SkillValidateInput,
  SkillValidationResult,
  SkillWriteInput,
  SkillWriteResult,
  SkillsListInput,
  SkillsListResult,
} from "../extension/skills/types.js";
import type { PilotDeckToolDefinition } from "../tool/index.js";
import { HttpModuleClient } from "./HttpModuleClient.js";
import type { ExternalModuleBinding } from "./types.js";

export type { SkillManagementPort } from "../extension/skills/types.js";

export type SkillModulePort = Readonly<{
  list(input: { projectKey?: string | null }): Promise<readonly PluginSkillContribution[]>;
  read(input: { name: string; projectKey?: string | null }): Promise<string | undefined>;
}>;

export type KnowledgeModulePort = Readonly<{
  call(operation: string, input: Record<string, unknown>): Promise<unknown>;
}>;

export function createSkillModulePort(binding: ExternalModuleBinding): SkillModulePort {
  const client = new HttpModuleClient(binding);
  let sequence = 0;
  const call = async (operation: string, input: Record<string, unknown>): Promise<unknown> => {
    assertDeclaredMethod(binding, operation, "Skill");
    const response = await client.call({
      runId: "skills",
      operationId: "skills",
      requestId: `skills-${operation}-${++sequence}`,
      module: "skills",
      payload: { operation, input },
    });
    if (!response.ok) throw moduleFailure(response, `Skill module ${operation} failed.`);
    return response.payload?.result;
  };
  return Object.freeze({
    async list(input) {
      const value = await call("list", input);
      if (Array.isArray(value)) return value.map(readSkillContribution);
      if (isRecord(value) && Array.isArray(value.items)) return value.items.map(readSkillContribution);
      throw protocolFailure("Skill list result must be an array or a management list result.");
    },
    async read(input) {
      const value = await call("read", input);
      if (value === null || value === undefined) return undefined;
      if (typeof value === "string") return value;
      if (isRecord(value) && typeof value.content === "string") return value.content;
      throw protocolFailure("Skill read result must contain string content or be null.");
    },
  });
}

/**
 * Build the full SkillManager-compatible management adapter.  Runtime skill
 * discovery above intentionally projects list/read into Plugin contributions;
 * this port preserves the richer CRUD/validation/import/scan result shapes
 * for Gateway callers.
 */
export function createSkillManagementPort(binding: ExternalModuleBinding): SkillManagementPort {
  const client = new HttpModuleClient(binding);
  let sequence = 0;
  const call = async (operation: string, input: Record<string, unknown>): Promise<unknown> => {
    assertDeclaredMethod(binding, operation, "Skill");
    const response = await client.call({
      runId: "skills-management",
      operationId: "skills-management",
      requestId: `skills-management-${operation}-${++sequence}`,
      module: "skills",
      payload: { operation, input },
    });
    if (!response.ok) throw moduleFailure(response, `Skill module ${operation} failed.`);
    return response.payload?.result;
  };
  const result = async <T>(operation: string, input: Record<string, unknown>): Promise<T> => {
    const value = await call(operation, input);
    if (!isRecord(value)) throw protocolFailure(`Skill ${operation} result must be an object.`);
    return value as T;
  };
  return Object.freeze({
    list: (input: SkillsListInput) => result<SkillsListResult>("list", input as Record<string, unknown>),
    read: (input: SkillAddressInput) => result<SkillReadResult>("read", input as Record<string, unknown>),
    write: (input: SkillWriteInput) => result<SkillWriteResult>("write", input as Record<string, unknown>),
    create: (input: SkillCreateInput) => result<SkillCreateResult>("create", input as Record<string, unknown>),
    delete: (input: SkillDeleteInput) => result<SkillDeleteResult>("delete", input as Record<string, unknown>),
    import: (input: SkillImportInput) => result<SkillImportResult>("import", input as Record<string, unknown>),
    validate: (input: SkillValidateInput) => result<SkillValidationResult>("validate", input as Record<string, unknown>),
    scan: (input: SkillScanInput) => result<SkillScanResult>("scan", input as Record<string, unknown>),
  });
}

export function createKnowledgeModulePort(binding: ExternalModuleBinding): KnowledgeModulePort {
  const client = new HttpModuleClient(binding);
  let sequence = 0;
  return Object.freeze({
    async call(operation, input) {
      if (!binding.methods.includes(operation)) throw protocolFailure(`Knowledge operation '${operation}' is not declared.`);
      const response = await client.call({
        runId: "knowledge",
        operationId: "knowledge",
        requestId: `knowledge-${operation}-${++sequence}`,
        module: "knowledge",
        payload: { operation, input },
      });
      if (!response.ok) throw moduleFailure(response, `Knowledge module ${operation} failed.`);
      return response.payload?.result;
    },
  });
}

function assertDeclaredMethod(binding: ExternalModuleBinding, operation: string, owner: string): void {
  if (!binding.methods.includes(operation)) throw protocolFailure(`${owner} operation '${operation}' is not declared.`);
}

export function createKnowledgeQueryTool(port: KnowledgeModulePort): PilotDeckToolDefinition {
  return {
    name: "knowledge_query",
    description: "Query the configured knowledge module and return its evidence and citations.",
    kind: "custom",
    inputSchema: {
      type: "object",
      required: ["query"],
      additionalProperties: true,
      properties: { query: { type: "string" } },
    },
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    async execute(input) {
      const result = await port.call("query", input as Record<string, unknown>);
      return { content: [{ type: "json", value: result }], data: result };
    },
  };
}

function readSkillContribution(value: unknown): PluginSkillContribution {
  if (!isRecord(value)) {
    throw protocolFailure("Skill list item requires name and path.");
  }
  // SkillManager's management list exposes a display name and the immutable
  // command slug. Agent tool calls use the slug, so preserve it when present.
  const name = typeof value.slug === "string" ? value.slug : value.name;
  const path = typeof value.path === "string" ? value.path : value.skillFile;
  if (typeof name !== "string" || typeof path !== "string") {
    throw protocolFailure("Skill list item requires name and path.");
  }
  return {
    name,
    path,
    ...(typeof value.description === "string" ? { description: value.description } : {}),
    ...(typeof value.content === "string" ? { content: value.content } : {}),
    ...(typeof value.namespace === "string" ? { namespace: value.namespace } : {}),
  };
}

function moduleFailure(response: { code?: string; error?: Record<string, unknown> }, fallback: string): Error & { code?: string } {
  const error = Object.assign(new Error(String(response.error?.message ?? response.code ?? fallback)), {
    code: response.code,
    retryability: response.error?.retryability,
    details: response.error?.details,
  });
  return error;
}

function protocolFailure(message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code: "MODULE_PROTOCOL_INCOMPATIBLE" });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
