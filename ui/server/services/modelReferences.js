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

function collectReference(references, path, value) {
  const ref = parseModelRef(value);
  if (!ref) return;
  references.push({ path, value: `${ref.providerId}/${ref.modelId}`, kind: referenceKind(path), ...ref });
}

export function findModelReferences(config, { providerId = '', modelId = '' } = {}) {
  const references = [];
  const agent = config?.agent;
  collectReference(references, 'agent.model', agent?.model);
  collectReference(references, 'agent.subagents.default', agent?.subagents?.default);
  collectReference(references, 'memory.model', config?.memory?.model);

  const router = config?.router;
  if (isRecord(router?.scenarios)) {
    for (const [name, value] of Object.entries(router.scenarios)) {
      collectReference(references, `router.scenarios.${name}`, value);
    }
  }
  if (isRecord(router?.fallback)) {
    for (const [name, values] of Object.entries(router.fallback)) {
      if (!Array.isArray(values)) continue;
      values.forEach((value, index) => {
        collectReference(references, `router.fallback.${name}.${index}`, value);
      });
    }
  }
  collectReference(references, 'router.tokenSaver.judge', router?.tokenSaver?.judge);
  if (isRecord(router?.tokenSaver?.tiers)) {
    for (const [name, tier] of Object.entries(router.tokenSaver.tiers)) {
      collectReference(references, `router.tokenSaver.tiers.${name}.model`, tier?.model);
    }
  }
  if (isRecord(router?.stats?.modelPricing)) {
    for (const key of Object.keys(router.stats.modelPricing)) {
      collectReference(references, `router.stats.modelPricing.${key}`, key);
    }
  }
  collectReference(references, 'router.stats.baselineModel', router?.stats?.baselineModel);

  return references.filter((reference) => (
    (!providerId || reference.providerId === providerId)
    && (!modelId || reference.modelId === modelId)
  )).map(({ providerId: _providerId, modelId: _modelId, ...reference }) => reference);
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
