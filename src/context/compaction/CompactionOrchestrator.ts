import type { CanonicalMessage } from "../../model/index.js";
import type { CanonicalModelRequest } from "../../model/index.js";
import type { ContextDiagnostic } from "../protocol/types.js";
import type { TokenBudgetSnapshot } from "../budget/TokenBudgetManager.js";
import type { TokenCalibrationBaseline } from "../budget/TokenAccountingRuntime.js";
import type { CompactionPort, AutoCompactResult, CompactionAutoCompactInput } from "./CompactionPort.js";
import { ensureTrailingUserMessage } from "./toolPairIntegrity.js";
import type { CompactionResult } from "./CompactionEngine.js";
import type { AutoCompactionDecision } from "./AutoCompactionPolicy.js";

const POST_COMPACTION_TARGET_RATIO = 0.60;
const EMERGENCY_KEEP_TAIL_RATIO = 0.05;
const EMERGENCY_SUMMARY_MAX_OUTPUT_TOKENS = 1_536;
const EMERGENCY_TOOL_RESULT_TOKENS = 256;
const EMERGENCY_HEAD_KEEP_RATIO = 0.10;

export type CompactionOrchestratorOptions = {
  maxContextTokens: number;
  onSurfaceChanged?: () => void;
  log?: (stage: string, context: { sessionId?: string; turnId?: string }, details: Record<string, unknown>) => void;
  /** Read-only instrumentation for the automatic policy trigger. */
  onAutomaticTrigger?: (observation: CompactionAutomaticTriggerObservation) => void;
};

export type CompactionAutomaticTriggerObservation = {
  input: CompactionAutoCompactInput;
  snapshot: TokenBudgetSnapshot;
  decision: AutoCompactionDecision;
  budgetEvaluations: readonly CompactionBudgetEvaluation[];
  fullSummaryStarted: boolean;
  summaryMessages?: CanonicalMessage[];
  summaryPreTokens?: number;
  summaryLocalEstimateTokens?: number;
  summaryAccountingEstimateTokens?: number;
};

export type CompactionBudgetEvaluation = {
  messages: CanonicalMessage[];
  snapshot: TokenBudgetSnapshot;
  /** Present for native AgentLoop accounting; not consumed by Context policy. */
  request?: CanonicalModelRequest;
  maxContextTokens?: number;
  reservedOutputTokens?: number;
  calibration?: TokenCalibrationBaseline;
};

/**
 * Compose the complete native compaction policy from independent stage
 * capabilities. The caller owns the provider; this function only evaluates
 * and returns a candidate surface. It never mutates the durable transcript.
 */
export function createCompactionOrchestrator(
  port: CompactionPort,
  options: CompactionOrchestratorOptions,
): (input: CompactionAutoCompactInput) => Promise<AutoCompactResult> {
  return (input) => runCompaction(port, input, options);
}

/** Complete a stage-only provider with the shared auto-compaction consumer. */
export function withCompactionOrchestrator(
  port: CompactionPort,
  options: CompactionOrchestratorOptions,
): CompactionPort {
  if (port.autoCompact) return port;
  return { ...port, autoCompact: createCompactionOrchestrator(port, options) };
}

