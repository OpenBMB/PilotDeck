import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
