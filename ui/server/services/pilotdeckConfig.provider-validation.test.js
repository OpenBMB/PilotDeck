import { describe, expect, it } from 'vitest';
import { validatePilotDeckConfig } from './pilotdeckConfig.js';

function validProvider(overrides = {}) {
  return {
    protocol: 'openai',
    url: 'https://example.com/v1',
    apiKey: 'sk-test',
    models: {
      'gpt-test': {},
    },
    ...overrides,
  };
}

describe('validatePilotDeckConfig provider validation', () => {
  it('rejects invalid unused providers because runtime parses all providers', () => {
    const validation = validatePilotDeckConfig({
      schemaVersion: 1,
      agent: { model: 'main/gpt-test' },
      model: {
        providers: {
          main: validProvider(),
          unused: validProvider({ apiKey: '' }),
        },
      },
    });

    expect(validation.valid).toBe(false);
    expect(validation.errors).toContain('model.providers.unused.apiKey is required');
  });
});
