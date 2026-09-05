import type {
  ChatModelCatalogItem,
  ChatModelSelection,
  ModelNumericCapability,
} from "../chat/hooks/useChatProviderState";

export type ModelParameterValues = {
  reasoning?: number;
  temperature?: number;
  speed?: number;
};

export const REASONING_LABELS = new Map<number, string>([
  [0, "Off"],
  [0.2, "Light"],
  [0.4, "Low"],
  [0.6, "Medium"],
  [0.8, "High"],
  [0.9, "Extra high"],
  [1, "Maximum"],
]);

export const SPEED_LABELS = new Map<number, string>([
  [0, "Standard"],
  [1, "Fast"],
]);

export function readFiniteNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : undefined;
  }
  return undefined;
}

export function sameCapabilityValue(
  left: number | undefined,
  right: number,
): boolean {
  return left !== undefined && Math.abs(left - right) < 1e-9;
}

export function capabilityValues(capability?: ModelNumericCapability): number[] {
  if (!capability) return [];
  if (Array.isArray(capability.values)) {
    return capability.values.filter(Number.isFinite);
  }
  if (
    capability.type !== "range" ||
    !Number.isFinite(capability.min) ||
    !Number.isFinite(capability.max) ||
    !Number.isFinite(capability.step) ||
    (capability.step ?? 0) <= 0
  ) {
    return [];
  }

  const min = capability.min as number;
  const max = capability.max as number;
  const step = capability.step as number;
  const values: number[] = [];
  for (
    let value = min;
    value <= max + step / 2 && values.length < 101;
    value += step
  ) {
    values.push(Number(value.toFixed(10)));
  }
  return values;
}

export function speedOptionValues(capability?: ModelNumericCapability): number[] {
  if (!capability) return [];
  const values = capabilityValues(capability);
  if (values.length > 0 && values.length <= 8) return values;
  return [0, 1];
}

export function capabilityIncludesValue(
  capability: ModelNumericCapability | undefined,
  value: number,
): boolean {
  if (!capability || !Number.isFinite(value)) return false;
  const values = capabilityValues(capability);
  if (values.length > 0) {
    return values.some((candidate) => sameCapabilityValue(candidate, value));
  }
  if (capability.type === "range") {
    const min = capability.min ?? 0;
    const max = capability.max ?? 1;
    return value >= min && value <= max;
  }
  return false;
}

export function modelSelectionId(selection: ChatModelSelection | null | undefined): string {
  return selection?.mode === "auto"
    ? "router/auto"
    : selection?.mode === "model"
      ? `${selection.provider}/${selection.model}`
      : "";
}

export function paramsFromSelection(
  selection: ChatModelSelection | null | undefined,
  modelId?: string,
): ModelParameterValues {
  if (selection?.mode !== "model") return {};
  if (modelId && modelSelectionId(selection) !== modelId) return {};
  const reasoning = readFiniteNumber(selection.reasoning);
  const temperature = readFiniteNumber(selection.temperature);
  const speed = readFiniteNumber(selection.speed);
  return {
    ...(reasoning !== undefined ? { reasoning } : {}),
    ...(temperature !== undefined ? { temperature } : {}),
    ...(speed !== undefined ? { speed } : {}),
  };
}

export function buildExplicitSelection(
  item: Pick<ChatModelCatalogItem, "provider" | "model">,
  params: ModelParameterValues = {},
): Extract<ChatModelSelection, { mode: "model" }> {
  const selection: Extract<ChatModelSelection, { mode: "model" }> = {
    mode: "model",
    provider: item.provider,
    model: item.model,
  };
  if (params.reasoning !== undefined) selection.reasoning = params.reasoning;
  if (params.temperature !== undefined) selection.temperature = params.temperature;
  if (params.speed !== undefined) selection.speed = params.speed;
  return selection;
}

