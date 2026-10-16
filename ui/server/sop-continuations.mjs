import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { randomUUID } from 'node:crypto';

/** Durable resume intent + delivery outbox. Gateway run registry owns acceptance. */
export function createSopContinuationQueue({ path, resume, run, accepted }) {
  let chain = Promise.resolve();
  const deliveries = new Map();
  const resumes = new Map();
  const update = fn => {
    const result = chain.catch(() => {}).then(async () => {
      let rows = [];
      try { rows = JSON.parse(await readFile(path, 'utf8')); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      const value = await fn(rows);
      await mkdir(dirname(path), { recursive: true });
      const temp = `${path}.${randomUUID()}.tmp`;
      await writeFile(temp, JSON.stringify(rows), { mode: 0o600 });
      await rename(temp, path);
      return value;
    });
    chain = result; return result;
  };
  async function enqueue(input, ownerId) {
    return update(rows => {
      const key = `${input.sessionKey}\0${input.waitId}\0${input.requestId}`;
      const existing = rows.find(row => row.key === key);
      if (existing) {
        if (existing.ownerId !== ownerId || !isDeepStrictEqual(existing.input, input)) throw Object.assign(new Error('Resume request conflict'), { status: 409, code: 'SOP_RESUME_REQUEST_CONFLICT' });
        return existing;
      }
      const row = { key, input, ownerId, runId: `sop-resume:${randomUUID()}`, status: 'resuming' };
      rows.push(row); return row;
    });
  }
  async function resumePending(key) {
    if (resumes.has(key)) return resumes.get(key);
    const operation = (async () => {
      const row = await update(rows => structuredClone(rows.find(item => item.key === key)));
      if (row.status !== 'resuming') return row;
      const receipt = await resume(row);
      return update(rows => {
        const value = rows.find(item => item.key === row.key);
        Object.assign(value, { receipt, status: 'pending' }); return { ...value };
      });
    })();
    resumes.set(key, operation);
    try { return await operation; } finally { resumes.delete(key); }
  }
  async function deliver(row) {
    if (deliveries.has(row.key)) return deliveries.get(row.key);
    const operation = deliverPending(row);
    deliveries.set(row.key, operation);
    try { return await operation; } finally { deliveries.delete(row.key); }
  }
  async function deliverPending(row) {
    const current = await resumePending(row.key);
    if (current.status !== 'pending') return current;
    if (await accepted(current)) {
      return update(rows => { const value = rows.find(item => item.key === row.key); value.status = 'accepted'; return value; });
    }
    let acknowledge;
    const acknowledged = new Promise(resolve => { acknowledge = resolve; });
    // Acceptance ends outbox delivery; model execution may continue for minutes.
    await Promise.race([run(current, async () => {
      await update(rows => {
        const value = rows.find(item => item.key === row.key); value.status = 'accepted'; return value;
      });
      acknowledge();
    }), acknowledged]);
    return current;
  }
  async function drain() {
    const rows = await update(rows => structuredClone(rows.filter(row => ['resuming', 'pending'].includes(row.status))));
    await Promise.all(rows.map(async row => {
      try { await deliver(row); }
      catch (error) {
        await update(rows => {
          const value = rows.find(item => item.key === row.key);
          value.error = { code: error.code || 'SOP_CONTINUATION_FAILED', message: error.message };
          // Transport failures retry. Rejected original commands need a user correction.
          const status = error.status || error.details?.httpStatus;
          if (status >= 400 && status < 500 && status !== 408 && !['SESSION_BUSY', 'session_busy'].includes(error.code)) value.status = 'failed';
        });
      }
    }));
  }
  return { enqueue, resumePending, deliver, drain,
    async idle() { while (deliveries.size) await Promise.allSettled([...deliveries.values()]); await chain; },
    async get(key) { return update(rows => rows.find(row => row.key === key)); } };
}
