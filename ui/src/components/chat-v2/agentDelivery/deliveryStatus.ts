/**
 * Parsing helpers for the parent Agent tool's structured output.
 *
 * The parent `agent`/`task` tool result carries (via the bridge's
 * `toolUseResult`) the gateway-sanitized `AgentToolOutput`:
 *
 *   {
 *     subagentType, description, text, usage, turns, durationMs,
 *     delivery_file: "<workspace path>",
 *     delivery: {                       // DeliveryResult, see
 *       status,                         // 'passed'|'failed'|'skipped'|'inconclusive'|'error'
 *       deliveryFile, attempts, repairs, producerUsage, reviewUsage
 *     }
 *   }
 *
 * Every field is parsed defensively: partial or gateway-truncated payloads
 * must never fabricate an acceptance. `skipped`/`inconclusive` are kept
 * distinct from `passed` at the view layer.
 */

export const DELIVERY_STATUSES = ['passed', 'failed', 'skipped', 'inconclusive', 'error'] as const;
export const DELIVERY_CHECK_STATUSES = ['passed', 'failed', 'skipped', 'error'] as const;
export const DELIVERY_REVIEW_STATUSES = ['accepted', 'rejected', 'inconclusive', 'error', 'skipped'] as const;

export type DeliveryStatus = (typeof DELIVERY_STATUSES)[number];
export type DeliveryCheckStatus = (typeof DELIVERY_CHECK_STATUSES)[number];
export type DeliveryReviewStatus = (typeof DELIVERY_REVIEW_STATUSES)[number];

export type DeliveryIssueView = {
  path: string;
  code: string;
  message: string;
};

export type DeliveryChecksView = {
  status: DeliveryCheckStatus | string;
  checked: number;
  issues: DeliveryIssueView[];
  reason?: string;
};

export type DeliveryReviewView = {
  status: DeliveryReviewStatus | string;
  summary: string;
  issues: DeliveryIssueView[];
  modelLabel?: string;
  durationMs?: number;
  /** Reviewer total tokens; absent means unknown, never 0. */
  totalTokens?: number;
};

export type DeliveryAttemptView = {
  attempt: number;
  deliveryFile: string;
  checks: DeliveryChecksView;
  review?: DeliveryReviewView;
};

export type DeliveryResultView = {
  status: DeliveryStatus | string;
  deliveryFile: string;
  attempts: DeliveryAttemptView[];
  repairs: number;
  /** Producer total tokens; absent means unknown, never 0. */
  producerTotalTokens?: number;
};

export type ParsedAgentDelivery = {
  delivery?: DeliveryResultView;
  deliveryFile?: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value : undefined;
}

function parseIssues(value: unknown): DeliveryIssueView[] {
  if (!Array.isArray(value)) return [];
  const issues: DeliveryIssueView[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const path = typeof entry.path === 'string' ? entry.path : '';
    const code = typeof entry.code === 'string' ? entry.code : '';
    const message = typeof entry.message === 'string' ? entry.message : code;
    issues.push({ path, code, message });
  }
  return issues;
}

function parseChecks(value: unknown): DeliveryChecksView {
  const record = isRecord(value) ? value : {};
  return {
    status: typeof record.status === 'string' ? record.status : 'skipped',
    checked: typeof record.checked === 'number' && Number.isFinite(record.checked) ? record.checked : 0,
    issues: parseIssues(record.issues),
    ...(optionalString(record.reason) ? { reason: optionalString(record.reason) } : {}),
  };
}

function parseReview(value: unknown): DeliveryReviewView | undefined {
  if (!isRecord(value)) return undefined;
  const model = isRecord(value.model) ? value.model : undefined;
  const modelLabel = model
    ? [model.provider, model.model].filter((part) => typeof part === 'string' && part.length > 0).join('/')
    : undefined;
  const usage = isRecord(value.usage) ? value.usage : undefined;
  const totalTokens = usage && typeof usage.totalTokens === 'number' && Number.isFinite(usage.totalTokens)
    ? usage.totalTokens
    : undefined;
  return {
    status: typeof value.status === 'string' ? value.status : 'skipped',
    summary: typeof value.summary === 'string' ? value.summary : '',
    issues: parseIssues(value.issues),
    ...(modelLabel ? { modelLabel } : {}),
    ...(typeof value.durationMs === 'number' && Number.isFinite(value.durationMs)
      ? { durationMs: value.durationMs }
      : {}),
    // 'skipped' with a summary means review was requested but not meaningful
    // (L1 failed or empty result); keep the summary so the UI can explain it.
    ...(totalTokens !== undefined ? { totalTokens } : {}),
  };
}

function parseAttempt(value: unknown, fallbackIndex: number): DeliveryAttemptView | undefined {
  if (!isRecord(value)) return undefined;
  const checks = parseChecks(value.checks);
  return {
    attempt: typeof value.attempt === 'number' && Number.isFinite(value.attempt) ? value.attempt : fallbackIndex + 1,
    deliveryFile: typeof value.deliveryFile === 'string' ? value.deliveryFile : '',
    checks,
    ...(parseReview(value.review) ? { review: parseReview(value.review) } : {}),
  };
}

function parseDeliveryResult(value: unknown): DeliveryResultView | undefined {
  if (!isRecord(value)) return undefined;
  const attemptsRaw = Array.isArray(value.attempts) ? value.attempts : [];
  const attempts = attemptsRaw
    .map((entry, index) => parseAttempt(entry, index))
    .filter((entry): entry is DeliveryAttemptView => entry !== undefined);
  const claimed = typeof value.status === 'string' ? value.status : '';
  const producerUsage = isRecord(value.producerUsage) ? value.producerUsage : undefined;
  const producerTotalTokens = producerUsage
    && typeof producerUsage.totalTokens === 'number'
    && Number.isFinite(producerUsage.totalTokens)
    ? producerUsage.totalTokens
    : undefined;
  return {
    // A claimed `passed` without attempts (or an unrecognized status) means a
    // truncated/unknown payload — downgrade to `inconclusive` instead of
    // rendering a green "accepted" state we cannot back with evidence.
    status: claimed === 'passed' && attempts.length === 0
      ? 'inconclusive'
      : (DELIVERY_STATUSES as readonly string[]).includes(claimed) ? claimed : 'inconclusive',
    deliveryFile: typeof value.deliveryFile === 'string' ? value.deliveryFile : '',
    attempts,
    repairs: typeof value.repairs === 'number' && Number.isFinite(value.repairs) ? value.repairs : 0,
    ...(producerTotalTokens !== undefined ? { producerTotalTokens } : {}),
  };
}

/**
 * Extracts the delivery receipt from a chat `toolResult`. Prefers the
 * structured `toolUseResult` (bridge-forwarded gateway `data`); tolerates a
 * JSON-string variant. Returns an empty object when the payload carries no
 * delivery information (e.g. delivery mode off or legacy sessions).
 */
export function parseAgentDelivery(toolResult: unknown): ParsedAgentDelivery {
  if (!isRecord(toolResult)) return {};
  let payload: unknown = toolResult.toolUseResult;
  if (typeof payload === 'string') {
    try {
      payload = JSON.parse(payload);
    } catch {
      payload = undefined;
    }
  }
  if (!isRecord(payload)) return {};
  const delivery = parseDeliveryResult(payload.delivery);
  const deliveryFile = optionalString(payload.delivery_file)
    ?? (delivery?.deliveryFile ? delivery.deliveryFile : undefined);
  if (!delivery && !deliveryFile) return {};
  return {
    ...(delivery ? { delivery } : {}),
    ...(deliveryFile ? { deliveryFile } : {}),
  };
}
