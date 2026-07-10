import type { PilotDeckConfig } from "../../modelPool/types";

export function isCronConfigEnabled(config: PilotDeckConfig): boolean {
  return config.cron !== undefined && config.cron.enabled !== false;
}
