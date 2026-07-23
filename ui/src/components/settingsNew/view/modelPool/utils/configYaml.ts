import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import type { PilotDeckConfig } from "../types";

export function safeParseYaml(text: string): PilotDeckConfig | null {
  try {
    const value = parseYaml(text);
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as PilotDeckConfig;
    }
    return null;
  } catch {
    return null;
  }
}

export function configToYamlString(config: PilotDeckConfig): string {
  return stringifyYaml(config, { indent: 2, lineWidth: 0 });
}
