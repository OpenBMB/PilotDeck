function isRecord(value) {
  return value && typeof value === 'object' && !Array.isArray(value);
}

function text(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function parseModelRef(value) {
  if (typeof value === 'string') {
    const raw = value.trim();
    const slash = raw.indexOf('/');
    if (slash > 0 && slash < raw.length - 1) {
      return { providerId: raw.slice(0, slash), modelId: raw.slice(slash + 1) };
    }
    return null;
  }
  if (!isRecord(value)) return null;
  const id = text(value.id);
  const providerId = text(value.provider) || text(value.providerId);
  const modelId = text(value.model) || text(value.modelId);
  if (providerId && modelId) return { providerId, modelId };
  if (id) return parseModelRef(id);
  return null;
}

function referenceKind(path) {
  if (path.startsWith('router.')) return 'router';
  if (path.startsWith('memory.')) return 'memory';
  if (path.startsWith('agent.')) return 'agent';
  return 'model';
}

// How a reference is repaired when the model it points at is removed.
//   replace — the slot needs a working model; it takes the chosen replacement
//   inherit — the slot has an "inherit agent.model" value
//   remove  — the slot is optional or pure metadata and can be dropped
export const REFERENCE_ACTIONS = Object.freeze(['replace', 'inherit', 'remove', 'clear']);

const REMOVED = Symbol('removed-reference');

// Walk every model reference in the config exactly once. Each slot carries the
// default repair action and small mutators bound to its container, so callers
// never have to re-parse dotted paths (pricing keys such as `openai/gpt-4.1`
// contain dots themselves).
function collectReferenceSlots(config) {
  const slots = [];
  const add = (path, value, action, mutate) => {
    const ref = parseModelRef(value);
    if (!ref) return;
    slots.push({
      path,
      value: `${ref.providerId}/${ref.modelId}`,
      kind: referenceKind(path),
      providerId: ref.providerId,
      modelId: ref.modelId,
      action,
      raw: value,
      ...mutate,
    });
  };

  const agent = config?.agent;
  add('agent.model', agent?.model, 'replace', {
    set: (next) => { agent.model = next; },
    clear: () => { agent.model = ''; },
  });
  add('agent.subagents.default', agent?.subagents?.default, 'inherit', {
    inherit: () => { agent.subagents.default = 'inherit'; },
  });
  if (isRecord(agent?.subagents?.profiles)) {
    for (const [id, profile] of Object.entries(agent.subagents.profiles)) {
      add(`agent.subagents.profiles.${id}.model`, profile?.model, 'inherit', {
        inherit: () => { delete profile.model; },
      });
    }
  }
  const memory = config?.memory;
  add('memory.model', memory?.model, 'inherit', {
    // Memory inherits by omitting its override; unlike subagents, the runtime
    // parser does not accept the literal "inherit" as a model reference.
    inherit: () => { delete memory.model; },
  });

  const router = config?.router;
  if (isRecord(router?.scenarios)) {
    const scenarios = router.scenarios;
    for (const [name, value] of Object.entries(scenarios)) {
      // Only the default route is consumed by the runtime; other scenario keys
      // fall back to it when absent.
      add(`router.scenarios.${name}`, value, name === 'default' ? 'replace' : 'remove', {
        router: true,
        set: (next) => { scenarios[name] = next; },
        remove: () => { delete scenarios[name]; },
      });
    }
  }
  if (isRecord(router?.fallback)) {
    for (const [name, values] of Object.entries(router.fallback)) {
      if (!Array.isArray(values)) continue;
      values.forEach((value, index) => {
        add(`router.fallback.${name}.${index}`, value, 'remove', {
          fallbackKey: name,
          remove: () => { values[index] = REMOVED; },
        });
      });
    }
  }
  const tokenSaver = router?.tokenSaver;
  add('router.tokenSaver.judge', tokenSaver?.judge, 'replace', {
    router: true,
    tokenSaver: true,
    set: (next) => { tokenSaver.judge = next; },
    remove: () => { delete tokenSaver.judge; },
  });
  if (isRecord(tokenSaver?.tiers)) {
    for (const [name, tier] of Object.entries(tokenSaver.tiers)) {
      add(`router.tokenSaver.tiers.${name}.model`, tier?.model, 'replace', {
        router: true,
        tokenSaver: true,
        set: (next) => { tier.model = next; },
        remove: () => { delete tier.model; },
      });
    }
  }
  const stats = router?.stats;
  if (isRecord(stats?.modelPricing)) {
    const pricing = stats.modelPricing;
    for (const key of Object.keys(pricing)) {
      // Pricing is per-model cost metadata; copying it onto another model
      // would silently produce wrong statistics, so it is dropped.
      add(`router.stats.modelPricing.${key}`, key, 'remove', {
        remove: () => { delete pricing[key]; },
      });
    }
  }
  add('router.stats.baselineModel', stats?.baselineModel, 'remove', {
    remove: () => { delete stats.baselineModel; },
  });
  return slots;
}

function matchesTarget(slot, { providerId = '', modelId = '' }) {
  return (!providerId || slot.providerId === providerId)
    && (!modelId || slot.modelId === modelId);
}

export function findModelReferences(config, { providerId = '', modelId = '' } = {}) {
  return collectReferenceSlots(config)
    .filter(slot => matchesTarget(slot, { providerId, modelId }))
    .map(({ path, value, kind }) => ({ path, value, kind }));
}

function replacementValue(value, replacement) {
  if (!isRecord(value)) return replacement;
  const ref = parseModelRef(replacement);
  const next = { ...value };
  if (Object.hasOwn(value, 'id')) next.id = replacement;
  if (Object.hasOwn(value, 'provider')) next.provider = ref.providerId;
  if (Object.hasOwn(value, 'providerId')) next.providerId = ref.providerId;
  if (Object.hasOwn(value, 'model')) next.model = ref.modelId;
  if (Object.hasOwn(value, 'modelId')) next.modelId = ref.modelId;
  return next;
}

function remainingModelRefs(config, { providerId, modelId }) {
  const refs = [];
  const providers = config?.model?.providers;
  if (!isRecord(providers)) return refs;
  for (const [id, provider] of Object.entries(providers)) {
    if (id === providerId && !modelId) continue;
    if (!isRecord(provider?.models)) continue;
    for (const model of Object.keys(provider.models)) {
      if (id === providerId && model === modelId) continue;
      refs.push(`${id}/${model}`);
    }
  }
  return refs;
}

function blockedPlan(base, code, message) {
  return { ...base, blocked: { code, message }, config: null };
}

/**
 * Plan the removal of a provider (or one of its models) together with every
 * repair needed to keep the configuration valid.
 *
 * The input config is never mutated. The returned `config` is the complete
 * next configuration (or null when the plan is blocked), and `changes` lists
 * every slot that will be touched so the UI can preview the exact result.
 */
export function planModelRemoval(config, { providerId = '', modelId = '' } = {}, { replacement = '' } = {}) {
  const target = { providerId: text(providerId), ...(text(modelId) ? { modelId: text(modelId) } : {}) };
  const provider = config?.model?.providers?.[target.providerId];
  const base = {
    target,
    replacement: '',
    replacementOptions: [],
    requiresReplacement: false,
    changes: [],
  };
  if (!target.providerId || !isRecord(provider)) {
    return blockedPlan(base, 'NOT_FOUND', `Provider "${target.providerId}" is not configured.`);
  }
  if (target.modelId && !(isRecord(provider.models) && Object.hasOwn(provider.models, target.modelId))) {
    return blockedPlan(base, 'NOT_FOUND', `Model "${target.modelId}" is not configured for provider "${target.providerId}".`);
  }

  const next = JSON.parse(JSON.stringify(config));
  const options = remainingModelRefs(next, target);
  const slots = collectReferenceSlots(next).filter(slot => matchesTarget(slot, target));
  const requiresReplacement = slots.some(slot => slot.action === 'replace');
  const chosen = text(replacement);
  const plan = { ...base, replacementOptions: options, requiresReplacement, replacement: requiresReplacement ? chosen : '' };

  const router = next.router;
  const routerEnabled = isRecord(router) && router.enabled !== false;
  const tokenSaverEnabled = routerEnabled && router.tokenSaver?.enabled !== false;
  const slotIsActive = slot => (slot.tokenSaver ? tokenSaverEnabled : slot.router ? routerEnabled : true);

  // Resolve the final action of each slot.
  for (const slot of slots) {
    let action = slot.action;
    if (action === 'replace' && !chosen && options.length === 0) {
      // Nothing left to switch to. An empty agent model is allowed (onboarding
      // state); router slots that are not active can simply be dropped.
      if (slot.path === 'agent.model') action = 'clear';
      else if (!slotIsActive(slot)) action = 'remove';
    }
    slot.finalAction = action;
  }
  plan.changes = slots.map(slot => ({
    path: slot.path,
    value: slot.value,
    kind: slot.kind,
    action: slot.finalAction,
    ...(slot.finalAction === 'replace' && chosen ? { to: chosen } : {}),
  }));

  const unresolved = slots.filter(slot => slot.finalAction === 'replace');
  if (unresolved.length && !chosen) {
    return options.length
      ? blockedPlan(plan, 'REPLACEMENT_REQUIRED', 'Choose a replacement model for the references that need one.')
      : blockedPlan(plan, 'ROUTER_REQUIRES_MODEL', 'Smart routing is enabled and needs at least one other model.');
  }
  if (unresolved.length && !options.includes(chosen)) {
    return blockedPlan(plan, 'REPLACEMENT_INVALID', `Replacement "${chosen}" is not an available model.`);
  }

  for (const slot of slots) {
    if (slot.finalAction === 'replace') slot.set(replacementValue(slot.raw, chosen));
    else if (slot.finalAction === 'clear') slot.clear();
    else if (slot.finalAction === 'inherit') slot.inherit();
    else slot.remove();
  }

  // Remove only entries that reference the deleted model/provider. Dynamic
  // routes can select another tier or subagent model and fall back to the main
  // model, so matching agent.model does not make a configured backup redundant.
  // The runtime deduplicates attempts against its actual selection.
  const touchedFallbacks = new Set(slots.map(slot => slot.fallbackKey).filter(Boolean));
  if (isRecord(router?.fallback)) {
    for (const name of touchedFallbacks) {
      const values = router.fallback[name];
      if (!Array.isArray(values)) continue;
      const kept = values.filter(value => value !== REMOVED);
      if (kept.length) router.fallback[name] = kept;
      else delete router.fallback[name];
    }
  }

  if (target.modelId) delete next.model.providers[target.providerId].models[target.modelId];
  else delete next.model.providers[target.providerId];

  return { ...plan, blocked: null, config: next };
}

function renameRef(value, providerRenames, modelRenames) {
  const ref = parseModelRef(value);
  if (!ref) return value;
  const renamedProvider = providerRenames.get(ref.providerId) || ref.providerId;
  const renamedModel = modelRenames.get(`${ref.providerId}/${ref.modelId}`)?.modelId || ref.modelId;
  const nextId = `${renamedProvider}/${renamedModel}`;
  if (typeof value === 'string') return nextId;
  const next = { ...value };
  if (Object.hasOwn(value, 'id')) next.id = nextId;
  if (Object.hasOwn(value, 'provider')) next.provider = renamedProvider;
  if (Object.hasOwn(value, 'providerId')) next.providerId = renamedProvider;
  if (Object.hasOwn(value, 'model')) next.model = renamedModel;
  if (Object.hasOwn(value, 'modelId')) next.modelId = renamedModel;
  return next;
}

export function rewriteModelReferences(config, { providerRenames = new Map(), modelRenames = new Map() } = {}) {
  const agent = config?.agent;
  if (agent) {
    agent.model = renameRef(agent.model, providerRenames, modelRenames);
    if (agent.subagents) agent.subagents.default = renameRef(agent.subagents.default, providerRenames, modelRenames);
    if (isRecord(agent.subagents?.profiles)) {
      for (const profile of Object.values(agent.subagents.profiles)) {
        if (isRecord(profile) && Object.hasOwn(profile, 'model')) {
          profile.model = renameRef(profile.model, providerRenames, modelRenames);
        }
      }
    }
  }
  if (config?.memory) config.memory.model = renameRef(config.memory.model, providerRenames, modelRenames);

  const router = config?.router;
  if (isRecord(router?.scenarios)) {
    for (const [name, value] of Object.entries(router.scenarios)) {
      router.scenarios[name] = renameRef(value, providerRenames, modelRenames);
    }
  }
  if (isRecord(router?.fallback)) {
    for (const [name, values] of Object.entries(router.fallback)) {
      if (Array.isArray(values)) {
        router.fallback[name] = values.map((value) => renameRef(value, providerRenames, modelRenames));
      }
    }
  }
  if (router?.tokenSaver) {
    router.tokenSaver.judge = renameRef(router.tokenSaver.judge, providerRenames, modelRenames);
    if (isRecord(router.tokenSaver.tiers)) {
      for (const tier of Object.values(router.tokenSaver.tiers)) {
        if (isRecord(tier)) tier.model = renameRef(tier.model, providerRenames, modelRenames);
      }
    }
  }
  if (isRecord(router?.stats?.modelPricing)) {
    const pricing = {};
    for (const [key, value] of Object.entries(router.stats.modelPricing)) {
      pricing[renameRef(key, providerRenames, modelRenames)] = value;
    }
    router.stats.modelPricing = pricing;
  }
  if (router?.stats?.baselineModel !== undefined) {
    router.stats.baselineModel = renameRef(router.stats.baselineModel, providerRenames, modelRenames);
  }
  return config;
}

export function configuredModelIds(config) {
  const result = new Map();
  const providers = config?.model?.providers;
  if (!isRecord(providers)) return result;
  for (const [providerId, provider] of Object.entries(providers)) {
    result.set(providerId, new Set(isRecord(provider?.models) ? Object.keys(provider.models) : []));
  }
  return result;
}
