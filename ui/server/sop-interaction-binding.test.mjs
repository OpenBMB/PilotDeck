// @vitest-environment node
import { expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSopInteractionBindingStore } from './sop-interaction-binding.mjs';

it('recovers the exact server binding after restart and preserves rejected proofs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sop-binding-'));
  try {
    const path = session => join(root, `${session}.json`);
    const original = { connectionId: 'original', generation: 1 };
    await createSopInteractionBindingStore(path).remember('s', { interactionBinding: original });
    const gateway = { interactionBinding: { connectionId: 'new', generation: 2 },
      reconnectInteraction: async input => { expect(input).toEqual({ sessionKey: 's', previousBinding: original }); return { outcome: 'stale_binding' }; } };
    await createSopInteractionBindingStore(path).restore('s', gateway);
    gateway.reconnectInteraction = async input => { expect(input.previousBinding).toEqual(original); return { outcome: 'reconnected' }; };
    await createSopInteractionBindingStore(path).restore('s', gateway);
    gateway.reconnectInteraction = () => { throw new Error('already current'); };
    await createSopInteractionBindingStore(path).restore('s', gateway);
    await createSopInteractionBindingStore(path).restore('missing', gateway);
  } finally { await rm(root, { recursive: true, force: true }); }
});
