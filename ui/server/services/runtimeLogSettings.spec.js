import { describe, expect, it } from 'vitest';
import { normalizePilotDeckConfig, validatePilotDeckConfig } from './pilotdeckConfig.js';

describe('runtime log preferences within the existing configuration', () => {
  const config = {
    schemaVersion: 1, agent: { model: 'test/one' },
    model: { providers: { test: { protocol: 'openai', url: 'http://127.0.0.1:1/v1', apiKey: 'preserve-secret', models: { one: {} } } } },
    webui: { runtime: { serverPort: 3001 }, futureFeature: { enabled: true } },
  };
  it.each([undefined, '30', -1, 0, 8, {}, []])('falls back per field for invalid preference %j without invalidating a working model', value => {
    const input = structuredClone(config); input.webui.runtime.logRetentionDays = value;
    const result = normalizePilotDeckConfig(input);
    expect(result.webui.runtime.logRetentionDays).toBe(7);
    expect(validatePilotDeckConfig(result).valid).toBe(true);
    expect(result.model.providers.test.apiKey).toBe('preserve-secret');
    expect(result.webui.futureFeature).toEqual({ enabled: true });
  });
  it.each([1,3,7,30,90])('round-trips a supported %i-day setting', days => {
    const input = structuredClone(config); input.webui.runtime.logRetentionDays = days;
    const result = normalizePilotDeckConfig(input);
    expect(normalizePilotDeckConfig(result)).toEqual(result);
    expect(result.webui.runtime.logRetentionDays).toBe(days);
  });
});
