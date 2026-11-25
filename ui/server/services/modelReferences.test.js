import { describe, expect, it } from 'vitest';
import { findModelReferences, planModelRemoval } from './modelReferences.js';
import { parseRouterConfig } from '../../../src/router/config/parseRouterConfig.js';

const provider = (models) => ({
  protocol: 'openai',
  url: 'https://example.test/v1',
  apiKey: 'key',
  models: Object.fromEntries(models.map(id => [id, {}])),
});

// Mirrors the reported case: a provider whose model is the main model, the
// preferred default route, and has pricing metadata.
function reportedConfig() {
  return {
    agent: { model: 'HX API/qwen3.6-27b', subagents: { default: 'HX API/qwen3.6-27b' } },
    memory: { enabled: true, model: 'HX API/qwen3.6-27b' },
    model: {
      providers: {
        'HX API': provider(['qwen3.6-27b', 'other']),
        deepseek: provider(['deepseek-chat', 'deepseek-reasoner']),
      },
    },
    router: {
      enabled: true,
      scenarios: { default: 'HX API/qwen3.6-27b', think: 'HX API/other' },
      fallback: {
        maxFallbacks: 2,
        default: ['HX API/qwen3.6-27b', 'deepseek/deepseek-chat', 'deepseek/deepseek-reasoner'],
        think: ['deepseek/deepseek-reasoner'],
      },
      tokenSaver: {
        enabled: true,
        judge: 'HX API/qwen3.6-27b',
        defaultTier: 'fast',
        tiers: { fast: { model: 'HX API/qwen3.6-27b' }, smart: { model: 'deepseek/deepseek-reasoner' } },
      },
      stats: {
        modelPricing: {
          'HX API/qwen3.6-27b': { input: 1, output: 2 },
          'deepseek/deepseek-chat': { input: 0.5, output: 1 },
        },
        baselineModel: { provider: 'HX API', model: 'qwen3.6-27b' },
      },
    },
  };
}

describe('findModelReferences', () => {
  it('keeps the public reference shape', () => {
    const refs = findModelReferences(reportedConfig(), { providerId: 'HX API', modelId: 'qwen3.6-27b' });
    expect(refs[0]).toEqual({ path: 'agent.model', value: 'HX API/qwen3.6-27b', kind: 'agent' });
    expect(refs.map(ref => ref.path)).toEqual([
      'agent.model',
      'agent.subagents.default',
      'memory.model',
      'router.scenarios.default',
      'router.tokenSaver.judge',
      'router.tokenSaver.tiers.fast.model',
      'router.stats.modelPricing.HX API/qwen3.6-27b',
      'router.stats.baselineModel',
    ]);
  });
});

