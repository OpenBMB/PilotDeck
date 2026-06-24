/**
 * A3 / A4 — file-level integrity tests
 *
 * A3: 新会话的 JSONL 内容 == 源会话到该消息为止的完整副本
 * A4: 源会话未被修改（条数、最后条 id 完全一致）
 *
 * Runs via `node --test` (the project's existing test runner). NOT a Playwright
 * spec — see playwright.config.ts testMatch which excludes *.test.ts.
 *
 * Requires:
 *  - A running dev server at PILOT_E2E_BASE_URL (default http://localhost:5173)
 *  - PILOT_E2E_SESSION_URL pointing at a session with ≥3 user messages
 *  - The session lives on disk at a discoverable path (we read it via the
 *    server's getSessionMeta endpoint to discover the chat dir, then read
 *    the JSONL directly).
 *
 * Strategy:
 *  1. Snapshot source JSONL (sha256 + wc -l + last entryId).
 *  2. Call POST /api/projects/<p>/sessions/<s>/fork with upToEntryId = the
 *     2nd user message's entryId (we discover it by scanning the source JSONL).
 *  3. Read new JSONL from disk.
 *  4. A3: compare new entries to source slice (strip entryId / sessionId / parentEntryId
 *     rewrite suffix before comparison).
 *  5. A4: re-snapshot source JSONL, assert byte-for-byte equality with step-1 snapshot.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

const BASE = process.env.PILOT_E2E_BASE_URL ?? 'http://localhost:5173';
const SESSION_URL = process.env.PILOT_E2E_SESSION_URL;
const PILOT_HOME = process.env.PILOT_HOME ?? '/Users/macmini-01/.pilotdeck';

function skip(reason: string) {
  // node:test doesn't have test.skip with reasons pre-v22; use conditional execution.
  return { reason };
}

const gate = skip(!SESSION_URL ? 'PILOT_E2E_SESSION_URL not set' : '');

test('A4 — source JSONL is byte-identical before and after fork', async (t) => {
  if (gate.reason) return t.skip(gate.reason);

  const { projectName, sessionId } = parseSessionUrl(SESSION_URL!);

  // 1. Snapshot.
  const jsonlPath = await locateJsonl(projectName, sessionId);
  const before = await snapshot(jsonlPath);

  // 2. Fork via HTTP — find a user entry to use as upToEntryId.
  const entries = await readJsonl(jsonlPath);
  const upToEntryId = entries.find(e => e.kind === 'user' && e.entryId)?.entryId;
  assert.ok(upToEntryId, 'need at least one user entry to use as fork point');

  const forkRes = await fetch(`${BASE}/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionId)}/fork`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ upToEntryId }),
  });
  assert.ok(forkRes.ok, `fork HTTP ${forkRes.status}: ${await forkRes.text()}`);
  const { sessionId: newSessionId } = (await forkRes.json()) as { sessionId: string };

  // 3. Re-snapshot source.
  const after = await snapshot(jsonlPath);

  // 4. Assert byte equality.
  assert.equal(after.hash, before.hash, 'source sha256 changed after fork');
  assert.equal(after.lineCount, before.lineCount, 'source line count changed');
  assert.equal(after.lastEntryId, before.lastEntryId, 'source last entryId changed');

  t.diagnostic(`source snapshot: hash=${before.hash.slice(0, 12)}… lines=${before.lineCount}`);
  t.diagnostic(`new session: ${newSessionId}`);
});

test('A3 — new JSONL equals source prefix (with entryId/sessionId/parentEntryId rewritten)', async (t) => {
  if (gate.reason) return t.skip(gate.reason);

  const { projectName, sessionId } = parseSessionUrl(SESSION_URL!);
  const jsonlPath = await locateJsonl(projectName, sessionId);
  const sourceEntries = await readJsonl(jsonlPath);

  // Pick the 2nd user entry's entryId as fork point.
  const userEntries = sourceEntries.filter(e => e.kind === 'user');
  assert.ok(userEntries.length >= 2, 'need ≥2 user entries');
  const upToEntryId = userEntries[1].entryId;
  const upToIndex = sourceEntries.findIndex(e => e.entryId === upToEntryId);

  const forkRes = await fetch(`${BASE}/api/projects/${encodeURIComponent(projectName)}/sessions/${encodeURIComponent(sessionId)}/fork`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ upToEntryId }),
  });
  assert.ok(forkRes.ok, `fork HTTP ${forkRes.status}: ${await forkRes.text()}`);
  const { sessionId: newSessionId } = (await forkRes.json()) as { sessionId: string };

  const newJsonlPath = await locateJsonl(projectName, newSessionId);
  const newEntries = await readJsonl(newJsonlPath);

  // A3: count equality.
  assert.equal(
    newEntries.length,
    upToIndex + 1,
    `expected ${upToIndex + 1} entries in new JSONL, got ${newEntries.length}`,
  );

  // A3: deep equal with ID rewrite stripped.
  const sourcePrefix = sourceEntries.slice(0, upToIndex + 1);
  for (let i = 0; i < sourcePrefix.length; i++) {
    const s = stripForkRewrite(sourcePrefix[i]);
    const n = stripForkRewrite(newEntries[i]);
    assert.deepEqual(
      n,
      s,
      `entry ${i} differs after fork\nsource: ${JSON.stringify(s)}\nnew:    ${JSON.stringify(n)}`,
    );
  }

  t.diagnostic(`A3 verified: ${newEntries.length} entries, all deep-equal (modulo ID rewrites)`);
});

// -------- helpers --------

function parseSessionUrl(url: string): { projectName: string; sessionId: string } {
  const m = url.match(/\/p\/([^/]+)\/c\/([^/?#]+)/);
  if (!m) throw new Error(`not a session URL: ${url}`);
  return { projectName: decodeURIComponent(m[1]), sessionId: decodeURIComponent(m[2]) };
}

type Entry = Record<string, unknown> & { entryId: string; kind: string };

async function readJsonl(path: string): Promise<Entry[]> {
  const raw = await readFile(path, 'utf8');
  const out: Entry[] = [];
  for (const line of raw.split('\n')) {
    if (!line) continue;
    const obj = JSON.parse(line) as Entry;
    out.push(obj);
  }
  return out;
}

async function snapshot(path: string): Promise<{ hash: string; lineCount: number; lastEntryId: string | null }> {
  const raw = await readFile(path, 'utf8');
  const hash = createHash('sha256').update(raw).digest('hex');
  const lines = raw.split('\n').filter(Boolean);
  const last = lines.length > 0 ? (JSON.parse(lines[lines.length - 1]) as Entry) : null;
  return { hash, lineCount: lines.length, lastEntryId: last?.entryId ?? null };
}

/**
 * Discover the JSONL path for a given session. The on-disk layout is:
 *   ${PILOT_HOME}/projects/<projectId>/chats/<safeId>.jsonl
 * where projectId is a hash of projectRoot. The pilotdeck.yaml exposes
 * projectId <-> name via the API.
 *
 * For tests we cheat: we ask the server for the session meta which includes
 * the file path under `__test_path` — no, that doesn't exist. So we use the
 * directory scan: find the chat dir under PILOT_HOME/projects/*/chats/ that
 * contains a .jsonl with a matching entryId (first entry).
 *
 * Practical: we rely on convention — `safeId` is `sessionId.replace(/:/g,'_')`
 * for web: sessions, and the chat dir is one level deep. We just glob.
 */
