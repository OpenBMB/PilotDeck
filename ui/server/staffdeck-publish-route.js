import { resolve } from 'node:path';
import { homedir } from 'node:os';
import { parse as parseYaml } from 'yaml';
import { createAtomicBundleStore, createPublishRuntimeCoordinator } from './staffdeck-publish-runtime.mjs';

const queues = new Map();
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const receiptKey = (owner, sopId) => JSON.stringify([owner.tenantId, owner.actorUserId, owner.agentId, owner.credentialId, sopId]);
const sameOwner = (a, b) => ['tenantId', 'actorUserId', 'agentId', 'credentialId'].every(field => a?.[field] === b?.[field]);

async function serialize(path, action) {
  const previous = queues.get(path) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(action);
  queues.set(path, current);
  try { return await current; }
  finally { if (queues.get(path) === current) queues.delete(path); }
}

function resolvedBinding(binding, management) {
  const home = process.env.PILOT_HOME || resolve(homedir(), '.pilotdeck');
  return {
    enabled: binding?.enabled,
    allowEmpty: process.env.STAFFDECK_PROJECT_BINDING_ENABLED === 'true',
    ...(typeof binding?.definitionsPath === 'string' && binding.definitionsPath.trim()
      ? { definitionsPath: resolve(home, binding.definitionsPath) } : {}),
    defaultSopId: binding?.defaultSopId,
    discoveryAgentId: binding?.discoveryAgentId,
    discoveryEndpoint: binding?.discoveryEndpoint,
    management: { enabled: true, agentId: management.agentId, endpoint: management.endpoint },
  };
}

async function readReceipts(store, path) {
  try {
    const receipt = await store.read(path);
    if (!record(receipt) || !record(receipt.receipts)) throw Object.assign(new Error('Invalid publish receipts'), { code: 'SOP_RUNTIME_RECEIPT_INVALID' });
    return receipt;
  } catch (error) {
    if (error.code === 'ENOENT') return { receipts: {} };
    throw error;
  }
}

/** One web writer; receipts contain public status and owner metadata, never credentials or error causes. */
export function createStaffDeckPublishRoute({ getGateway, bundleStore = createAtomicBundleStore({ parse: parseYaml }), receiptStore = createAtomicBundleStore() }) {
  const coordinator = createPublishRuntimeCoordinator({
    store: bundleStore,
    requestRefresh: async ({ definitionsPath }) => {
      const gateway = await getGateway();
      if (typeof gateway?.reloadExtensions !== 'function') {
        throw Object.assign(new Error('Runtime extension refresh is unavailable'), { code: 'SOP_RUNTIME_REFRESH_UNAVAILABLE' });
      }
      if (process.env.STAFFDECK_PROJECT_BINDING_ENABLED === 'true') {
        await gateway.reloadConfig();
      }
      return gateway.reloadExtensions({ changedPaths: [definitionsPath] });
    },
  });
  return {
    async archive({ binding, management, owner, sopId, archive }) {
      const runtimeBinding = resolvedBinding(binding, management);
      const receiptPath = runtimeBinding.definitionsPath ? runtimeBinding.definitionsPath + '.publish-receipts.json' : undefined;
      return serialize(receiptPath || 'unconfigured', async () => {
        const result = await coordinator.archive({ binding: runtimeBinding, owner, sopId, archive });
        if (!result?.runtime?.ownerArchived || !receiptPath) return result;
        try {
          const receipts = await readReceipts(receiptStore, receiptPath);
          delete receipts.receipts[receiptKey(owner, sopId)];
          await receiptStore.write(receiptPath, receipts);
          return { ...result, runtime: { ...result.runtime, receiptPersisted: true } };
        } catch {
          return { ...result, runtime: { ...result.runtime, receiptPersisted: false,
            receiptFailure: { code: 'SOP_RUNTIME_RECEIPT_FAILED' } } };
        }
      });
    },
    async publish({ binding, management, owner, sopId, publish }) {
      const runtimeBinding = resolvedBinding(binding, management);
      const receiptPath = runtimeBinding.definitionsPath ? runtimeBinding.definitionsPath + '.publish-receipts.json' : undefined;
      const action = async () => {
        const result = await coordinator.publish({ binding: runtimeBinding, owner, sopId, publish });
        if (!result?.runtime) return result;
        const runtime = { ...result.runtime, receiptPersisted: false };
        // Never expose a raw runtimeError, endpoints, deployment paths or the owner credential.
        const { runtimeError: _cause, ...publicResult } = result;
        if (!receiptPath) {
          runtime.receiptFailure = { code: 'SOP_RUNTIME_RECEIPT_UNAVAILABLE' };
          return { ...publicResult, runtime };
        }
        try {
          const receipts = await readReceipts(receiptStore, receiptPath);
          const persisted = { ...runtime, receiptPersisted: true };
          receipts.receipts[receiptKey(owner, sopId)] = { owner: structuredClone(owner), sopId, runtime: persisted };
          await receiptStore.write(receiptPath, receipts);
          runtime.receiptPersisted = true;
        } catch {
          runtime.receiptFailure = { code: 'SOP_RUNTIME_RECEIPT_FAILED' };
        }
        return { ...publicResult, runtime };
      };
      return serialize(receiptPath || 'unconfigured', action);
    },
    async read({ binding, management, owner }) {
      const runtimeBinding = resolvedBinding(binding, management);
      if (!runtimeBinding.definitionsPath) return { receipts: [] };
      try {
        const stored = await readReceipts(receiptStore, runtimeBinding.definitionsPath + '.publish-receipts.json');
        return { receipts: Object.values(stored.receipts).filter(receipt => record(receipt) && sameOwner(receipt.owner, owner))
          .map(receipt => ({ sopId: receipt.sopId, ...receipt.runtime })) };
      } catch {
        return { receipts: [], failure: { code: 'SOP_RUNTIME_RECEIPT_READ_FAILED' } };
      }
    },
  };
}
