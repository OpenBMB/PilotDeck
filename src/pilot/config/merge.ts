import { isRecord } from "../../model/config/schema.js";

export function mergeConfigSources(...configs: unknown[]): Record<string, unknown> {
  let output: Record<string, unknown> = {};

  for (const config of configs) {
    if (config === undefined) {
      continue;
    }
    if (!isRecord(config)) {
      output = {};
      continue;
    }
    output = deepMerge(output, config);
  }

  return output;
}

function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const output: Record<string, unknown> = { ...base };

  for (const [key, value] of Object.entries(override)) {
    const previous = output[key];
    if (isRecord(previous) && isRecord(value)) {
      output[key] = deepMerge(previous, value);
    } else {
      output[key] = value;
    }
  }

  return output;
}
