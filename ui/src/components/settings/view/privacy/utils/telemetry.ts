import { parse as parseYaml, stringify as stringifyYaml } from "yaml";

export function readTelemetryEnabled(raw: string): boolean {
  try {
    const config = parseYaml(raw);
    if (!config || typeof config !== "object" || Array.isArray(config)) {
      return false;
    }
    const telemetry = (config as Record<string, unknown>).telemetry;
    if (!telemetry || typeof telemetry !== "object" || Array.isArray(telemetry)) {
      return false;
    }
    return (telemetry as Record<string, unknown>).enabled === true;
  } catch {
    return false;
  }
}

export function setTelemetryEnabled(raw: string, enabled: boolean): string | null {
  try {
    const parsed = parseYaml(raw);
    const config =
      parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? (parsed as Record<string, unknown>)
        : {};
    const telemetry =
      config.telemetry &&
      typeof config.telemetry === "object" &&
      !Array.isArray(config.telemetry)
        ? (config.telemetry as Record<string, unknown>)
        : {};
    config.telemetry = { ...telemetry, enabled };
    return stringifyYaml(config, { indent: 2, lineWidth: 0 });
  } catch {
    return null;
  }
}
