import { describe, expect, it } from 'vitest';
import { webSearchConfigForProvider } from './pilotDeckConfigForm';

describe('PilotDeckConfigTab Web Search settings', () => {
  it('keeps Web Search disabled when switching providers', () => {
    expect(webSearchConfigForProvider(
      { enabled: false },
      'tavily',
      'https://api.z.ai/api/paas/v4/web_search',
    )).toEqual({ enabled: false, provider: 'tavily' });
  });

  it('keeps the backwards-compatible implicit enabled state', () => {
    expect(webSearchConfigForProvider(
      {},
      'glm',
      'https://api.z.ai/api/paas/v4/web_search',
    )).toEqual({
      provider: 'glm',
      endpoint: 'https://api.z.ai/api/paas/v4/web_search',
    });
  });
});