async function locateJsonl(projectName: string, sessionId: string): Promise<string> {
  const { readdir } = await import('node:fs/promises');
  const { join } = await import('node:path');
  // Find any project dir whose name hash matches projectName — easiest is to
  // look for the .meta.json sidecar in any chats/ dir, then validate.
  const projectsDir = join(PILOT_HOME, 'projects');
  const projects = await readdir(projectsDir).catch(() => []);
  for (const projId of projects) {
    const chatsDir = join(projectsDir, projId, 'chats');
    const files = await readdir(chatsDir).catch(() => []);
    for (const f of files) {
      if (!f.endsWith('.jsonl')) continue;
      const candidate = join(chatsDir, f);
      // Cheap probe: read first line, check sessionId.
      const raw = await readFile(candidate, 'utf8');
      const firstLine = raw.split('\n').find(Boolean);
      if (!firstLine) continue;
      try {
        const obj = JSON.parse(firstLine) as { sessionId?: string };
        if (obj.sessionId === sessionId) return candidate;
      } catch {
        continue;
      }
    }
  }
  throw new Error(`could not locate JSONL for ${projectName}/${sessionId} under ${PILOT_HOME}`);
}

/**
 * Strip the fork-induced ID rewrites so two entries from source vs. new can
 * be compared. Per forkSession.ts: entryId gets `__fork_<tag>` suffix;
 * sessionId is replaced; parentEntryId gets the same suffix treatment.
 */
function stripForkRewrite(entry: Entry): Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(entry)) as Record<string, unknown>;
  if (typeof clone.entryId === 'string') {
    clone.entryId = clone.entryId.replace(/__fork_[a-f0-9]+$/, '');
  }
  // We don't have the source sessionId here to compare, so we just normalize
  // sessionId to a sentinel so cross-tree equality holds.
  if (typeof clone.sessionId === 'string') {
    clone.sessionId = '__SESSION__';
  }
  if (typeof clone.parentEntryId === 'string') {
    clone.parentEntryId = clone.parentEntryId.replace(/__fork_[a-f0-9]+$/, '');
  }
  return clone;
}