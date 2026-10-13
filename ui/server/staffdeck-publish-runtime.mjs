import { readFile, writeFile, rename, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';

const queues = new Map();
const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
const error = (code, message) => Object.assign(new Error(message), { code });

/** This is configuration consistency, not authentication or proof of model readiness. */
export function validatePublishRuntimeBinding(binding, owner) {
  if (!record(owner) || !['tenantId', 'actorUserId', 'agentId', 'credentialId'].every(key => text(owner[key]))) {
    throw error('SOP_OWNER_CONTEXT_REQUIRED', 'The authenticated management owner context is required.');
  }
  if (binding?.enabled !== true || !text(binding.definitionsPath)) {
    throw error('SOP_RUNTIME_NOT_CONFIGURED', 'SOP runtime and definitionsPath must be configured.');
  }
  const management = binding.management;
  if (management?.enabled !== true || management.agentId !== owner.agentId || binding.discoveryAgentId !== owner.agentId) {
    throw error('SOP_RUNTIME_OWNER_MISMATCH', 'Management and discovery must target the authenticated owner agent.');
  }
  const endpoint = value => {
    if (!text(value)) throw error('SOP_RUNTIME_NOT_CONFIGURED', 'Public owner and discovery endpoints are required.');
    const url = new URL(value);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) {
      throw error('SOP_RUNTIME_ENDPOINT_INVALID', 'Public endpoint must be an HTTP base URL without embedded credentials, query or fragment.');
    }
    return url.href.replace(/\/+$/, '');
  };
  if (endpoint(management.endpoint) !== endpoint(binding.discoveryEndpoint)) {
    throw error('SOP_RUNTIME_OWNER_MISMATCH', 'Management and discovery must use the same public owner endpoint.');
  }
  if (!text(binding.defaultSopId) && binding.allowEmpty !== true) throw error('SOP_RUNTIME_NOT_CONFIGURED', 'defaultSopId must be configured.');
  return { definitionsPath: resolve(binding.definitionsPath), defaultSopId: binding.defaultSopId };
}

/** Only the formal publish response supplies definition content. No draft/UI fallback. */
export function publishedDefinition(publication, expectedSopId) {
  const sop = publication?.sop;
  if (!record(sop) || !text(sop.skill_id ?? sop.id) || !text(sop.version) || !record(sop.content) || sop.status !== 'published') {
    throw error('SOP_PUBLISH_RESPONSE_INVALID', 'Expected a formal published SOP with ID, version and content.');
  }
  const sopId = sop.skill_id ?? sop.id;
  // SkillRead.id is the owner's row ID; skill_id is the runtime identity.
  if (sopId !== expectedSopId
    || (sop.content.skill_id !== undefined && sop.content.skill_id !== sopId)
    || (sop.content.version !== undefined && sop.content.version !== sop.version)) {
    throw error('SOP_PUBLISH_SOURCE_MISMATCH', 'Published SOP identity/version does not match its requested source.');
  }
  return structuredClone({ ...sop, id: sopId, skill_id: sopId });
}

/** Preserve all other definitions, including IDs required by existing sessions. */
export function mergePublishedDefinition(bundle, definition, defaultSopId) {
  if (!record(bundle) || !Array.isArray(bundle.sops) || bundle.sops.some(item => !record(item))) {
    throw error('SOP_BUNDLE_INVALID', 'Expected an existing definitions bundle with a sops array.');
  }
  const ids = bundle.sops.map(item => item.id ?? item.skill_id);
  if (ids.some(value => !text(value)) || new Set(ids).size !== ids.length) throw error('SOP_BUNDLE_INVALID', 'Definition IDs must be non-empty and unique.');
  const next = structuredClone(bundle);
  const index = ids.indexOf(definition.id);
  if (index === -1) next.sops.push(structuredClone(definition));
  else next.sops[index] = structuredClone(definition);
  if (!next.sops.some(item => (item.id ?? item.skill_id) === defaultSopId)) {
    throw error('SOP_DEFAULT_NOT_IN_BUNDLE', 'Configured defaultSopId is missing from the resulting bundle.');
  }
  return next;
}

