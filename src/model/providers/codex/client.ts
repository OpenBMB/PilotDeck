import type { ProviderConfig } from "../../protocol/canonical.js";
import {
  resolveCodexRuntimeCredentials,
  type CodexAuthOptions,
  type CodexRuntimeCredentials,
} from "./auth.js";
import {
  CODEX_BASE_URL,
  CODEX_CATALOG_REQUEST_TIMEOUT_MS,
  CODEX_MODELS_URL,
  CODEX_PROVIDER_ID,
} from "./constants.js";
import { extractChatGptAccountId } from "./jwt.js";

export type CodexModel = {
  id: string;
  displayName: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  priority: number;
};

export const FALLBACK_CODEX_MODELS: readonly CodexModel[] = [
  codexModel("gpt-5.6-sol", "GPT-5.6 Sol"),
  codexModel("gpt-5.6-sol-pro", "GPT-5.6 Sol Pro"),
  codexModel("gpt-5.6-terra", "GPT-5.6 Terra"),
  codexModel("gpt-5.6-terra-pro", "GPT-5.6 Terra Pro"),
  codexModel("gpt-5.6-luna", "GPT-5.6 Luna"),
  codexModel("gpt-5.6-luna-pro", "GPT-5.6 Luna Pro"),
  codexModel("gpt-5.5", "GPT-5.5"),
  codexModel("gpt-5.4-mini", "GPT-5.4 Mini"),
  codexModel("gpt-5.4", "GPT-5.4"),
  codexModel("gpt-5.3-codex", "GPT-5.3 Codex"),
  codexModel("gpt-5.3-codex-spark", "GPT-5.3 Codex Spark", 128_000),
];

const FORWARD_COMPAT_CODEX_MODELS: ReadonlyArray<{
  modelId: string;
  templateIds: readonly string[];
}> = [
  { modelId: "gpt-5.6-sol", templateIds: ["gpt-5.5", "gpt-5.4"] },
  { modelId: "gpt-5.6-sol-pro", templateIds: ["gpt-5.5", "gpt-5.4"] },
  { modelId: "gpt-5.6-terra", templateIds: ["gpt-5.5", "gpt-5.4"] },
  { modelId: "gpt-5.6-terra-pro", templateIds: ["gpt-5.5", "gpt-5.4"] },
  { modelId: "gpt-5.6-luna", templateIds: ["gpt-5.5", "gpt-5.4"] },
  { modelId: "gpt-5.6-luna-pro", templateIds: ["gpt-5.5", "gpt-5.4"] },
  { modelId: "gpt-5.5", templateIds: ["gpt-5.4", "gpt-5.4-mini", "gpt-5.3-codex"] },
  { modelId: "gpt-5.4-mini", templateIds: ["gpt-5.3-codex"] },
  { modelId: "gpt-5.4", templateIds: ["gpt-5.3-codex"] },
  { modelId: "gpt-5.3-codex-spark", templateIds: ["gpt-5.3-codex"] },
];

export type CodexClientOptions = CodexAuthOptions & {
  credentials?: CodexRuntimeCredentials;
};

export class CodexApiError extends Error {
  readonly status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "CodexApiError";
    this.status = status;
  }
}

export function isCodexSubscriptionProvider(
  provider: Pick<ProviderConfig, "id" | "protocol" | "url">,
): boolean {
  if (provider.id.toLowerCase() !== CODEX_PROVIDER_ID) return false;
  if (provider.protocol !== "openai-responses") return false;
  try {
    const url = new URL(provider.url);
    return url.protocol === "https:"
      && url.hostname.toLowerCase() === "chatgpt.com"
      && url.pathname.replace(/\/+$/, "") === "/backend-api/codex";
  } catch {
    return false;
  }
}

export function buildCodexRequestHeaders(
  accessToken: string,
  extraHeaders: Record<string, string> = {},
): Record<string, string> {
  const headers: Record<string, string> = {
    ...extraHeaders,
    authorization: `Bearer ${accessToken.trim()}`,
    originator: "codex_cli_rs",
    "user-agent": "codex_cli_rs/0.0.0 (PilotDeck)",
  };
  const accountId = extractChatGptAccountId(accessToken);
  if (accountId) headers["ChatGPT-Account-Id"] = accountId;
  return headers;
}

