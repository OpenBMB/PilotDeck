export { isCodexSubscriptionProvider } from "../../providerEndpoint.js";
import { randomUUID } from "node:crypto";

import {
  resolveCodexRuntimeCredentials,
  type CodexAuthOptions,
  type CodexRuntimeCredentials,
} from "./auth.js";
import {
  CODEX_BASE_URL,
  CODEX_CATALOG_REQUEST_TIMEOUT_MS,
  CODEX_MODELS_URL,
} from "./constants.js";
import { extractChatGptAccountId } from "./jwt.js";

export type CodexModel = {
  id: string;
  displayName: string;
  contextWindow?: number;
  maxOutputTokens?: number;
  priority: number;
};

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

export function buildCodexRequestHeaders(
  accessToken: string,
  extraHeaders: Record<string, string> = {},
): Record<string, string> {
  const headers = copyAllowedHeaders(extraHeaders, new Set([
    "authorization",
    "chatgpt-account-id",
    "originator",
  ]));
  headers.authorization = `Bearer ${accessToken.trim()}`;
  headers.originator = "codex_cli_rs";
  headers["user-agent"] ??= "codex_cli_rs/0.0.0 (PilotDeck)";
  const accountId = extractChatGptAccountId(accessToken);
  if (accountId) headers["ChatGPT-Account-Id"] = accountId;
  return headers;
}

export function buildCodexResponsesRequestHeaders(
  accessToken: string,
  extraHeaders: Record<string, string> = {},
): Record<string, string> {
  return {
    ...buildCodexRequestHeaders(accessToken, copyAllowedHeaders(extraHeaders, new Set([
      "accept",
      "openai-beta",
      "x-client-request-id",
    ]))),
    accept: "text/event-stream",
    "OpenAI-Beta": "responses=experimental",
    "x-client-request-id": randomUUID(),
  };
}

function copyAllowedHeaders(
  headers: Record<string, string>,
  excludedNames: ReadonlySet<string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(headers).filter(([name]) => !excludedNames.has(name.toLowerCase())),
  );
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
  return dedupeModels(models);
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
      ...buildCodexResponsesRequestHeaders(credentials.accessToken),
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
  if (
    visibility === "hide"
    || visibility === "hidden"
    || value.supported_in_api === false
  ) return undefined;
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