/** JSON is valid YAML. Host supplies its declared YAML parser for existing YAML. */
export function createAtomicBundleStore({ parse = JSON.parse } = {}) {
  return {
    async read(path) {
      const parsed = parse(await readFile(path, 'utf8'));
      if (Array.isArray(parsed)) return { sops: parsed };
      if (record(parsed) && !Array.isArray(parsed.sops) && record(parsed.content) && text(parsed.version) && text(parsed.skill_id ?? parsed.id)) {
        return { sops: [{ ...parsed, id: parsed.skill_id ?? parsed.id }] };
      }
      return parsed;
    },
    async write(path, bundle) {
      const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify(bundle)}\n`, { flag: 'wx', mode: 0o600 });
        await rename(temporary, path);
      } finally {
        await unlink(temporary).catch(cause => { if (cause.code !== 'ENOENT') throw cause; });
      }
    },
  };
}

async function serialize(key, action) {
  const previous = queues.get(key) ?? Promise.resolve();
  const current = previous.catch(() => {}).then(action);
  queues.set(key, current);
  try { return await current; }
  finally { if (queues.get(key) === current) queues.delete(key); }
}

/**
 * Wrap the host's ONE authorized publish request. Install once in its normal
 * publish branch, never as a second API write. The host owns PEP, credentials,
 * response delivery and persistence of this deployment receipt.
 *
 * publish() -> original {status,body,headers?}; failures propagate unchanged.
 * requestRefresh({definitionsPath, owner, sopId, version}) -> reload_extensions
 * receipt. No reload_config fallback. A refresh receipt is never "effective".
 *
 * Serialization is per process/path. The integration must retain a single writer
 * process; cross-process snapshot coordination is not provided by this helper.
 */
export function createPublishRuntimeCoordinator({ store = createAtomicBundleStore(), requestRefresh } = {}) {
  return {
    async archive({ binding, owner, sopId, archive }) {
      const config = structuredClone(binding);
      return serialize(text(config?.definitionsPath) ? resolve(config.definitionsPath) : 'unconfigured', async () => {
        const response = await archive();
        if (!Number.isInteger(response?.status) || response.status < 200 || response.status >= 300) return response;
        const runtime = { status: 'not-refreshed', ownerArchived: true, snapshotWritten: false, refreshRequested: false, effective: false, sopId };
        let phase = 'configuration';
        try {
          const profile = validatePublishRuntimeBinding(config, owner);
          if ((response.body?.skill_id ?? response.body?.id) !== sopId || response.body?.status !== 'archived') {
            throw error('SOP_ARCHIVE_RESPONSE_INVALID', 'Expected the requested archived SOP.');
          }
          phase = 'snapshot';
          const bundle = await store.read(profile.definitionsPath);
          if (!Array.isArray(bundle?.sops)) throw error('SOP_BUNDLE_INVALID', 'Expected a definitions bundle.');
          await store.write(profile.definitionsPath, { ...bundle, sops: bundle.sops.filter(item => (item.id ?? item.skill_id) !== sopId) });
          runtime.snapshotWritten = true;
          phase = 'refresh';
          const receipt = await requestRefresh({ definitionsPath: profile.definitionsPath, owner, sopId });
          if (receipt?.reloaded !== true) throw error('SOP_RUNTIME_REFRESH_REJECTED', 'Runtime extension refresh did not acknowledge invalidation.');
          runtime.refreshRequested = true;
          runtime.status = 'awaiting-runtime-observation';
        } catch (cause) {
          runtime.status = 'failed';
          runtime.failure = { phase, code: cause?.code ?? 'SOP_RUNTIME_REFRESH_FAILED' };
        }
        return { ...response, runtime };
      });
    },
    async publish({ binding, owner, sopId, publish }) {
      // Capture request-local configuration before asynchronous work starts.
      const config = structuredClone(binding);
      const ownerContext = structuredClone(owner);
      const key = text(config?.definitionsPath) ? resolve(config.definitionsPath) : 'unconfigured';
      return serialize(key, async () => {
        const response = await publish();
        if (!Number.isInteger(response?.status) || response.status < 200 || response.status >= 300) return response;
        const runtime = { status: 'not-refreshed', ownerPublished: true, snapshotWritten: false, refreshRequested: false, effective: false };
        let phase = 'configuration';
        try {
          const profile = validatePublishRuntimeBinding(config, ownerContext);
          phase = 'published-source';
          const definition = publishedDefinition(response.body, sopId);
          runtime.sopId = definition.id;
          runtime.version = definition.version;
          phase = 'snapshot';
          const bundle = mergePublishedDefinition(await store.read(profile.definitionsPath), definition, profile.defaultSopId ?? definition.id);
          await store.write(profile.definitionsPath, bundle);
          runtime.snapshotWritten = true;
          phase = 'refresh';
          if (typeof requestRefresh !== 'function') throw error('SOP_RUNTIME_REFRESH_UNAVAILABLE', 'No runtime extension refresh port is configured.');
          const receipt = await requestRefresh({ definitionsPath: profile.definitionsPath, owner: ownerContext, sopId: definition.id, version: definition.version });
          if (receipt?.reloaded !== true) throw error('SOP_RUNTIME_REFRESH_REJECTED', 'Runtime extension refresh did not acknowledge invalidation.');
          runtime.refreshRequested = true;
          runtime.status = 'awaiting-runtime-observation';
        } catch (cause) {
          runtime.status = 'failed';
          runtime.failure = { phase, code: typeof cause?.code === 'string' ? cause.code : 'SOP_RUNTIME_REFRESH_FAILED' };
          // Original cause is server-side only; it can contain endpoints or secrets.
          return { ...response, runtime, runtimeError: cause };
        }
        return { ...response, runtime };
      });
    },
  };
}