async function runCompaction(
  port: CompactionPort,
  input: CompactionAutoCompactInput,
  options: CompactionOrchestratorOptions,
): Promise<AutoCompactResult> {
  const sessionId = input.sessionId ?? "";
  const turnId = input.turnId ?? "";
  const log = (stage: string, details: Record<string, unknown> = {}): void => {
    options.log?.(stage, { sessionId, turnId }, details);
  };
  const maxContextTokens = input.maxContextTokens ?? options.maxContextTokens;
  const manualForce = input.trigger === "manual" && input.manualForce === true;
  if (!port.budget || (!manualForce && !port.policy)) {
    log("disabled", {
      hasAutoCompactionPolicy: Boolean(port.policy),
      hasTokenBudget: Boolean(port.budget),
      manualForce,
      maxContextTokens,
    });
    return { type: "skipped", snapshot: emptySnapshot(maxContextTokens) };
  }

  const budgetEvaluations: CompactionBudgetEvaluation[] = [];
  let triggerObservation: CompactionAutomaticTriggerObservation | undefined;
  const evaluateBudget = async (messages: CanonicalMessage[]): Promise<TokenBudgetSnapshot> => {
    const snapshot = await (input.budgetEvaluator
      ? input.budgetEvaluator(messages)
      : Promise.resolve(port.budget!.evaluate(messages, maxContextTokens, {
          reservedOutputTokens: input.reservedOutputTokens,
        })));
    const observation = input.budgetEvaluator?.getLastObservation?.();
    budgetEvaluations.push({
      messages: structuredClone(messages),
      snapshot: structuredClone(snapshot),
      ...(observation
        ? {
            request: structuredClone(observation.request),
            maxContextTokens: observation.maxContextTokens,
            reservedOutputTokens: observation.reservedOutputTokens,
            ...(observation.calibration ? { calibration: structuredClone(observation.calibration) } : {}),
          }
        : {}),
    });
    return snapshot;
  };
  let messages = input.messages;
  const initialSnapshot = await evaluateBudget(messages);
  let currentSnapshot = initialSnapshot;
  if (manualForce) {
    if (!port.summary) {
      log("manual_compaction_unavailable", { snapshot: describeSnapshot(initialSnapshot) });
      return { type: "skipped", snapshot: initialSnapshot };
    }
    log("manual_force", {
      snapshot: describeSnapshot(initialSnapshot),
      messages: messages.length,
      reservedOutputTokens: input.reservedOutputTokens,
    });
  } else {
    const decision = port.policy!.evaluateSnapshot(initialSnapshot);
    if (decision.type !== "trigger") {
      log("policy_skip", { decisionType: decision.type, snapshot: describeSnapshot(decision.snapshot) });
      return { type: "skipped", snapshot: decision.snapshot };
    }
    try {
      triggerObservation = {
        input: { ...input, messages: structuredClone(input.messages) },
        snapshot: initialSnapshot,
        decision,
        budgetEvaluations,
        fullSummaryStarted: false,
      };
      options.onAutomaticTrigger?.(triggerObservation);
    } catch {
      // Observation must not influence Context compaction.
    }
    log("policy_trigger", {
      reason: decision.reason,
      snapshot: describeSnapshot(initialSnapshot),
      messages: messages.length,
      reservedOutputTokens: input.reservedOutputTokens,
    });
  }

  if (!manualForce && port.micro) {
    const micro = port.micro.apply({ messages, trimToTokens: 768 });
    messages = micro.messages;
    const microSnapshot = await evaluateBudget(messages);
    currentSnapshot = microSnapshot;
    log("pre_summary_prune", {
      rewritten: micro.rewritten,
      rewrittenBytes: micro.rewrittenBytes,
      snapshot: describeSnapshot(microSnapshot),
    });
    if (microSnapshot.ratio < 0.90) {
      if (micro.rewritten === 0) return { type: "skipped", snapshot: microSnapshot };
      options.onSurfaceChanged?.();
      return {
        type: "compacted",
        messages: ensureTrailingUserMessage(messages),
        tier: "micro",
        snapshot: microSnapshot,
      };
    }
  }

  if (!manualForce && currentSnapshot.ratio < 0.90) {
    return { type: "skipped", snapshot: currentSnapshot };
  }
  if (!port.summary) {
    log("full_compaction_unavailable", { snapshot: describeSnapshot(currentSnapshot) });
    return { type: "skipped", snapshot: currentSnapshot };
  }

  log("full_compaction_started", {
    messages: messages.length,
    snapshot: describeSnapshot(currentSnapshot),
  });
  const effectiveContextTokens = Math.max(
    1,
    Math.floor(currentSnapshot.effectiveContextTokens ?? currentSnapshot.maxContextTokens),
  );
  const targetPostTokens = Math.max(1, Math.floor(effectiveContextTokens * POST_COMPACTION_TARGET_RATIO));
  if (triggerObservation) {
    triggerObservation.fullSummaryStarted = true;
    triggerObservation.summaryMessages = structuredClone(messages);
  }
  const result = await port.summary.run({
    trigger: manualForce ? "manual" : "auto",
    messages,
    effectiveContextTokens,
    targetPostTokens,
    signal: input.abortSignal,
    sessionId,
    turnId,
  });
  const summarySucceeded = compactionSummarySucceeded(result);
  if (result.error) log("full_compaction_no_summary", { error: result.error, preTokens: result.preTokens });
  else if (!result.summaryMessage) log("full_compaction_no_summary", { reason: "no_summarizable_live_turns", preTokens: result.preTokens });

  let finalResult: CompactionResult | undefined = summarySucceeded ? result : undefined;
  let postMessages = summarySucceeded
    ? ensureTrailingUserMessage(port.buildPostCompactMessages(result))
    : messages;
  let snapshot = await evaluateBudget(postMessages);
  let snipApplied = false;
  if (summarySucceeded && snapshot.ratio > POST_COMPACTION_TARGET_RATIO && port.snip) {
    const messageTokens = port.budget.estimateMessagesTokens(postMessages);
    const nonMessageTokens = Math.max(0, snapshot.tokens - messageTokens);
    const messageTarget = Math.max(1, targetPostTokens - nonMessageTokens);
    const snipTargetTokens = Math.min(messageTokens, messageTarget);
    const snip = port.snip.snip(postMessages, { targetTotalTokens: snipTargetTokens });
    postMessages = snip.messages;
    snapshot = await evaluateBudget(postMessages);
    snipApplied = snip.applied;
    log("post_summary_snip", {
      applied: snip.applied,
      turnsSnipped: snip.turnsSnipped,
      targetPostTokens,
      snipTargetTokens,
      snapshot: describeSnapshot(snapshot),
    });
  }

  let emergencyApplied = false;
  if (snapshot.ratio >= 0.90) {
    const emergency = await runEmergencyCompaction(port, {
      messages: postMessages,
      input,
      evaluateBudget,
      effectiveContextTokens,
      targetPostTokens,
      sessionId,
      turnId,
      log,
    });
    if (emergency) {
      emergencyApplied = emergency.changed;
      finalResult = emergency.result ?? finalResult;
      postMessages = emergency.messages;
      snapshot = emergency.snapshot;
      if (emergency.diagnostics && finalResult) finalResult.diagnostics.push(...emergency.diagnostics);
    }
  }

  const overflowAfterEmergency = snapshot.ratio >= 1;
  if (!summarySucceeded && !snipApplied && !emergencyApplied && !overflowAfterEmergency) {
    log("full_compaction_skipped", {
      reason: "no_effective_change",
      targetPostTokens,
      snapshot: describeSnapshot(currentSnapshot),
    });
    return { type: "skipped", snapshot: currentSnapshot };
  }
  if (snapshot.ratio > POST_COMPACTION_TARGET_RATIO && finalResult) {
    finalResult.diagnostics.push({
      code: "compaction_target_not_reached",
      severity: "warning",
      message: `Compaction remained above the ${Math.round(POST_COMPACTION_TARGET_RATIO * 100)}% target `
        + `(tokens=${snapshot.tokens}, target=${targetPostTokens}, ratio=${snapshot.ratio.toFixed(3)}). `
        + "Protected checkpoints, tool turns, or the required recent tail may account for the remainder.",
    });
  }
  log("full_compaction_completed", {
    snapshot: describeSnapshot(snapshot),
    summarySucceeded: finalResult ? compactionSummarySucceeded(finalResult) : false,
    summaryGenerated: finalResult?.summaryGenerated === true,
    checkpointMerged: finalResult?.checkpointMerged === true,
    targetPostTokens,
    preTokens: finalResult?.preTokens ?? result.preTokens,
    postTokens: finalResult?.postTokens,
  });
  if (summarySucceeded || snipApplied || emergencyApplied) options.onSurfaceChanged?.();
  const output: AutoCompactResult = {
    type: "compacted",
    messages: postMessages,
    tier: snapshot.ratio >= 0.90 ? "emergency" : "full",
    snapshot,
    ...(finalResult ? { result: finalResult } : {}),
    ...(overflowAfterEmergency ? { error: "context_overflow_after_emergency_compaction" as const } : {}),
  };
  if (overflowAfterEmergency) {
    const diagnostic: ContextDiagnostic = {
      code: "context_overflow_after_emergency_compaction",
      severity: "error",
      message: `Context remains over the effective input budget after emergency compaction `
        + `(tokens=${snapshot.tokens}, max=${snapshot.maxContextTokens}, ratio=${snapshot.ratio.toFixed(3)}). `
        + "The stable checkpoint, current request, tool protocol, and required tail are the remaining sources.",
    };
    finalResult?.diagnostics.push(diagnostic);
    log("context_overflow_after_emergency_compaction", { snapshot: describeSnapshot(snapshot), diagnostic: diagnostic.message });
  }
  return output;
}

