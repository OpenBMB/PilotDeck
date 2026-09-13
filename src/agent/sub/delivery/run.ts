import { createHash } from 'node:crypto';
import path from 'node:path';

import type { CanonicalMessage, CanonicalUsage } from '../../../model/index.js';
import { messageContent } from '../../../model/protocol/clone.js';
import { countTokens } from '../../../context/budget/tokenizer.js';
import type { AgentLoopRunResult } from '../../loop/AgentLoop.js';
import { checkDelivery, hasDeliveryContent, parseDelivery } from './checks.js';
import { MAX_DELIVERY_RECORD_BYTES, saveDelivery, serializeDeliveryRecord } from './store.js';
import { buildReviewPacket } from './packet.js';
import { DELIVERY_REVIEW_INSTRUCTION, type DeliveryReviewer } from './reviewer.js';
import type { DeliveryAttempt, DeliveryChecks, DeliveryContract, DeliveryIssue, DeliveryResult, DeliveryReview, DeliveryRuntimeConfig } from './types.js';

export type DeliveryRunOptions = {
  cwd: string;
  subagentId: string;
  task: string;
  config: DeliveryRuntimeConfig;
  contract: DeliveryContract;
  initialMessages: CanonicalMessage[];
  mainModel: { provider: string; model: string };
  maxTurns?: number;
  signal?: AbortSignal;
  reviewer?: DeliveryReviewer;
  execute(messages: CanonicalMessage[], maxTurns: number, attempt: number): Promise<AgentLoopRunResult>;
};

