// @vitest-environment node
import { expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSopContinuationQueue } from './sop-continuations.mjs';

it('recovers a durable resume and delivers once after Gateway acceptance', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sop-outbox-'));
  try {
    let resumes = 0, runs = 0; const accepted = new Set();
    const ports = { path: join(root, 'queue.json'),
      resume: async () => { resumes++; return { accepted: true, revision: 4 }; },
      accepted: async row => accepted.has(row.runId),
      run: async (row, onInputAccepted) => { runs++; accepted.add(row.runId); await onInputAccepted(); },
    };
    const input = { sessionKey: 'session', waitId: 'wait', requestId: 'request', expectedRevision: 3, message: 'approve' };
    const queue = createSopContinuationQueue(ports);
    const row = await queue.enqueue(input, 'owner');
    await expect(queue.enqueue({ ...input, message: 'forged' }, 'owner')).rejects.toMatchObject({ code: 'SOP_RESUME_REQUEST_CONFLICT' });
    const restarted = createSopContinuationQueue(ports);
    await restarted.resumePending(row.key);
    expect(resumes).toBe(1); expect(runs).toBe(0);
    // Crash after Gateway acceptance but before the outbox acknowledgement.
    accepted.add(row.runId);
    await createSopContinuationQueue(ports).drain();
    expect(runs).toBe(0); expect(resumes).toBe(1);
    expect((await restarted.get(row.key)).status).toBe('accepted');
    await restarted.enqueue(input, 'owner'); await restarted.drain();
    expect(runs).toBe(0);
    await restarted.enqueue({ ...input, waitId: 'wait2', requestId: 'request2' }, 'owner'); await restarted.drain();
    expect(runs).toBe(1); expect(resumes).toBe(2);
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('shares concurrent resume calls and returns before long model execution', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sop-outbox-'));
  try {
    let count = 0; const queue = createSopContinuationQueue({ path: join(root, 'queue.json'),
      resume: async () => { count++; await new Promise(resolve => setTimeout(resolve, 10)); return { accepted: true }; },
      accepted: async () => false, run: async () => { throw new Error('not awaited by resume'); },
    });
    const row = await queue.enqueue({ sessionKey: 's', waitId: 'w', requestId: 'r' }, 'owner');
    const result = await Promise.all([queue.resumePending(row.key), queue.resumePending(row.key)]);
    expect(count).toBe(1); expect(result[0].status).toBe('pending');
  } finally { await rm(root, { recursive: true, force: true }); }
});

it('stops retrying rejected Gateway commands while retaining transport retries', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sop-outbox-'));
  try {
    let attempts = 0;
    const queue = createSopContinuationQueue({ path: join(root, 'queue.json'),
      resume: async row => { attempts++; throw row.input.requestId === 'forbidden'
        ? Object.assign(new Error('Forbidden'), { code: 'SOP_APPROVAL_SESSION_FORBIDDEN', details: { httpStatus: 403 } })
        : new Error('Disconnected'); }, accepted: async () => false, run: async () => {},
    });
    const rejected = await queue.enqueue({ sessionKey: 's', waitId: 'w', requestId: 'forbidden' }, 'owner');
    const retry = await queue.enqueue({ sessionKey: 's', waitId: 'w', requestId: 'transport' }, 'owner');
    await queue.drain(); await queue.drain();
    expect(attempts).toBe(3);
    expect((await queue.get(rejected.key)).status).toBe('failed');
    expect((await queue.get(retry.key)).status).toBe('resuming');
  } finally { await rm(root, { recursive: true, force: true }); }
});