async function runEmergencyCompaction(
  port: CompactionPort,
  options: {
    messages: CanonicalMessage[];
    input: { abortSignal?: AbortSignal };
    evaluateBudget: (messages: CanonicalMessage[]) => Promise<TokenBudgetSnapshot>;
    effectiveContextTokens: number;
    targetPostTokens: number;
    sessionId: string;
    turnId: string;
    log: (stage: string, details?: Record<string, unknown>) => void;
  },
): Promise<{
  messages: CanonicalMessage[];
  snapshot: TokenBudgetSnapshot;
  changed: boolean;
  result?: CompactionResult;
  diagnostics?: ContextDiagnostic[];
} | undefined> {
  let messages = options.messages;
  let snapshot = await options.evaluateBudget(messages);
  let changed = false;
  let emergencyResult: CompactionResult | undefined;
  if (snapshot.ratio < 0.90) return { messages, snapshot, changed };
  if (port.summary) {
    emergencyResult = await port.summary.run({
      trigger: "reactive",
      messages,
      keepTailRatio: EMERGENCY_KEEP_TAIL_RATIO,
      effectiveContextTokens: options.effectiveContextTokens,
      targetPostTokens: options.targetPostTokens,
      protectedToolNames: null,
      maxOutputTokens: EMERGENCY_SUMMARY_MAX_OUTPUT_TOKENS,
      cacheReset: true,
      signal: options.input.abortSignal,
      sessionId: options.sessionId,
      turnId: options.turnId,
    });
    if (emergencyResult.summaryMessage && emergencyResult.error === undefined) {
      messages = ensureTrailingUserMessage(port.buildPostCompactMessages({
        ...emergencyResult,
        cacheReset: true,
        stablePrefix: [],
      }));
      changed = true;
      snapshot = await options.evaluateBudget(messages);
      options.log("emergency_summary", { snapshot: describeSnapshot(snapshot), cacheReset: true });
      if (snapshot.ratio < 0.90) return { messages, snapshot, changed, result: emergencyResult };
    }
  }
  const persistedEmergencyResult = emergencyResult?.summaryMessage && emergencyResult.error === undefined
    ? emergencyResult
    : undefined;
  if (port.micro) {
    const projected = port.micro.apply({
      messages,
      trimToTokens: EMERGENCY_TOOL_RESULT_TOKENS,
      keepLatest: 1,
      protectedToolNames: null,
    });
    messages = projected.messages;
    changed ||= projected.rewritten > 0;
    snapshot = await options.evaluateBudget(messages);
    options.log("emergency_tool_projection", { rewritten: projected.rewritten, snapshot: describeSnapshot(snapshot) });
    if (snapshot.ratio < 0.90) return { messages, snapshot, changed, result: persistedEmergencyResult };
  }
  const truncated = port.truncateHeadPreservingCheckpoint(messages, EMERGENCY_HEAD_KEEP_RATIO);
  changed ||= !sameMessageSequence(messages, truncated);
  messages = truncated;
  snapshot = await options.evaluateBudget(messages);
  const diagnostics: ContextDiagnostic[] = [{
    code: "context_hard_truncate",
    severity: "error",
    message: `Emergency head truncation kept approximately ${Math.round(EMERGENCY_HEAD_KEEP_RATIO * 100)}% `
      + `of the live history (tokens=${snapshot.tokens}, max=${snapshot.maxContextTokens}). `
      + "Earlier live turns may be unavailable outside the durable transcript.",
  }];
  options.log("emergency_head_truncate", { snapshot: describeSnapshot(snapshot), keepRatio: EMERGENCY_HEAD_KEEP_RATIO });
  return { messages, snapshot, changed, result: persistedEmergencyResult, diagnostics };
}

