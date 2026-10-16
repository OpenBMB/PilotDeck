import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';

// This proof belongs to the server connection, never to browser input.
export function createSopInteractionBindingStore(pathForSession) {
  const valid = binding => typeof binding?.connectionId === 'string' && binding.connectionId
    && Number.isSafeInteger(binding.generation) && binding.generation >= 0;
  async function remember(sessionKey, gateway) {
    const binding = gateway.interactionBinding;
    if (!valid(binding)) return;
    const path = pathForSession(sessionKey);
    await mkdir(dirname(path), { recursive: true });
    const temp = `${path}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify({ connectionId: binding.connectionId, generation: binding.generation }), { mode: 0o600 });
    await rename(temp, path);
  }
  async function restore(sessionKey, gateway) {
    let previousBinding;
    try { previousBinding = JSON.parse(await readFile(pathForSession(sessionKey), 'utf8')); }
    catch (error) { if (error.code === 'ENOENT') return; throw error; }
    if (!valid(previousBinding) || !gateway.reconnectInteraction) return;
    const current = gateway.interactionBinding;
    if (current?.connectionId === previousBinding.connectionId && current.generation === previousBinding.generation) return;
    const result = await gateway.reconnectInteraction({ sessionKey, previousBinding });
    // A restarted Gateway may have no old binding; normal submit establishes it.
    // A live Gateway keeps rejecting stale proofs. Never overwrite that proof.
    if (result.outcome !== 'stale_binding') await remember(sessionKey, gateway);
    return result;
  }
  return { remember, restore };
}
