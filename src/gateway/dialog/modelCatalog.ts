import { loadPilotConfig } from "../../pilot/config/loadPilotConfig.js";
import type { ThinkingMode } from "../../model/thinking/registry.js";
import type {
  ExplicitModelSelection,
  ModelCatalogItem,
  ModelCatalogListInput,
  ModelCatalogListResult,
  SessionModelSelection,
} from "../protocol/types.js";
import { DialogGatewayError } from "./errors.js";

const REASONING_VALUES = new Map<number, ThinkingMode>([
  [0.4, "low"], [0.6, "medium"],
  [0.8, "high"], [0.9, "xhigh"], [1, "max"],
]);

export function listModelCatalog(input: ModelCatalogListInput, env: NodeJS.ProcessEnv = process.env): ModelCatalogListResult {
  const config = loadPilotConfig({ env }).config;
  const query = input.query?.trim().toLocaleLowerCase() ?? "";
  const items: ModelCatalogItem[] = [];
  for (const [providerId, provider] of Object.entries(config.model.providers)) {
    if (input.provider && input.provider !== providerId) continue;
    for (const [modelId, model] of Object.entries(provider.models)) {
      const displayName = model.displayName ?? model.id;
      if (query && !`${providerId} ${modelId} ${displayName}`.toLocaleLowerCase().includes(query)) continue;
      const reasoning = model.thinking?.state === "enabled"
        ? [...REASONING_VALUES.entries()]
          .filter(([, mode]) => model.thinking?.efforts.some(effort => effort === mode))
          .map(([value]) => value)
        : [];
      const speed = model.capabilities.supportsSpeed === true && provider.speedMapping !== undefined;
      items.push({
        id: `${providerId}/${modelId}`,
        provider: providerId,
        model: modelId,
        displayName,
        available: Boolean(provider.apiKey),
        capabilities: {
          ...(model.thinking?.state === "enabled" ? { reasoning: { type: "enum" as const, values: reasoning } } : {}),
          ...(speed ? { speed: { type: "enum" as const, values: [0, 1] } } : {}),
        },
      });
    }
  }
  items.sort((left, right) => left.id.localeCompare(right.id));
  const routerEnabled = config.router?.enabled === true;
  if (routerEnabled && input.includeAuto === true && (!input.provider || input.provider === "router")
    && (!query || "router auto".includes(query))) {
    items.unshift({ id: "router/auto", provider: "router", model: "auto", displayName: "Auto", available: true, capabilities: {} });
  }
  return {
    items,
    defaultSelection: { mode: "model", provider: config.agent.model.provider, model: config.agent.model.model },
    router: { enabled: routerEnabled, autoAvailable: routerEnabled },
  };
}

export function validateModelSelection(projectKey: string, selection: SessionModelSelection, env: NodeJS.ProcessEnv = process.env): void {
  if (selection?.mode === "auto") {
    if (!listModelCatalog({ projectKey }, env).router.autoAvailable) {
      throw new DialogGatewayError("ROUTER_AUTO_UNAVAILABLE", "Router auto is not available for this project.");
    }
    return;
  }
  validateExplicitModelSelection(projectKey, selection, env);
}

export function validateExplicitModelSelection(projectKey: string, selection: ExplicitModelSelection, env: NodeJS.ProcessEnv = process.env): void {
  if (!selection || selection.mode !== "model" || typeof selection.provider !== "string" || typeof selection.model !== "string") {
    throw new DialogGatewayError("INVALID_MODEL_OVERRIDE", "A model selection requires mode, provider, and model.");
  }
  const catalog = listModelCatalog({ projectKey }, env);
  const item = catalog.items.find((candidate) => candidate.provider === selection.provider && candidate.model === selection.model);
  if (!item || !item.available) throw new DialogGatewayError("INVALID_MODEL_OVERRIDE", `Model is unavailable: ${selection.provider}/${selection.model}`);
  if (selection.speed !== undefined && (!Number.isFinite(selection.speed) || selection.speed < 0 || selection.speed > 1)) {
    throw new DialogGatewayError("UNSUPPORTED_MODEL_PARAMETER", "speed must be between 0 and 1.");
  }
  if (selection.speed !== undefined && !item.capabilities.speed) {
    throw new DialogGatewayError("UNSUPPORTED_MODEL_PARAMETER", `speed is not supported by ${item.id}.`);
  }
  if (selection.reasoning !== undefined && !item.capabilities.reasoning?.values?.includes(selection.reasoning)) {
    throw new DialogGatewayError("UNSUPPORTED_MODEL_PARAMETER", `reasoning=${selection.reasoning} is not supported by ${item.id}.`);
  }
}

export function reasoningMode(value: number | undefined): ThinkingMode | undefined {
  if (value === undefined) return undefined;
  return REASONING_VALUES.get(value);
}

/** Drop retired preference fields without relaxing validation of incoming values. */
export function normalizeSessionModelSelection(selection: SessionModelSelection): SessionModelSelection {
  if (selection.mode === "auto") return { mode: "auto" };
  if (selection.mode !== "model") return selection;
  return {
    mode: "model", provider: selection.provider, model: selection.model,
    ...(selection.reasoning !== undefined ? { reasoning: selection.reasoning } : {}),
    ...(selection.speed !== undefined ? { speed: selection.speed } : {}),
  };
}

/** Historical effort choices can expire after upgrades or model configuration changes. */
export function restoreSessionModelSelection(
  projectKey: string,
  selection: SessionModelSelection,
  env: NodeJS.ProcessEnv = process.env,
): SessionModelSelection {
  const restored = normalizeSessionModelSelection(selection);
  if (restored.mode !== "model" || restored.reasoning === undefined) return restored;
  const item = listModelCatalog({ projectKey }, env).items.find(
    candidate => candidate.provider === restored.provider && candidate.model === restored.model,
  );
  if (!item?.capabilities.reasoning?.values?.includes(restored.reasoning)) {
    delete restored.reasoning;
  }
  return restored;
}
