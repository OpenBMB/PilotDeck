import { readFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { WEB_SEARCH_PROVIDERS } from '../../../src/pilot/config/webSearchProviders.js';
import { afterEach, describe, expect, it } from 'vitest';
import {
  evaluateModelConfigurationState,
  getModelConfigurationState,
} from './modelConfigurationState.js';

const tempDirs = [];

afterEach(() => {
  delete process.env.PILOTDECK_CONFIG_PATH;
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function record(config, overrides = {}) {
  return {
    exists: true,
    configPath: null,
    raw: '',
    config,
    rawYaml: config,
    parseError: null,
    ...overrides,
  };
}

function configuredModel(overrides = {}) {
  return {
    agent: { model: 'custom/model-a' },
    model: {
      providers: {
        custom: {
          protocol: 'openai',
          url: 'https://example.com/v1',
          apiKey: 'secret',
          models: { 'model-a': {} },
        },
      },
    },
    ...overrides,
  };
}

function useTempConfig(contents) {
  const dir = mkdtempSync(join(tmpdir(), 'pilotdeck-model-state-'));
  tempDirs.push(dir);
  const configPath = join(dir, 'pilotdeck.yaml');
  if (contents !== null) writeFileSync(configPath, contents, 'utf8');
  process.env.PILOTDECK_CONFIG_PATH = configPath;
  return configPath;
}

describe('model configuration state', () => {
  it.each(WEB_SEARCH_PROVIDERS)('keeps the model ready after reloading an unconfigured %s search provider', provider => {
    const config = { ...configuredModel(), schemaVersion: 1, tools: { webSearch: {
      enabled: true, provider, providers: { [provider]: {} },
    } } };
    const path = useTempConfig(JSON.stringify(config));
    const before = readFileSync(path, 'utf8');
    expect(getModelConfigurationState({ env: {} })).toMatchObject({ state: 'ready', modelRef: 'custom/model-a' });
    expect(getModelConfigurationState({ env: {} })).toMatchObject({ state: 'ready', modelRef: 'custom/model-a' });
    expect(readFileSync(path, 'utf8')).toBe(before);
  });

  it('distinguishes a saved empty pool from onboarding and restores readiness after adding a model', () => {
    const config = configuredModel();
    config.schemaVersion = 1;
    config.agent.model = '';
    config.model.providers.custom.models = {};
    const path = useTempConfig(JSON.stringify(config));
    expect(getModelConfigurationState({ env: {} }).state).toBe('empty');
    config.model.providers = {};
    writeFileSync(path, JSON.stringify(config));
    expect(getModelConfigurationState({ env: {} }).state).toBe('empty');
    writeFileSync(path, JSON.stringify({ ...configuredModel(), schemaVersion: 1 }));
    expect(getModelConfigurationState({ env: {} }).state).toBe('ready');
  });

  it('excludes an empty provider from runtime without invalidating another model', () => {
    const config = configuredModel();
    config.schemaVersion = 1;
    config.model.providers.empty = { protocol: 'openai', url: 'https://example.test/v1', apiKey: 'key', models: {} };
    useTempConfig(JSON.stringify(config));
    expect(getModelConfigurationState({ env: {} }).state).toBe('ready');
  });

  it('quarantines an invalid unused provider without rewriting the file or changing the primary model', () => {
    const config = configuredModel();
    config.schemaVersion = 1;
    config.model.providers.test = { protocol: 'openai', url: 'aaa', apiKey: 'bad-key', models: { bad: {} } };
    const path = useTempConfig(JSON.stringify(config));
    const before = readFileSync(path, 'utf8');
    expect(getModelConfigurationState({ env: {} })).toMatchObject({ state: 'ready', modelRef: 'custom/model-a', providerErrors: { test: expect.any(String) } });
    expect(readFileSync(path, 'utf8')).toBe(before);
    config.agent.model = 'test/bad';
    writeFileSync(path, JSON.stringify(config));
    expect(getModelConfigurationState({ env: {} }).state).toBe('invalid');
  });

  it('does not create a config file while detecting first-run state', () => {
    const configPath = useTempConfig(null);

    expect(getModelConfigurationState()).toMatchObject({
      state: 'needs_configuration',
      reason: 'missing_config',
    });
    expect(existsSync(configPath)).toBe(false);
  });

  it('distinguishes a missing file from a file with no selected model', () => {
    expect(evaluateModelConfigurationState(record({}, { exists: false }))).toMatchObject({
      state: 'needs_configuration',
      reason: 'missing_config',
    });
    expect(evaluateModelConfigurationState(record({ agent: { model: '' } }))).toMatchObject({
      state: 'needs_configuration',
      reason: 'missing_model',
    });
  });

  it('recognizes the historical bootstrap placeholder', () => {
    const config = {
      agent: { model: '_placeholder/_placeholder' },
      model: {
        providers: {
          _placeholder: {
            protocol: 'openai',
            url: 'http://127.0.0.1:1/v1',
            apiKey: 'PLACEHOLDER_RUN_ONBOARDING_TO_REPLACE',
            models: { _placeholder: {} },
          },
        },
      },
    };

    expect(evaluateModelConfigurationState(record(config))).toMatchObject({
      state: 'needs_configuration',
      reason: 'legacy_placeholder',
    });
  });

  it('requires credentials for remote providers but not Ollama', () => {
    const remote = configuredModel();
    delete remote.model.providers.custom.apiKey;
    expect(evaluateModelConfigurationState(record(remote), {
      env: {},
      validateGateway: false,
    })).toMatchObject({
      state: 'needs_configuration',
      reason: 'missing_credential',
    });

    const ollama = {
      agent: { model: 'ollama/qwen3:0.6b' },
      model: {
        providers: {
          ollama: {
            protocol: 'openai',
            url: 'http://localhost:11434/v1',
            models: { 'qwen3:0.6b': {} },
          },
        },
      },
    };
    expect(evaluateModelConfigurationState(record(ollama), {
      env: {},
      validateGateway: false,
    })).toMatchObject({ state: 'ready', modelRef: 'ollama/qwen3:0.6b' });
  });

  it('reports broken model references as invalid configuration', () => {
    const config = configuredModel({ agent: { model: 'custom/missing' } });
    expect(evaluateModelConfigurationState(record(config), {
      validateGateway: false,
    })).toMatchObject({
      state: 'invalid',
      errors: [expect.stringContaining('doesn\'t resolve')],
    });
  });

  it('uses the Gateway parser as the final readiness check', () => {
    useTempConfig(`
schemaVersion: 1
agent:
  model: custom/model-a
  maxContextTokens: 0
model:
  providers:
    custom:
      protocol: openai
      url: https://example.com/v1
      apiKey: secret
      models:
        model-a: {}
`);

    expect(getModelConfigurationState({ env: {} })).toMatchObject({
      state: 'invalid',
      errors: [expect.stringContaining('agent.maxContextTokens')],
    });
  });

  it('uses the Gateway model environment override when deciding readiness', () => {
    useTempConfig(`
schemaVersion: 1
agent:
  model: ''
model:
  providers:
    custom:
      protocol: openai
      url: https://example.com/v1
      apiKey: secret
      models:
        model-a: {}
`);

    expect(getModelConfigurationState({
      env: { PILOT_AGENT_MODEL: 'custom/model-a' },
    })).toMatchObject({
      state: 'ready',
      modelRef: 'custom/model-a',
    });
  });

  it('returns ready only for a Gateway-parseable configuration', () => {
    useTempConfig(`
schemaVersion: 1
agent:
  model: custom/model-a
model:
  providers:
    custom:
      protocol: openai
      url: https://example.com/v1
      apiKey: secret
      models:
        model-a: {}
`);

    expect(getModelConfigurationState({ env: {} })).toMatchObject({
      state: 'ready',
      modelRef: 'custom/model-a',
    });
  });
});