export function preserveParamsForModel(
  item: ChatModelCatalogItem,
  selection: ChatModelSelection | null | undefined,
): ModelParameterValues {
  if (selection?.mode !== "model") return {};
  const reasoning = readFiniteNumber(selection.reasoning);
  const temperature = readFiniteNumber(selection.temperature);
  const speed = readFiniteNumber(selection.speed);
  return {
    ...(item.capabilities.reasoning &&
    reasoning !== undefined &&
    capabilityIncludesValue(item.capabilities.reasoning, reasoning)
      ? { reasoning }
      : {}),
    ...(item.capabilities.temperature &&
    temperature !== undefined &&
    capabilityIncludesValue(item.capabilities.temperature, temperature)
      ? { temperature }
      : {}),
    ...(item.capabilities.speed &&
    speed !== undefined &&
    (capabilityIncludesValue(item.capabilities.speed, speed) ||
      speedOptionValues(item.capabilities.speed).some((value) =>
        sameCapabilityValue(speed, value),
      ))
      ? { speed }
      : {}),
  };
}

export function mergeModelSelections(
  saved: ChatModelSelection | null | undefined,
  stored: ChatModelSelection | null | undefined,
): ChatModelSelection | null {
  if (!saved) return stored ?? null;
  if (!stored) return saved;
  if (saved.mode !== "model" || stored.mode !== "model") return saved;
  if (saved.provider !== stored.provider || saved.model !== stored.model) {
    return saved;
  }
  return buildExplicitSelection(saved, {
    ...paramsFromSelection(stored),
    ...paramsFromSelection(saved),
  });
}

export function normalizeModelSelection(value: unknown): ChatModelSelection | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (record.mode === "auto") return { mode: "auto" };
  if (
    record.mode === "model" &&
    typeof record.provider === "string" &&
    typeof record.model === "string"
  ) {
    return buildExplicitSelection(
      { provider: record.provider, model: record.model },
      {
        reasoning: readFiniteNumber(record.reasoning),
        temperature: readFiniteNumber(record.temperature),
        speed: readFiniteNumber(record.speed),
      },
    );
  }
  return null;
}

export function parseNumericCapability(value: unknown): ModelNumericCapability | undefined {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const type = record.type === "enum" || record.type === "range" ? record.type : undefined;
  if (!type) return undefined;
  const values = Array.isArray(record.values)
    ? record.values.map(readFiniteNumber).filter((item): item is number => item !== undefined)
    : undefined;
  const min = readFiniteNumber(record.min);
  const max = readFiniteNumber(record.max);
  const step = readFiniteNumber(record.step);
  const parsed: ModelNumericCapability = { type };
  if (min !== undefined) parsed.min = min;
  if (max !== undefined) parsed.max = max;
  if (step !== undefined) parsed.step = step;
  if (values && values.length > 0) parsed.values = values;
  return parsed;
}

export function parseCatalogItem(value: unknown): ChatModelCatalogItem | null {
  if (!value || typeof value !== "object") return null;
  const record = value as Record<string, unknown>;
  if (
    typeof record.id !== "string" ||
    typeof record.provider !== "string" ||
    typeof record.model !== "string"
  ) {
    return null;
  }
  const capabilitiesRecord =
    record.capabilities && typeof record.capabilities === "object"
      ? (record.capabilities as Record<string, unknown>)
      : {};
  const reasoning = parseNumericCapability(capabilitiesRecord.reasoning);
  const temperature = parseNumericCapability(capabilitiesRecord.temperature);
  const speed = parseNumericCapability(capabilitiesRecord.speed);
  return {
    id: record.id,
    provider: record.provider,
    model: record.model,
    displayName:
      typeof record.displayName === "string" ? record.displayName : record.model,
    available: record.available !== false,
    capabilities: {
      ...(reasoning ? { reasoning } : {}),
      ...(temperature ? { temperature } : {}),
      ...(speed ? { speed } : {}),
    },
  };
}