/** Orchestrates deliveries on the caller's existing child loop; never spawns another producer. */
export async function runDelivery(options: DeliveryRunOptions): Promise<{ text: string; usage: CanonicalUsage; turns: number; delivery: DeliveryResult }> {
  const { config, contract } = options;
  if (!Number.isSafeInteger(config.maxRepairs) || config.maxRepairs < 0 || config.maxRepairs > 5) throw new Error('Invalid delivery repair budget.');
  const totalCap = Math.min(config.maxTurns, options.maxTurns ?? config.maxTurns);
  if (!Number.isSafeInteger(totalCap) || totalCap < 1 || totalCap > 100) throw new Error('Invalid delivery turn budget.');
  const attempts: DeliveryAttempt[] = [];
  let messages = options.initialMessages;
  let producerUsage: CanonicalUsage | undefined;
  let reviewUsage: CanonicalUsage | undefined;
  let turns = 0;
  let reviews = 0;
  let text = '';
  let status: DeliveryResult['status'] = 'skipped';
  let deliveryFile = '';

  for (let attempt = 1; attempt <= config.maxRepairs + 1; attempt++) {
    options.signal?.throwIfAborted();
    const last = await options.execute(messages, totalCap - turns, attempt);
    options.signal?.throwIfAborted();
    if (last.result.type === 'aborted' || last.result.type === 'error') {
      const detail = last.result.errors?.map(error => error.message).join("; ");
      throw new Error(`Subtask execution ${last.result.type}: ${last.result.stopReason}${detail ? ` (${detail})` : ""}`);
    }
    turns += last.result.turns;
    producerUsage = addUsage(producerUsage, last.result.usage);
    const rawText = finalText(last.messages);
    const parsed = last.result.structuredOutput !== undefined
      ? { value: last.result.structuredOutput }
      : parseDelivery(rawText);
    const value = parsed.value;
    const content = hasDeliveryContent(value) || Boolean(parsed.rawText?.trim());
    let checks: DeliveryChecks;
    if (last.result.type === 'max_turns') {
      checks = { status: 'error', checked: 0, issues: [{ path: '$', code: 'turn_limit', message: 'The child turn budget ended before a final delivery.' }] };
    } else if (parsed.issue) {
      checks = { status: 'failed', checked: 0, issues: [parsed.issue] };
    } else if (parsed.rawText !== undefined) {
      checks = { status: 'skipped', checked: 0, issues: [], reason: 'Unstructured text retained; no applicable field checks.' };
    } else {
      checks = await checkDelivery(value, { cwd: options.cwd, schema: contract.schema, signal: options.signal });
    }
    const draft: Record<string, unknown> = {
      content: value ?? null,
      ...(parsed.rawText !== undefined ? { raw_text: parsed.rawText } : {}),
      ...(parsed.issue ? { raw_text: rawText } : {}),
      checks,
      meta: { subagentId: options.subagentId, attempt, producerUsage: last.result.usage },
    };
    // An oversized delivery must degrade into a persisted, bounded failure
    // receipt (original byte count/hash + short preview, explicit issue,
    // failed status, repairable) — never a save-time throw and never a
    // silently truncated pass.
    const bounded = boundRecordForArchive(draft, predictedArchiveFile(options, attempt));
    checks = bounded.checks;
    let record = bounded.record;
    deliveryFile = await persistDeliveryRecord(options, attempt, record);
    checks = record.checks as DeliveryChecks;
    let review: DeliveryReview | undefined;
    if (checks.status !== 'failed' && checks.status !== 'error' && contract.review === true && content) {
      if (!options.reviewer) {
        review = { status: 'error', summary: 'No model reviewer is available in this runtime.', issues: [{ path: '$', code: 'review_unavailable', message: 'The requested model review could not run.' }], durationMs: 0 };
      } else if (turns >= totalCap) {
        // The producer legitimately finished with a valid delivery but used up
        // the shared turn budget: the requested review is inconclusive, not an
        // execution error and not an unreviewed pass.
        review = { status: 'inconclusive', summary: 'No turns remain for the requested model review.', issues: [{ path: '$', code: 'turn_limit', message: 'The shared turn budget is exhausted.' }], durationMs: 0 };
      } else {
        const packet = await buildReviewPacket({ task: options.task, schema: contract.schema, value, rawText: parsed.rawText,
          cwd: options.cwd, maxInputTokens: Math.max(1, config.maxReviewInputTokens - countTokens(DELIVERY_REVIEW_INSTRUCTION) - 16), signal: options.signal });
        try {
          review = await options.reviewer({ packet, model: config.reviewerModel ?? options.mainModel,
            maxInputTokens: config.maxReviewInputTokens, maxOutputTokens: config.maxReviewOutputTokens,
            timeoutMs: config.reviewTimeoutMs, signal: options.signal });
        } catch (error) {
          options.signal?.throwIfAborted();
          review = { status: 'error', summary: 'Model review failed.', issues: [{ path: '$', code: 'review_error', message: error instanceof Error ? error.message.slice(0, 500) : 'Reviewer failed.' }], durationMs: 0 };
        }
        if (packet.complete && packet.hasContent) {
          turns++;
          reviews++;
          reviewUsage = addUsage(reviewUsage, review.usage ?? {});
        }
      }
    } else if (contract.review === true) {
      review = { status: 'skipped', summary: content ? 'Program checks did not pass; model review was not run.' : 'No meaningful result was supplied for model review.', issues: [], durationMs: 0 };
    }
    if (review) {
      record.review = review;
      record = boundRecordForArchive(record, predictedArchiveFile(options, attempt)).record;
      await persistDeliveryRecord(options, attempt, record);
      checks = record.checks as DeliveryChecks;
    }
    options.signal?.throwIfAborted();
    attempts.push({ attempt, deliveryFile, checks, ...(review ? { review } : {}) });
    text = summarize(value, parsed.rawText ?? rawText);
    status = outcome(checks, review);
    const issues = checks.status === 'failed' ? checks.issues : review?.status === 'rejected' ? review.issues : [];
    if (status !== 'failed' || issues.length === 0 || attempt > config.maxRepairs || turns >= totalCap) break;
    messages = [...last.messages, { role: 'user', content: [{ type: 'text', text:
      `The submitted delivery has these problems. Fix the relevant result in this same task and submit a new delivery. Do not change the assigned goal or invent evidence.\n${JSON.stringify(issues).slice(0, 6000)}` }] }];
  }

  return {
    text, turns, usage: reviews ? addUsage(producerUsage, reviewUsage ?? {}) : producerUsage ?? {},
    delivery: { status, deliveryFile, attempts, repairs: Math.max(0, attempts.length - 1), producerUsage: producerUsage ?? {}, reviewUsage: reviewUsage ?? {} },
  };
}

