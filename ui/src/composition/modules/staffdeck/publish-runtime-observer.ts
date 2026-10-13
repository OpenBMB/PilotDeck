export type RuntimeOwner = { tenantId: string; actorUserId: string; agentId: string };
export type RuntimeReceipt = {
  sopId: string; version?: string;
  status: 'failed' | 'not-refreshed' | 'awaiting-runtime-observation';
  ownerPublished: boolean; snapshotWritten: boolean; refreshRequested: boolean;
  effective: false; receiptPersisted?: boolean;
  failure?: { phase?: string; code: string }; receiptFailure?: { code: string };
};
export type RuntimeSnapshot = { owner: RuntimeOwner | null; receipts: RuntimeReceipt[]; error: boolean };
const object = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = (value: unknown): value is string => typeof value === 'string' && value.trim().length > 0;
const ownerKey = (owner: RuntimeOwner) => JSON.stringify([owner.tenantId, owner.actorUserId, owner.agentId]);

function receipt(value: unknown, sopId?: string): RuntimeReceipt | undefined {
  if (!object(value) || !text(value.sopId ?? sopId) || value.effective !== false
    || !['failed', 'not-refreshed', 'awaiting-runtime-observation'].includes(String(value.status))
    || !['ownerPublished', 'snapshotWritten', 'refreshRequested'].every(key => typeof value[key] === 'boolean')) return;
  if (sopId && value.sopId !== undefined && value.sopId !== sopId) return;
  const failure = object(value.failure) && text(value.failure.code)
    ? { code: value.failure.code, ...(text(value.failure.phase) ? { phase: value.failure.phase } : {}) } : undefined;
  const receiptFailure = object(value.receiptFailure) && text(value.receiptFailure.code) ? { code: value.receiptFailure.code } : undefined;
  return {
    sopId: String(value.sopId ?? sopId), status: value.status as RuntimeReceipt['status'],
    ownerPublished: value.ownerPublished as boolean, snapshotWritten: value.snapshotWritten as boolean,
    refreshRequested: value.refreshRequested as boolean, effective: false,
    ...(text(value.version) ? { version: value.version } : {}),
    ...(typeof value.receiptPersisted === 'boolean' ? { receiptPersisted: value.receiptPersisted } : {}),
    ...(failure ? { failure } : {}), ...(receiptFailure ? { receiptFailure } : {}),
  };
}

// Allocated per mounted module. No global Host, credentials, backend imports,
// publishing, save/retry or runtime-effective inference belongs to this store.
export function createPublishRuntimeObserver() {
  let active = true;
  let epoch = 0;
  let state: RuntimeSnapshot = { owner: null, receipts: [], error: false };
  const listeners = new Set<() => void>();
  const update = (next: RuntimeSnapshot) => { if (!active) return; state = next; listeners.forEach(listener => listener()); };
  return {
    activate() { active = true; },
    getSnapshot: () => state,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    fail() { update({ ...state, error: true }); },
    acceptBootstrap(value: unknown) {
      if (!active) return;
      if (!object(value) || value.enabled !== true || !text(value.tenantId) || !text(value.actorUserId) || !text(value.agentId)) {
        update({ ...state, error: true }); return;
      }
      const owner = { tenantId: value.tenantId, actorUserId: value.actorUserId, agentId: value.agentId };
      const changed = !state.owner || ownerKey(owner) !== ownerKey(state.owner);
      if (changed) epoch++;
      const runtime = object(value.runtime) ? value.runtime : undefined;
      const rows = Array.isArray(runtime?.receipts) ? runtime.receipts : [];
      const parsed = rows.map(row => receipt(row));
      const current = changed ? [] : state.receipts;
      // A slower metadata read must not replace a receipt from a newer publish.
      const merged = new Map(parsed.filter((row): row is RuntimeReceipt => Boolean(row)).map(row => [row.sopId, row]));
      current.forEach(row => merged.set(row.sopId, row));
      update({ owner, receipts: [...merged.values()], error: Boolean(runtime?.failure) || parsed.some(row => !row) });
    },
    captureArchive(sopId: string) {
      const capturedEpoch = epoch;
      return (envelope: unknown) => {
        if (!active || capturedEpoch !== epoch) return;
        if (!object(envelope) || !object(envelope.runtime) || envelope.runtime.ownerArchived !== true) {
          update({ ...state, error: true }); return;
        }
        update({ ...state, receipts: state.receipts.filter(row => row.sopId !== sopId),
          error: envelope.runtime.status === 'failed' || Boolean(envelope.runtime.receiptFailure) });
      };
    },
    capturePublish(sopId: string) {
      const capturedEpoch = epoch;
      const capturedOwner = state.owner && ownerKey(state.owner);
      return (envelope: unknown) => {
        if (!active || capturedEpoch !== epoch) return;
        if (!capturedOwner || !state.owner) { update({ ...state, error: true }); return; }
        if (capturedOwner !== ownerKey(state.owner)) return;
        if (!object(envelope) || !object(envelope.runtime)) { update({ ...state, error: true }); return; }
        const next = receipt(envelope.runtime, sopId);
        if (!next) { update({ ...state, error: true }); return; }
        update({ ...state, error: false, receipts: [...state.receipts.filter(row => row.sopId !== sopId), next] });
      };
    },
    dispose() { active = false; epoch++; listeners.clear(); },
  };
}
export type PublishRuntimeObserver = ReturnType<typeof createPublishRuntimeObserver>;
