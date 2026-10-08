// @vitest-environment node
import { describe, expect, it } from 'vitest';
import { ModelProviderError } from '../../../src/model/index.js';
import { createRouterRuntime } from '../../../src/router/RouterRuntime.js';
import { parseRouterConfig } from '../../../src/router/config/parseRouterConfig.js';
import { planModelRemoval } from './modelReferences.js';

const provider = () => ({
  protocol: 'openai', url: 'https://example.test/v1', apiKey: 'fixture', models: { model: {} },
});

describe('model removal with dynamic routing', () => {
  it.each([
    { wholeProvider: false, isMainAgent: true, tokenSaverEnabled: true },
    { wholeProvider: true, isMainAgent: true, tokenSaverEnabled: true },
    { wholeProvider: false, isMainAgent: false, tokenSaverEnabled: true },
    { wholeProvider: true, isMainAgent: false, tokenSaverEnabled: true },
    { wholeProvider: false, isMainAgent: true, tokenSaverEnabled: false },
    { wholeProvider: true, isMainAgent: true, tokenSaverEnabled: false },
  ])('preserves main-model recovery and deduplicates actual attempts (%j)', async ({ wholeProvider, isMainAgent, tokenSaverEnabled }) => {
    const config = {
      agent: { model: 'main/model' },
      model: { providers: { main: provider(), tier: provider(), retired: provider() } },
      router: {
        enabled: true, scenarios: { default: 'main/model' },
        fallback: { default: ['retired/model', 'main/model', 'main/model'] },
        tokenSaver: { enabled: tokenSaverEnabled, judge: 'main/model', defaultTier: 'medium', tiers: { medium: { model: 'tier/model' } } },
        autoOrchestrate: { enabled: false },
        zeroUsageRetry: { enabled: false }, stats: { enabled: false },
      },
    };
    const plan = planModelRemoval(config, { providerId: 'retired', ...(wholeProvider ? {} : { modelId: 'model' }) });
    expect(plan.blocked).toBeNull();
    const parsed = parseRouterConfig(plan.config.router, plan.config.model);
    expect(parsed.diagnostics.filter(item => item.severity === 'fatal')).toEqual([]);
    const attempts = [];
    const modelRuntime = {
      complete: async () => ({ role: 'assistant', content: [{ type: 'text', text: '<tier>medium</tier>' }], finishReason: 'stop' }),
      async *stream(request) {
        attempts.push(`${request.provider}/${request.model}`);
        if (request.provider === 'tier') {
          throw new ModelProviderError({ provider: 'tier', protocol: 'openai', code: 'auth_error', message: 'Fixture tier unavailable', retryable: false });
        }
        yield { type: 'text_delta', text: 'Main-model fallback succeeded' };
        yield { type: 'usage', usage: { inputTokens: 10, outputTokens: 5 } };
        yield { type: 'message_end', finishReason: 'stop' };
      },
      getCapabilities: () => ({ supportsStreaming: true, supportsToolUse: true, maxContextTokens: 8192, maxOutputTokens: 1024 }),
      getMultimodal: () => ({ input: ['text'] }),
      getProviderProtocol: () => 'openai',
      getProviderBaseUrl: () => 'https://example.test/v1',
    };
    const router = createRouterRuntime({ ...parsed.config, transientRetry: { enabled: false } }, { modelRuntime });
    try {
      const events = [];
      for await (const event of router.stream({
        provider: 'main', model: 'model', messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
      }, { sessionId: 'removal-fallback', turnId: 'first', isMainAgent })) events.push(event);
      expect(attempts).toEqual(tokenSaverEnabled ? ['tier/model', 'main/model'] : ['main/model']);
      expect(events).toContainEqual({ type: 'text_delta', text: 'Main-model fallback succeeded' });
      expect(events.some(event => event.type === 'error')).toBe(false);
    } finally {
      await router.shutdown();
    }
  });
});