function outcome(checks: DeliveryChecks, review?: DeliveryReview): DeliveryResult['status'] {
  if (checks.status === 'error' || review?.status === 'error') return 'error';
  if (checks.status === 'failed' || review?.status === 'rejected') return 'failed';
  if (review?.status === 'inconclusive') return 'inconclusive';
  if (review?.status === 'accepted' || checks.status === 'passed') return 'passed';
  return 'skipped';
}

// ---------------------------------------------------------------------------
// Bounded failure receipts (the 1 MiB archive cap itself stays in store.ts)
// ---------------------------------------------------------------------------

/** Slack for realpath drift between the predicted and actual archive path. */
const ARCHIVE_HEADROOM_BYTES = 1024;
const RECEIPT_PREVIEW_CHARS = 512;
const MAX_RECORD_ISSUES = 200;
const MAX_RECORD_ISSUE_CHARS = 512;

function predictedArchiveFile(options: DeliveryRunOptions, attempt: number): string {
  return path.join(options.cwd, '.pilotdeck', 'deliveries', options.subagentId, `attempt-${attempt}.json`);
}

function recordFits(record: Record<string, unknown>, archiveFile: string): boolean {
  try {
    const bytes = Buffer.byteLength(serializeDeliveryRecord(record, archiveFile), 'utf8');
    return bytes + ARCHIVE_HEADROOM_BYTES <= MAX_DELIVERY_RECORD_BYTES;
  } catch {
    return false;
  }
}

/** Compact serialization that always yields a bounded string. */
function receiptSource(value: unknown): string {
  try {
    return JSON.stringify(value) ?? 'null';
  } catch {
    return '"[unserializable delivery content]"';
  }
}

/**
 * Omission stub for oversized content: original byte count, hash and a short
 * preview. Private detail stays bounded (preview cap), the payload itself is
 * never persisted.
 */
function archiveReceipt(source: string, reason: string): Record<string, unknown> {
  return {
    omitted: true,
    reason,
    byte_count: Buffer.byteLength(source, 'utf8'),
    sha256: createHash('sha256').update(source).digest('hex'),
    preview: source.length > RECEIPT_PREVIEW_CHARS ? `${source.slice(0, RECEIPT_PREVIEW_CHARS)}…` : source,
  };
}

/**
 * Guarantees the archived record fits the storage cap. On overflow, oversized
 * payload fields become bounded receipts and pathological issue lists are
 * capped; the checks flip to an explicit `failed` with a `record_too_large`
 * issue so an omitted payload is never reported as passed/reviewed/skipped.
 */