export async function fetchCodexModels(
  options: CodexClientOptions = {},
): Promise<CodexModel[]> {
  const fetchImpl = options.fetch ?? fetch;
  let credentials = options.credentials
    ?? await resolveCodexRuntimeCredentials(options);

  let response = await fetchImpl(CODEX_MODELS_URL, {
    method: "GET",
    headers: buildCodexRequestHeaders(credentials.accessToken),
    signal: AbortSignal.timeout(CODEX_CATALOG_REQUEST_TIMEOUT_MS),
  });
  if (response.status === 401 && !options.credentials) {
    credentials = await resolveCodexRuntimeCredentials({
      ...options,
      forceRefresh: true,
    });
    response = await fetchImpl(CODEX_MODELS_URL, {
      method: "GET",
      headers: buildCodexRequestHeaders(credentials.accessToken),
      signal: AbortSignal.timeout(CODEX_CATALOG_REQUEST_TIMEOUT_MS),
    });
  }
  if (!response.ok) {
    const detail = await response.text();
    throw new CodexApiError(
      detail.trim()
        ? `Codex model catalog request failed (${response.status}): ${detail.trim()}`
        : `Codex model catalog request failed with HTTP ${response.status}.`,
      response.status,
    );
  }
  const value = await response.json();
  const rawModels = isRecord(value) && Array.isArray(value.models)
    ? value.models
    : [];
  const models = rawModels
    .map(parseCodexModel)
    .filter((model): model is CodexModel => Boolean(model))
    .sort((left, right) => left.priority - right.priority || left.id.localeCompare(right.id));
  return addForwardCompatibleModels(dedupeModels(models));
}

export async function probeCodexModel(
  model: string,
  options: CodexClientOptions = {},
): Promise<void> {
  const fetchImpl = options.fetch ?? fetch;
  let credentials = options.credentials
    ?? await resolveCodexRuntimeCredentials(options);
  const send = () => fetchImpl(`${CODEX_BASE_URL}/responses`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...buildCodexRequestHeaders(credentials.accessToken),
    },
    body: JSON.stringify({
      model,
      instructions: "You are a helpful coding agent.",
      input: [{ role: "user", content: [{ type: "input_text", text: "Reply with OK." }] }],
      store: false,
      stream: true,
    }),
    signal: AbortSignal.timeout(CODEX_CATALOG_REQUEST_TIMEOUT_MS),
  });
  let response = await send();
  if (response.status === 401 && !options.credentials) {
    credentials = await resolveCodexRuntimeCredentials({
      ...options,
      forceRefresh: true,
    });
    response = await send();
  }
  if (!response.ok) {
    const detail = await response.text();
    throw new CodexApiError(
      detail.trim()
        ? `Codex connection test failed (${response.status}): ${detail.trim()}`
        : `Codex connection test failed with HTTP ${response.status}.`,
      response.status,
    );
  }
  await response.body?.cancel().catch(() => undefined);
}

function parseCodexModel(value: unknown): CodexModel | undefined {
  if (!isRecord(value)) return undefined;
  const id = readString(value.slug) || readString(value.id);
  if (!id) return undefined;
  const visibility = readString(value.visibility).toLowerCase();
  if (visibility === "hide" || visibility === "hidden") return undefined;
  return {
    id,
    displayName: readString(value.display_name)
      || readString(value.displayName)
      || id,
    contextWindow: readPositiveInteger(value.context_window),
    maxOutputTokens: readPositiveInteger(value.max_output_tokens),
    priority: readFiniteNumber(value.priority) ?? 10_000,
  };
}

function dedupeModels(models: CodexModel[]): CodexModel[] {
  const seen = new Set<string>();
  return models.filter((model) => {
    if (seen.has(model.id)) return false;
    seen.add(model.id);
    return true;
  });
}

function addForwardCompatibleModels(models: CodexModel[]): CodexModel[] {
  const result = [...models];
  const seen = new Set(result.map((model) => model.id));
  const fallbacks = new Map(FALLBACK_CODEX_MODELS.map((model) => [model.id, model]));
  for (const entry of FORWARD_COMPAT_CODEX_MODELS) {
    if (
      seen.has(entry.modelId)
      || !entry.templateIds.some((templateId) => seen.has(templateId))
    ) {
      continue;
    }
    const model = fallbacks.get(entry.modelId);
    if (!model) continue;
    result.push(model);
    seen.add(model.id);
  }
  return result;
}

function codexModel(
  id: string,
  displayName: string,
  contextWindow = 272_000,
): CodexModel {
  return { id, displayName, contextWindow, maxOutputTokens: 128_000, priority: 10_000 };
}

function readString(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function readFiniteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function readPositiveInteger(value: unknown): number | undefined {
  const number = readFiniteNumber(value);
  return number !== undefined && number > 0 ? Math.floor(number) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
