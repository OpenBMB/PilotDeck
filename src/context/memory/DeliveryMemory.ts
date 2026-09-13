import { createHash } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import type { EdgeClawMemoryService } from 'edgeclaw-memory-core';
import type { AgentRuntimeDependencies } from '../../agent/runtime/AgentRuntimeDependencies.js';

export const DELIVERY_MEMORY_KEY = 'subtaskDeliveryObservationsV1';
type Observation = Parameters<NonNullable<AgentRuntimeDependencies['deliveryObserver']>>[0];
type StoredAttempt = { checks: string; review?: string; checked: number; issues: { code: string; field: string }[] };
type StoredObservation = { id: string; status: string; repairs: number; attempts: StoredAttempt[] };
const LIMIT = 128;
const MAX_BYTES = 262_144;
const STATES = new Set(['passed', 'failed', 'skipped', 'inconclusive', 'error', 'accepted', 'rejected']);
const CODES = new Set(['type_mismatch', 'outside_workspace', 'invalid_file_field', 'invalid_locations', 'invalid_locator', 'line_order', 'bounds_exceeded', 'locator_unverified', 'malformed_json', 'file_missing', 'file_outside_workspace', 'file_not_regular', 'file_unreadable', 'line_out_of_range', 'invalid_location', 'schema_type', 'invalid_json', 'requirement', 'turn_limit', 'review_timeout', 'review_error', 'review_verdict_invalid']);
const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 24);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const integer = (value: unknown, max: number) => Number.isSafeInteger(value) && Number(value) >= 0 && Number(value) <= max;

/** Read only our owned key strictly; the repository's tolerant reader hides malformed JSON. */
export function readDeliveryMemory(service: EdgeClawMemoryService): StoredObservation[] {
  const db = new DatabaseSync(service.dbPath, { readOnly: true });
  try {
    const row = db.prepare('SELECT state_json FROM pipeline_state WHERE state_key = ?').get(DELIVERY_MEMORY_KEY);
    if (!row) return [];
    const fail = (): never => { throw new Error('Corrupt subtask delivery memory; existing state was preserved.'); };
    if (typeof row.state_json !== 'string' || Buffer.byteLength(row.state_json) > MAX_BYTES) return fail();
    let parsed: unknown;
    try { parsed = JSON.parse(row.state_json); } catch { return fail(); }
    if (!object(parsed) || parsed.version !== 1 || !Array.isArray(parsed.observations) || parsed.observations.length > LIMIT) return fail();
    if (!parsed.observations.every(item => object(item) && /^[a-f0-9]{24}$/.test(String(item.id)) && STATES.has(String(item.status))
      && integer(item.repairs, 5) && Array.isArray(item.attempts) && item.attempts.length <= 6 && item.attempts.every(attempt =>
        object(attempt) && STATES.has(String(attempt.checks)) && (attempt.review === undefined || STATES.has(String(attempt.review)))
        && integer(attempt.checked, 100_000) && Array.isArray(attempt.issues) && attempt.issues.length <= 8 && attempt.issues.every(issue =>
          object(issue) && (issue.code === 'other' || CODES.has(String(issue.code))) && /^[a-f0-9]{24}$/.test(String(issue.field)))))) return fail();
    // Reconstruct the allowed shape: no stale or unexpected fields enter the readable projection.
    return parsed.observations.map(item => ({ id: item.id, status: item.status, repairs: item.repairs,
      attempts: item.attempts.map((attempt: StoredAttempt) => ({ checks: attempt.checks, ...(attempt.review ? { review: attempt.review } : {}),
        checked: attempt.checked, issues: attempt.issues.map(issue => ({ code: issue.code, field: issue.field })) })) }));
  } finally { db.close(); }
}

/** Native feedback, not a new learner: Dream/retrieval consume the existing file-memory interface. */
export function createDeliveryMemoryObserver(service: EdgeClawMemoryService): (event: Observation) => void {
  return event => {
    const observations = readDeliveryMemory(service);
    const item: StoredObservation = {
      id: hash(`${event.sessionId}\0${event.subagentId}`), status: event.result.status,
      repairs: Math.min(5, event.result.repairs),
      attempts: event.result.attempts.slice(0, 6).map(attempt => ({ checks: attempt.checks.status,
        ...(attempt.review ? { review: attempt.review.status } : {}), checked: Math.min(100_000, attempt.checks.checked),
        issues: [...attempt.checks.issues, ...(attempt.review?.issues ?? [])].slice(0, 8).map(issue => ({
          code: CODES.has(issue.code) ? issue.code : 'other', field: hash(issue.path),
        })),
      })),
    };
    const index = observations.findIndex(existing => existing.id === item.id);
    if (index >= 0) observations[index] = item;
    else observations.push(item);
    while (observations.length > LIMIT || Buffer.byteLength(JSON.stringify(observations)) > MAX_BYTES - 128) observations.shift();
    service.repository.setPipelineState(DELIVERY_MEMORY_KEY, { version: 1, observations });
    const counts = Object.fromEntries([...STATES].map(state => [state, observations.filter(row => row.status === state).length]));
    const signatures = new Map<string, number>();
    for (const row of observations) for (const attempt of row.attempts) for (const issue of attempt.issues) {
      const key = `${issue.code} / field ${issue.field}`;
      signatures.set(key, (signatures.get(key) ?? 0) + 1);
    }
    const body = [
      '# Subtask delivery observations',
      'Observed metadata only. These counts are not independently graded task success rates.',
      'Passed means the applicable checks/review passed. Skipped is unverified. File existence does not establish content quality.',
      'Do not invent missing fields or turn these observations into mandatory templates. Parent task schemas remain optional.',
      `Recent window: ${observations.length} tasks; ${JSON.stringify(counts)}.`,
      `Repairs: ${observations.reduce((sum, row) => sum + row.repairs, 0)}.`,
      'Most frequent issue signatures (field names are hashed; no result text or file paths stored):',
      ...[...signatures].sort((a, b) => b[1] - a[1]).slice(0, 16).map(([key, count]) => `- ${key}: ${count}`),
    ].join('\n');
    service.repository.getFileMemoryStore().upsertCandidate({ type: 'feedback', scope: 'project',
      name: 'Subtask delivery observations', description: 'Bounded check and repair metadata; not a quality guarantee.',
      capturedAt: '2026-09-13T00:00:00.000Z', sourceSessionKey: DELIVERY_MEMORY_KEY, body });
    service.repository.getFileMemoryStore().repairManifests();
    service.retriever.resetTransientState();
  };
}