function boundRecordForArchive(
  draft: Record<string, unknown>,
  archiveFile: string,
): { record: Record<string, unknown>; checks: DeliveryChecks } {
  const checks = (draft.checks ?? { status: 'skipped', checked: 0, issues: [] }) as DeliveryChecks;
  if (recordFits(draft, archiveFile)) return { record: draft, checks };

  const record: Record<string, unknown> = { ...draft };
  const omitted: string[] = [];
  if (record.content !== undefined && record.content !== null) {
    const source = receiptSource(record.content);
    record.content = archiveReceipt(source, 'delivery content exceeded the archive record limit');
    omitted.push(`content (${Buffer.byteLength(source, 'utf8')} bytes)`);
  }
  if (typeof record.raw_text === 'string') {
    const source = record.raw_text;
    record.raw_text = archiveReceipt(source, 'raw delivery text exceeded the archive record limit');
    omitted.push(`raw_text (${Buffer.byteLength(source, 'utf8')} bytes)`);
  }
  const issues = (checks.issues ?? []).slice(0, MAX_RECORD_ISSUES).map(issue => ({
    ...issue,
    message: issue.message.length > MAX_RECORD_ISSUE_CHARS ? `${issue.message.slice(0, MAX_RECORD_ISSUE_CHARS)}…` : issue.message,
  }));
  if ((checks.issues?.length ?? 0) > MAX_RECORD_ISSUES) {
    issues.push({ path: '$', code: 'issues_capped', message: `Only the first ${MAX_RECORD_ISSUES} issues were retained in the archived receipt.` });
  }
  const detail = omitted.length > 0
    ? `${omitted.join(' and ')} ${omitted.length === 1 ? 'was' : 'were'} replaced by a bounded receipt`
    : 'oversized issue details were capped';
  const archivalIssue: DeliveryIssue = {
    path: '$',
    code: 'record_too_large',
    message: `The delivery record exceeded the ${MAX_DELIVERY_RECORD_BYTES}-byte archive limit; ${detail}. The delivery is recorded as a failure receipt, not a pass.`,
  };
  const boundedChecks: DeliveryChecks = {
    ...checks,
    status: checks.status === 'error' ? 'error' : 'failed',
    issues: [...issues, archivalIssue],
  };
  record.checks = boundedChecks;
  return { record, checks: boundedChecks };
}

/**
 * Last-resort receipt if a bounded record still fails to save with a size
 * error (pathological inputs): a minimal, always-fitting failure record.
 * Other persistence failures (unsafe ids, filesystem errors) still throw.
 */
function minimalFailureRecord(record: Record<string, unknown>): Record<string, unknown> {
  const review = record.review as DeliveryReview | undefined;
  return {
    content: null,
    checks: {
      status: 'failed',
      checked: 0,
      issues: [{ path: '$', code: 'record_too_large', message: `The delivery record exceeded the ${MAX_DELIVERY_RECORD_BYTES}-byte archive limit; only this failure receipt was stored.` }],
    },
    ...(review !== undefined ? { review: { status: review.status, summary: String(review.summary ?? '').slice(0, MAX_RECORD_ISSUE_CHARS), issues: [], durationMs: review.durationMs ?? 0 } } : {}),
    ...(record.meta !== undefined ? { meta: record.meta } : {}),
  };
}

async function persistDeliveryRecord(options: DeliveryRunOptions, attempt: number, record: Record<string, unknown>): Promise<string> {
  try {
    return await saveDelivery({ cwd: options.cwd, subagentId: options.subagentId, attempt, record });
  } catch (error) {
    if (!(error instanceof Error) || !error.message.includes('storage limit')) throw error;
    const fallback = minimalFailureRecord(record);
    const file = await saveDelivery({ cwd: options.cwd, subagentId: options.subagentId, attempt, record: fallback });
    // The parent-visible outcome must match the failure receipt actually saved.
    for (const key of Object.keys(record)) delete record[key];
    Object.assign(record, fallback);
    return file;
  }
}
function finalText(messages: CanonicalMessage[]): string {
  const last = [...messages].reverse().find(message => message.role === 'assistant');
  return last ? messageContent(last).filter(part => part.type === 'text').map(part => part.text).join('\n').trim() : '';
}
function summarize(value: unknown, fallback: string): string {
  const record = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
  const source = typeof record?.summary === 'string' ? record.summary : fallback || 'Structured delivery recorded.';
  return source.length > 2048 ? `${source.slice(0, 2048)}\n[Full result is in the delivery file.]` : source;
}
/** Missing counters remain unknown when aggregating multiple actual calls. */
function addUsage(a: CanonicalUsage | undefined, b: CanonicalUsage): CanonicalUsage {
  if (a === undefined) return { ...b };
  const result: CanonicalUsage = {};
  for (const key of ['inputTokens', 'outputTokens', 'totalTokens', 'cacheReadTokens', 'cacheWriteTokens', 'nativeCost'] as const) {
    if (typeof a[key] === 'number' && typeof b[key] === 'number') result[key] = a[key]! + b[key]!;
  }
  return result;
}