function emptySnapshot(maxContextTokens: number): TokenBudgetSnapshot {
  return { tokens: 0, maxContextTokens, warningRatio: 0, blockingRatio: 0, state: "ok", ratio: 0 };
}

function sameMessageSequence(left: CanonicalMessage[], right: CanonicalMessage[]): boolean {
  return left.length === right.length && left.every((message, index) => message === right[index]);
}

function describeSnapshot(snapshot: TokenBudgetSnapshot): Record<string, unknown> {
  return {
    tokens: snapshot.tokens,
    displayTokens: snapshot.displayTokens,
    estimateSource: snapshot.estimateSource,
    usageTokens: snapshot.usageTokens,
    localEstimateTokens: snapshot.localEstimateTokens,
    calibrationActualInputTokens: snapshot.calibrationActualInputTokens,
    calibrationEstimatedInputTokens: snapshot.calibrationEstimatedInputTokens,
    totalContextTokens: snapshot.totalContextTokens,
    maxContextTokens: snapshot.maxContextTokens,
    effectiveContextTokens: snapshot.effectiveContextTokens,
    maxOutputTokens: snapshot.maxOutputTokens,
    warningRatio: snapshot.warningRatio,
    blockingRatio: snapshot.blockingRatio,
    state: snapshot.state,
    ratio: snapshot.ratio,
    source: snapshot.source,
    exact: snapshot.exact,
    reservedOutputTokens: snapshot.reservedOutputTokens,
  };
}

function compactionSummarySucceeded(result: CompactionResult): boolean {
  return result.error === undefined && result.summaryMessage !== undefined;
}
