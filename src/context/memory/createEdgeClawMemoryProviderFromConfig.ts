/**
 * Build an `EdgeClawMemoryProvider` from `PilotMemoryConfig` + project root.
 * The factory is intentionally small — it just constructs the underlying
 * `EdgeClawMemoryService` with a sensible default rootDir and forwards the
 * relevant config fields.
 *
 * Returns `undefined` when the config is missing or `enabled === false`.
 *
 * Behavior parity goals:
 *   - The provider lives at the per-project scope (one DB per project root).
 *   - When `config.rootDir` is set we pin the workspace dir there; otherwise
 *     we anchor it under the project root so memory data lives next to the
 *     code it was captured from (matches legacy default).
 *   - `apiKey` for the LLM extractor is **lazily forwarded** — the user is
 *     expected to set it through env or pilotdeck.yaml; we never default
 *     credentials to anything other than what the user supplied.
 */

import { EdgeClawMemoryService, type EdgeClawMemoryLlmOptions } from "edgeclaw-memory-core";
import { EdgeClawMemoryProvider } from "./EdgeClawMemoryProvider.js";
import type { ModelConfig } from "../../model/protocol/canonical.js";
import type { PilotMemoryConfig } from "../../pilot/config/types.js";

export type CreateEdgeClawMemoryProviderOptions = {
  config: PilotMemoryConfig | undefined;
  modelConfig?: ModelConfig;
  projectRoot: string;
  /** Optional logger forwarded to the underlying service. */
  logger?: {
    info?: (...args: unknown[]) => void;
    warn?: (...args: unknown[]) => void;
    error?: (...args: unknown[]) => void;
  };
  /** Optional `now` for deterministic tests. */
  now?: () => Date;
};

export function createEdgeClawMemoryProviderFromConfig(
  options: CreateEdgeClawMemoryProviderOptions,
): { provider: EdgeClawMemoryProvider; service: EdgeClawMemoryService } | undefined {
  const cfg = options.config;
  if (!cfg || cfg.enabled !== true) return undefined;
  if (cfg.provider !== "edgeclaw") return undefined;

  const workspaceDir = options.projectRoot;
  const rootDir = cfg.rootDir;

  const llm = resolveMemoryLlm(cfg, options.modelConfig);

  const service = new EdgeClawMemoryService({
    workspaceDir,
    rootDir,
    captureStrategy: cfg.captureStrategy,
    includeAssistant: cfg.includeAssistant,
    maxMessageChars: cfg.maxMessageChars,
    heartbeatBatchSize: cfg.heartbeatBatchSize,
    defaultIndexingSettings: cfg.schedule,
    source: "pilotdeck",
    logger: options.logger,
    llm,
  });

  const provider = new EdgeClawMemoryProvider({
    service,
    source: "pilotdeck",
    now: options.now,
  });

  return { provider, service };
}

function resolveMemoryLlm(
  cfg: PilotMemoryConfig,
  modelConfig?: ModelConfig,
): EdgeClawMemoryLlmOptions | undefined {
  if (!cfg.model) return undefined;

  const sep = cfg.model.indexOf("/");
  if (sep < 0) return undefined;

  const providerId = cfg.model.slice(0, sep);
  const modelId = cfg.model.slice(sep + 1);
  const providerEntry = modelConfig?.providers[providerId];

  const llm: EdgeClawMemoryLlmOptions = {
    provider: providerId,
    model: modelId,
    baseUrl: providerEntry?.url,
    apiKey: providerEntry?.apiKey,
  };
  if (cfg.apiType !== undefined) {
    llm.apiType = cfg.apiType;
  }
  return llm;
}