describe('planModelRemoval', () => {
  it('classifies references and requires a replacement before applying', () => {
    const plan = planModelRemoval(reportedConfig(), { providerId: 'HX API' });
    expect(plan.blocked?.code).toBe('REPLACEMENT_REQUIRED');
    expect(plan.config).toBeNull();
    expect(plan.requiresReplacement).toBe(true);
    expect(plan.replacementOptions).toEqual(['deepseek/deepseek-chat', 'deepseek/deepseek-reasoner']);
    const actions = Object.fromEntries(plan.changes.map(change => [change.path, change.action]));
    expect(actions).toMatchObject({
      'agent.model': 'replace',
      'agent.subagents.default': 'inherit',
      'memory.model': 'inherit',
      'router.scenarios.default': 'replace',
      'router.scenarios.think': 'remove',
      'router.tokenSaver.judge': 'replace',
      'router.tokenSaver.tiers.fast.model': 'replace',
      'router.stats.modelPricing.HX API/qwen3.6-27b': 'remove',
      'router.stats.baselineModel': 'remove',
    });
  });

  it('removes the provider and repairs every reference in one config', () => {
    const input = reportedConfig();
    const snapshot = structuredClone(input);
    const plan = planModelRemoval(input, { providerId: 'HX API' }, { replacement: 'deepseek/deepseek-chat' });
    expect(plan.blocked).toBeNull();
    expect(input).toEqual(snapshot);

    const next = plan.config;
    expect(Object.keys(next.model.providers)).toEqual(['deepseek']);
    expect(next.agent.model).toBe('deepseek/deepseek-chat');
    expect(next.agent.subagents.default).toBe('inherit');
    expect(next.memory).not.toHaveProperty('model');
    expect(next.router.scenarios).toEqual({ default: 'deepseek/deepseek-chat' });
    expect(next.router.fallback).toEqual(input.router.fallback);
    expect(next.router.tokenSaver.judge).toBe('deepseek/deepseek-chat');
    expect(next.router.tokenSaver.tiers.fast.model).toBe('deepseek/deepseek-chat');
    expect(next.router.tokenSaver.tiers.smart.model).toBe('deepseek/deepseek-reasoner');
    expect(next.router.stats.modelPricing).toEqual({ 'deepseek/deepseek-chat': { input: 0.5, output: 1 } });
    expect(next.router.stats.baselineModel).toBeUndefined();
    expect(findModelReferences(next, { providerId: 'HX API' })).toEqual([]);

    expect(plan.changes.some(change => change.path.startsWith('router.fallback.'))).toBe(false);
    expect(plan.changes.find(change => change.path === 'agent.model')).toMatchObject({ to: 'deepseek/deepseek-chat' });
  });

  it('removes a single model and offers the provider\'s other models', () => {
    const plan = planModelRemoval(reportedConfig(), { providerId: 'HX API', modelId: 'qwen3.6-27b' }, { replacement: 'HX API/other' });
    expect(plan.replacementOptions).toContain('HX API/other');
    expect(plan.blocked).toBeNull();
    expect(Object.keys(plan.config.model.providers['HX API'].models)).toEqual(['other']);
    expect(plan.config.agent.model).toBe('HX API/other');
    // The think scenario points at a model that is kept, so it is untouched.
    expect(plan.config.router.scenarios.think).toBe('HX API/other');
  });

  it('does not require a replacement when only optional references exist', () => {
    const config = reportedConfig();
    const plan = planModelRemoval(config, { providerId: 'deepseek', modelId: 'deepseek-chat' });
    expect(plan.requiresReplacement).toBe(false);
    expect(plan.blocked).toBeNull();
    expect(plan.config.router.fallback).toEqual(config.router.fallback);
    expect(plan.changes.filter(change => change.reason === 'redundant').map(change => change.path))
      .toEqual([]);
    expect(plan.config.router.stats.modelPricing).toEqual({ 'HX API/qwen3.6-27b': { input: 1, output: 2 } });
  });

  it('ignores legacy fallback references during removal and runtime parsing', () => {
    const config = reportedConfig();
    config.model.providers.retired = provider(['old']);
    config.router.fallback.default.unshift('retired/old');
    const plan = planModelRemoval(config, { providerId: 'retired' });

    expect(plan.blocked).toBeNull();
    expect(plan.changes).toEqual([]);
    expect(plan.config.model.providers.retired).toBeUndefined();
    expect(plan.config.router.fallback).toEqual(config.router.fallback);
    const runtime = parseRouterConfig(plan.config.router, plan.config.model);
    expect(runtime.diagnostics).toEqual([]);
    expect(runtime.config).not.toHaveProperty('fallback');
  });

  it('rejects a replacement that is being removed or does not exist', () => {
    for (const replacement of ['HX API/other', 'missing/model']) {
      const plan = planModelRemoval(reportedConfig(), { providerId: 'HX API' }, { replacement });
      expect(plan.blocked?.code).toBe('REPLACEMENT_INVALID');
    }
  });

  it('clears the main model when the last model is removed and routing is off', () => {
    const config = {
      agent: { model: 'only/model', subagents: { default: 'only/model' } },
      model: { providers: { only: provider(['model']) } },
      router: { enabled: false, scenarios: { default: 'only/model' }, tokenSaver: { judge: 'only/model' } },
    };
    const plan = planModelRemoval(config, { providerId: 'only' });
    expect(plan.blocked).toBeNull();
    expect(plan.config.agent.model).toBe('');
    expect(plan.config.agent.subagents.default).toBe('inherit');
    expect(plan.config.router.scenarios).toEqual({});
    expect(plan.config.router.tokenSaver.judge).toBeUndefined();
    expect(plan.config.model.providers).toEqual({});
  });

  it('blocks removing the last model while smart routing needs it', () => {
    const config = {
      agent: { model: 'only/model' },
      model: { providers: { only: provider(['model']) } },
      router: { scenarios: { default: 'only/model' } },
    };
    const plan = planModelRemoval(config, { providerId: 'only' });
    expect(plan.blocked?.code).toBe('ROUTER_REQUIRES_MODEL');
  });

  it('keeps object-shaped references in their original shape', () => {
    const config = reportedConfig();
    config.router.scenarios.default = { id: 'HX API/qwen3.6-27b', provider: 'HX API', model: 'qwen3.6-27b' };
    const plan = planModelRemoval(config, { providerId: 'HX API' }, { replacement: 'deepseek/deepseek-chat' });
    expect(plan.config.router.scenarios.default).toEqual({ id: 'deepseek/deepseek-chat', provider: 'deepseek', model: 'deepseek-chat' });
  });

  it('handles pricing keys and model IDs that contain dots or slashes', () => {
    const config = {
      agent: { model: 'custom/anthropic/claude-4.6' },
      model: { providers: { custom: provider(['anthropic/claude-4.6']), other: provider(['gpt-4.1']) } },
      router: { stats: { modelPricing: { 'custom/anthropic/claude-4.6': { input: 1 }, 'other/gpt-4.1': { input: 2 } } } },
    };
    const plan = planModelRemoval(config, { providerId: 'custom', modelId: 'anthropic/claude-4.6' }, { replacement: 'other/gpt-4.1' });
    expect(plan.blocked).toBeNull();
    expect(plan.config.router.stats.modelPricing).toEqual({ 'other/gpt-4.1': { input: 2 } });
  });

  it('reports unknown targets', () => {
    expect(planModelRemoval(reportedConfig(), { providerId: 'nope' }).blocked?.code).toBe('NOT_FOUND');
    expect(planModelRemoval(reportedConfig(), { providerId: 'HX API', modelId: 'nope' }).blocked?.code).toBe('NOT_FOUND');
  });
});
