import type { PilotDeckToolResult } from "../protocol/result.js";
import type { PilotDeckToolCall, PilotDeckToolRuntimeContext } from "../protocol/types.js";

export type PilotDeckToolScheduler = {
  executeAll(calls: PilotDeckToolCall[], context: PilotDeckToolRuntimeContext): Promise<PilotDeckToolResult[]>;
};
