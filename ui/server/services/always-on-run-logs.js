import { promises as fs } from 'node:fs';
import path from 'node:path';

import { getAlwaysOnRoot } from './always-on-paths.js';

function normalizeRunId(runId) {
  return typeof runId === 'string'
    ? runId.trim().replace(/[^a-zA-Z0-9._:-]/g, '-')
    : '';
}

function ensureTrailingNewline(value) {
  return value.endsWith('\n') ? value : `${value}\n`;
}

function getAlwaysOnRunsDir(projectRoot) {
  return path.join(getAlwaysOnRoot(projectRoot), 'runs');
}

function getRunLogPath(projectRoot, runId) {
  const safeRunId = normalizeRunId(runId);
  if (!safeRunId) {
    throw new Error('runId is required');
  }
  return path.join(getAlwaysOnRunsDir(projectRoot), `${safeRunId}.log`);
}

function getRunEventsPath(projectRoot, runId) {
  const safeRunId = normalizeRunId(runId);
  if (!safeRunId) {
    throw new Error('runId is required');
  }
  return path.join(getAlwaysOnRunsDir(projectRoot), `${safeRunId}.events.jsonl`);
}

export function formatAlwaysOnPlanLogLine({
  timestamp = new Date().toISOString(),
  level = 'info',
  runId,
  planId,
  phase,
  message,
}) {
  const safeMessage = String(message || '').replace(/\s+/g, ' ').trim();
  return `[AlwaysOnPlanRun] ts=${timestamp} level=${level} runId=${runId} planId=${planId} phase=${phase} message=${JSON.stringify(safeMessage)}`;
}

export async function appendAlwaysOnRunLog(projectRoot, runId, lines) {
  const values = Array.isArray(lines) ? lines : [lines];
  const content = values
    .map((line) => (typeof line === 'string' ? line : String(line ?? '')))
    .filter((line) => line.length > 0)
    .map(ensureTrailingNewline)
    .join('');

  if (!content) {
    return;
  }

  await fs.mkdir(getAlwaysOnRunsDir(projectRoot), { recursive: true });
  await fs.appendFile(getRunLogPath(projectRoot, runId), content, 'utf8');
}

export async function appendAlwaysOnRunLogEvent(projectRoot, runId, event) {
  await fs.mkdir(getAlwaysOnRunsDir(projectRoot), { recursive: true });
  await fs.appendFile(
    getRunEventsPath(projectRoot, runId),
    `${JSON.stringify({
      timestamp: new Date().toISOString(),
      ...event,
      runId,
    })}\n`,
    'utf8',
  );
}
