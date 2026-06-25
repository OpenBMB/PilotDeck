import { describe, expect, it } from 'vitest';
import { syncAgentModelWithRouter, validatePilotDeckConfig } from './pilotdeckConfig.js';

function configWithRouter(defaultRef) {
  return {
    schemaVersion: 1,
    agent: { model: 'main/gpt-test' },
    model: {
      providers: {
        main: {
          protocol: 'openai',
          url: 'https://example.com/v1',
          apiKey: 'sk-test',
          models: {
            'gpt-test': {},
          },
        },
      },
    },
    router: {
      scenarios: {
        default: defaultRef,
      },
    },
  };
}

describe('router model references', () => {
  it('rejects object-shaped router model refs', () => {
    const validation = validatePilotDeckConfig(
      configWithRouter({ id: 'main/gpt-test', provider: 'main', model: 'gpt-test' }),
    );

    expect(validation.valid).toBe(false);
    expect(validation.errors[0]).toContain('router.scenarios.default must be a provider/model string');
  });

  it('syncs router.scenarios.default as a provider/model string', () => {
    const config = configWithRouter({ id: 'old/model', provider: 'old', model: 'model' });

    syncAgentModelWithRouter(config);

    expect(config.router.scenarios.default).toBe('main/gpt-test');
  });
});
