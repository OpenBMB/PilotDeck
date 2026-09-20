import type { TokenBudgetManager } from "../budget/TokenBudgetManager.js";
import type { AutoCompactionPolicy } from "./AutoCompactionPolicy.js";
import {
  buildPostCompactMessages,
  type CompactionEngine,
  truncateHeadPreservingCheckpoint,
} from "./CompactionEngine.js";
import type { MicroCompactionEngine } from "./MicroCompactionEngine.js";
import type { SnipEngine } from "./SnipEngine.js";
import type { ContextOverflowRecovery } from "../recovery/ContextOverflowRecovery.js";
import type { CompactionPort } from "./CompactionPort.js";
import {
  createCompactionOrchestrator,
  type CompactionAutomaticTriggerObservation,
} from "./CompactionOrchestrator.js";

export type NativeCompactionPortOptions = {
  tokenBudget?: TokenBudgetManager;
  autoCompactionPolicy?: AutoCompactionPolicy;
  compactionEngine?: CompactionEngine;
  microCompaction?: MicroCompactionEngine;
  snipEngine?: SnipEngine;
  overflowRecovery?: ContextOverflowRecovery;
  maxContextTokens?: number;
  log?: (stage: string, context: { sessionId?: string; turnId?: string }, details: Record<string, unknown>) => void;
  onAutomaticTrigger?: (observation: CompactionAutomaticTriggerObservation) => void;
};

/** Native provider adapter for the existing PilotDeck compaction algorithms. */
export function createNativeCompactionPort(options: NativeCompactionPortOptions): CompactionPort | undefined {
  const tokenBudget = options.tokenBudget;
  const policy = options.autoCompactionPolicy;
  const summary = options.compactionEngine;
  const micro = options.microCompaction;
  const snip = options.snipEngine;
  const recovery = options.overflowRecovery;
  if (!tokenBudget && !policy && !summary && !micro && !snip && !recovery) return undefined;

  const port: CompactionPort = {
    ...(tokenBudget
      ? {
          budget: {
            evaluate: (messages, maxContextTokens, evaluateOptions) =>
              tokenBudget.evaluate(messages, maxContextTokens, evaluateOptions),
            estimateMessagesTokens: (messages) => tokenBudget.estimateMessagesTokens(messages),
          },
        }
      : {}),
    ...(policy ? { policy } : {}),
    ...(summary ? { summary } : {}),
    ...(micro ? { micro } : {}),
    ...(snip ? { snip } : {}),
    ...(recovery ? { recovery } : {}),
    buildPostCompactMessages,
    truncateHeadPreservingCheckpoint,
  };
  port.autoCompact = createCompactionOrchestrator(port, {
    maxContextTokens: options.maxContextTokens ?? 8192,
    log: options.log,
    onAutomaticTrigger: options.onAutomaticTrigger,
  });
  return port;
}
