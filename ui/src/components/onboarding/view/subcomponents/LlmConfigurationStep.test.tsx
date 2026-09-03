// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import LlmConfigurationStep from './LlmConfigurationStep';

const mocks = vi.hoisted(() => ({
  authenticatedFetch: vi.fn(),
  fetchProviderModels: vi.fn(),
  fetchRemoteDefaultModels: vi.fn(),
}));

vi.mock('react-i18next', async () => {
  const enOnboarding = (await import('../../../../i18n/locales/en/onboarding.json')).default as Record<string, unknown>;
  const lookupTranslation = (key: string) => {
    const value = key.split('.').reduce<unknown>(
      (current, segment) => (current && typeof current === 'object' ? (current as Record<string, unknown>)[segment] : undefined),
      enOnboarding,
    );
    return typeof value === 'string' ? value : key;
  };

  return {
    useTranslation: () => ({
      t: lookupTranslation,
      i18n: { language: 'en', changeLanguage: vi.fn() },
    }),
  };
});

vi.mock('../../../../utils/api', () => ({
  authenticatedFetch: mocks.authenticatedFetch,
}));

vi.mock('../../../../shared/modelListApi', () => ({
  fetchProviderModels: mocks.fetchProviderModels,
  fetchRemoteDefaultModels: mocks.fetchRemoteDefaultModels,
}));

describe('LlmConfigurationStep', () => {
  beforeEach(() => {
    mocks.authenticatedFetch.mockImplementation(async (url: string) => {
      if (url === '/api/config/provider') {
        return { ok: true, json: async () => ({ exists: false, provider: null }) };
      }
      if (url === '/api/v1/providers') {
        return {
          ok: true,
          json: async () => ({
            providers: [
              { id: 'anthropic', displayName: 'Anthropic', protocol: 'anthropic', endpoint: 'https://api.anthropic.com', logoUrl: '/onboarding/providers/anthropic.svg', requiresApiKey: true },
              { id: 'openai', displayName: 'OpenAI', protocol: 'openai', endpoint: 'https://api.openai.com/v1', logoUrl: '/onboarding/providers/openai.svg', requiresApiKey: true },
              { id: 'openai-responses', displayName: 'OpenAI (Responses API)', protocol: 'openai-responses', endpoint: 'https://api.openai.com/v1', logoUrl: '/onboarding/providers/openai.svg', requiresApiKey: true },
              { id: 'dashscope', displayName: '阿里云百炼 (DashScope)', protocol: 'openai', endpoint: 'https://dashscope.aliyuncs.com/compatible-mode/v1', logoUrl: '/onboarding/providers/bailian-color.svg', requiresApiKey: true },
              { id: 'deepseek', displayName: 'DeepSeek', protocol: 'openai', endpoint: 'https://api.deepseek.com/v1', logoUrl: '/onboarding/providers/deepseek-color.svg', requiresApiKey: true },
              { id: 'google', displayName: 'Google AI (Gemini)', protocol: 'google', endpoint: 'https://generativelanguage.googleapis.com', logoUrl: '/onboarding/providers/gemini-color.svg', requiresApiKey: true },
              { id: 'openrouter', displayName: 'OpenRouter', protocol: 'openai', endpoint: 'https://openrouter.ai/api/v1', logoUrl: '/onboarding/providers/openrouter-color.svg', requiresApiKey: true },
              { id: 'ollama', displayName: 'Ollama', protocol: 'openai', endpoint: 'http://localhost:11434/v1', logoUrl: '/onboarding/providers/ollama.svg', requiresApiKey: false },
              { id: 'minimax', displayName: 'MiniMax', protocol: 'openai', endpoint: 'https://api.minimaxi.com/v1', logoUrl: '/onboarding/providers/minimax-color.svg', requiresApiKey: true },
              { id: 'moonshot', displayName: 'Moonshot AI (Kimi)', protocol: 'openai', endpoint: 'https://api.moonshot.cn/v1', logoUrl: '/onboarding/providers/kimi.svg', requiresApiKey: true },
              { id: 'volc_ark', displayName: '火山方舟 (Volcano Ark)', protocol: 'openai', endpoint: 'https://ark.cn-beijing.volces.com/api/v3', logoUrl: '/onboarding/providers/volcengine-color.svg', requiresApiKey: true },
              { id: 'zhipu', displayName: '智谱 Z.AI', protocol: 'openai', endpoint: 'https://api.z.ai/api/paas/v4', logoUrl: '/onboarding/providers/zhipu-color.svg', requiresApiKey: true },
            ],
          }),
        };
      }
      return { ok: true, json: async () => ({}) };
    });
    mocks.fetchRemoteDefaultModels.mockResolvedValue([]);
    mocks.fetchProviderModels.mockResolvedValue([]);
  });

  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it('fetches Ollama models through the no-key provider path without also running catalog fallback', async () => {
    render(<LlmConfigurationStep onSaved={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^Ollama$/ }).querySelector('img')?.getAttribute('src'))
        .toBe('/onboarding/providers/ollama.svg');
    });

    mocks.fetchRemoteDefaultModels.mockClear();
    mocks.fetchProviderModels.mockClear();
    mocks.fetchProviderModels.mockRejectedValueOnce(new Error('ECONNREFUSED'));

    fireEvent.click(screen.getByRole('button', { name: /^Ollama$/ }));

    await waitFor(() => {
      expect(mocks.fetchProviderModels).toHaveBeenCalledTimes(1);
    });

    expect(mocks.fetchProviderModels).toHaveBeenCalledWith(expect.objectContaining({
      providerId: 'ollama',
      protocol: 'openai',
      baseUrl: 'http://localhost:11434/v1',
      apiKey: '',
    }));
    expect(mocks.fetchRemoteDefaultModels).not.toHaveBeenCalled();
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'qwen3:0.6b' })).toBeTruthy();
    });
    expect(screen.queryByText(/Using bundled model list/)).toBeNull();
    expect(screen.getByText('None')).toBeTruthy();
  });

  it('uses DeepSeek bundled models until an API key is entered', async () => {
    render(<LlmConfigurationStep onSaved={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^DeepSeek$/ })).toBeTruthy();
    });
    mocks.fetchRemoteDefaultModels.mockClear();

    fireEvent.click(screen.getByRole('button', { name: /^DeepSeek$/ }));

    expect(mocks.fetchRemoteDefaultModels).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Fetch model list' })).toBeNull();
    expect(screen.getByRole('button', { name: 'deepseek-v4-pro' })).toBeTruthy();
    expect(screen.getByText('None')).toBeTruthy();
  });

  it('uses Kimi bundled models until an API key is entered', async () => {
    render(<LlmConfigurationStep onSaved={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^DeepSeek$/ })).toBeTruthy();
    });
    mocks.fetchRemoteDefaultModels.mockClear();

    fireEvent.click(screen.getByRole('button', { name: /^Moonshot AI \(Kimi\)$/ }));

    expect(mocks.fetchRemoteDefaultModels).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Fetch model list' })).toBeNull();
    expect(screen.getByRole('button', { name: 'kimi-k2.6' })).toBeTruthy();
    expect(screen.getByText('None')).toBeTruthy();
  });

  it('keeps Test connection clickable before an API key is entered', async () => {
    render(<LlmConfigurationStep onSaved={vi.fn()} />);

    fireEvent.click(await screen.findByRole('button', { name: /^OpenRouter$/ }));
    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'anthropic/claude-sonnet-4.6' })).toBeTruthy();
    });

    const button = await screen.findByRole('button', { name: /Test connection/i });
    expect((button as HTMLButtonElement).disabled).toBe(false);

    fireEvent.click(button);

    expect(await screen.findByText('Select at least one model ID before testing the connection.')).toBeTruthy();
    expect(mocks.authenticatedFetch).not.toHaveBeenCalledWith(
      '/api/config/test-connection',
      expect.anything(),
    );

    fireEvent.click(await screen.findByRole('button', { name: 'anthropic/claude-sonnet-4.6' }));
    fireEvent.click(button);

    expect(await screen.findByText('Enter an API key before testing the connection.')).toBeTruthy();
  });

  it('moves models between available and selected lists', async () => {
    render(<LlmConfigurationStep onSaved={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^DeepSeek$/ })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: /^DeepSeek$/ }));

    const available = await screen.findByRole('button', { name: 'deepseek-v4-pro' });
    expect(screen.getByText('None')).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Continue' }).some(
      (button) => (button as HTMLButtonElement).disabled,
    )).toBe(true);

    fireEvent.click(available);

    expect(screen.queryByRole('button', { name: 'deepseek-v4-pro' })).toBeNull();
    expect(screen.getByText('deepseek-v4-pro')).toBeTruthy();
    expect(screen.queryByText('None')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Remove model ID' }));

    expect(screen.getByRole('button', { name: 'deepseek-v4-pro' })).toBeTruthy();
    expect(screen.getByText('None')).toBeTruthy();
  });

  it('tests only selected model IDs and enables continue after a successful test', async () => {
    render(<LlmConfigurationStep onSaved={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^DeepSeek$/ })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: /^DeepSeek$/ }));
    fireEvent.click(await screen.findByRole('button', { name: 'deepseek-v4-pro' }));
    mocks.fetchProviderModels.mockResolvedValue([
      { id: 'deepseek-v4-pro', displayName: 'DeepSeek V4 Pro' },
      { id: 'deepseek-v4-flash', displayName: 'DeepSeek V4 Flash' },
    ]);
    fireEvent.change(screen.getByLabelText(/API key/), { target: { value: 'sk-test' } });

    mocks.authenticatedFetch.mockImplementation(async (url: string) => {
      if (url === '/api/config/test-connection') {
        return {
          ok: true,
          json: async () => ({ ok: true, supportsImage: false, imageCheckSource: 'catalog' }),
        };
      }
      return { ok: true, json: async () => ({}) };
    });

    fireEvent.click(screen.getByRole('button', { name: /Test connection/i }));

    await waitFor(() => {
      const testCalls = mocks.authenticatedFetch.mock.calls.filter(([url]) => url === '/api/config/test-connection');
      expect(testCalls).toHaveLength(1);
      expect(JSON.parse(String(testCalls[0]?.[1]?.body))).toEqual(expect.objectContaining({
        model: 'deepseek-v4-pro',
      }));
    });

    expect(await screen.findByRole('button', { name: /Test passed/i })).toBeTruthy();
    expect(screen.getAllByRole('button', { name: 'Continue' }).every(
      (button) => !(button as HTMLButtonElement).disabled,
    )).toBe(true);
    expect(screen.getByRole('button', { name: 'deepseek-v4-flash' })).toBeTruthy();
  });

  it('places a typed model ID into the selected list on enter', async () => {
    render(<LlmConfigurationStep onSaved={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^DeepSeek$/ })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: /^DeepSeek$/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Add model ID' }));

    const input = screen.getByPlaceholderText('model-id');
    fireEvent.change(input, { target: { value: 'my-custom-model' } });
    fireEvent.keyDown(input, { key: 'Enter' });

    expect(screen.queryByPlaceholderText('model-id')).toBeNull();
    expect(screen.getByText('my-custom-model')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'my-custom-model' })).toBeNull();
    expect(screen.queryByText('None')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: 'Remove model ID' }));
    expect(screen.getByRole('button', { name: 'my-custom-model' })).toBeTruthy();
  });

  it('places add model first, filters available models, and can hide a candidate', async () => {
    render(<LlmConfigurationStep onSaved={vi.fn()} />);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: /^DeepSeek$/ })).toBeTruthy();
    });
    fireEvent.click(screen.getByRole('button', { name: /^DeepSeek$/ }));

    const addButton = await screen.findByRole('button', { name: 'Add model ID' });
    expect(addButton.parentElement?.firstElementChild).toBe(addButton);

    fireEvent.change(screen.getByPlaceholderText('Search model ID'), { target: { value: 'flash' } });
    expect(screen.queryByRole('button', { name: 'deepseek-v4-pro' })).toBeNull();
    expect(screen.getByRole('button', { name: 'deepseek-v4-flash' })).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText('Search model ID'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Remove from available deepseek-v4-pro' }));
    expect(screen.queryByRole('button', { name: 'deepseek-v4-pro' })).toBeNull();
    expect(screen.getByRole('button', { name: 'deepseek-v4-flash' })).toBeTruthy();
  });

  it('creates a passing connection-test record and binds it when saving', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    mocks.authenticatedFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url === '/api/config/provider') {
        return { ok: true, json: async () => ({ exists: false, provider: null }) };
      }
      if (url === '/api/config/test-connection') {
        return {
          ok: true,
          json: async () => ({ ok: true, supportsImage: true, imageCheckSource: 'probe' }),
        };
      }
      if (url === '/api/config') {
        if (init?.method === 'PUT') return { ok: true, json: async () => ({ raw: '' }) };
        return { ok: true, json: async () => ({ raw: '' }) };
      }
      return { ok: true, json: async () => ({}) };
    });

    render(<LlmConfigurationStep onSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /^Custom$/ }));
    fireEvent.change(screen.getByLabelText('Provider ID'), { target: { value: 'modelbest' } });
    fireEvent.change(screen.getByLabelText('Endpoint'), { target: { value: 'https://llm-center.modelbest.co/v1' } });
    fireEvent.change(screen.getByLabelText(/API key/), { target: { value: 'sk-test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add model ID' }));
    fireEvent.change(screen.getByPlaceholderText('model-id'), { target: { value: 'gpt-5.6-luna' } });
    fireEvent.keyDown(screen.getByPlaceholderText('model-id'), { key: 'Enter' });

    fireEvent.click(screen.getByRole('button', { name: /Test connection/i }));
    expect(await screen.findByRole('button', { name: /Test passed/i })).toBeTruthy();

    const continueButtons = screen.getAllByRole('button', { name: 'Continue' });
    fireEvent.click(continueButtons[continueButtons.length - 1]!);

    await waitFor(() => {
      const testCall = calls.find((call) => call.url === '/api/config/test-connection');
      expect(testCall).toBeTruthy();
      expect(JSON.parse(String(testCall?.init?.body))).toMatchObject({
        providerId: 'modelbest',
        providerType: 'openai',
        baseUrl: 'https://llm-center.modelbest.co/v1',
        model: 'gpt-5.6-luna',
      });
      const saveCall = calls.find((call) => call.url === '/api/config' && call.init?.method === 'PUT');
      expect(JSON.parse(String(saveCall?.init?.body)).raw).toContain('modelbest:');
      expect(JSON.parse(String(saveCall?.init?.body)).raw).toContain('gpt-5.6-luna');
    });
  });

  it('ignores a connection result when the form changes while testing', async () => {
    let resolveTest!: (response: Response) => void;
    const pendingTest = new Promise<Response>((resolve) => { resolveTest = resolve; });
    mocks.authenticatedFetch.mockImplementation(async (url: string) => {
      if (url === '/api/config/provider') {
        return { ok: true, json: async () => ({ exists: false, provider: null }) };
      }
      if (url === '/api/config/test-connection') return pendingTest;
      if (url === '/api/config') return { ok: true, json: async () => ({ raw: '' }) };
      return { ok: true, json: async () => ({}) };
    });

    render(<LlmConfigurationStep onSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /^Custom$/ }));
    fireEvent.change(screen.getByLabelText('Provider ID'), { target: { value: 'modelbest' } });
    fireEvent.change(screen.getByLabelText('Endpoint'), { target: { value: 'https://example.com/v1' } });
    fireEvent.change(screen.getByLabelText(/API key/), { target: { value: 'sk-old' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add model ID' }));
    fireEvent.change(screen.getByPlaceholderText('model-id'), { target: { value: 'gpt-5.6-luna' } });
    fireEvent.keyDown(screen.getByPlaceholderText('model-id'), { key: 'Enter' });

    fireEvent.click(screen.getByRole('button', { name: /Test connection/i }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Testing...' })).toBeTruthy());
    fireEvent.change(screen.getByLabelText(/API key/), { target: { value: 'sk-new' } });
    resolveTest({
      ok: true,
      json: async () => ({ ok: true, supportsImage: true, imageCheckSource: 'probe' }),
    } as Response);

    await waitFor(() => expect(screen.queryByRole('button', { name: /Test passed/i })).toBeNull());
    expect(screen.getAllByRole('button', { name: 'Continue' }).some(
      (button) => (button as HTMLButtonElement).disabled,
    )).toBe(true);
  });

  it('normalizes custom provider IDs to lowercase for testing and saving', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    mocks.authenticatedFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url === '/api/config/provider') {
        return { ok: true, json: async () => ({ exists: false, provider: null }) };
      }
      if (url === '/api/config/test-connection') {
        return {
          ok: true,
          json: async () => ({ ok: true, supportsImage: false, imageCheckSource: 'catalog' }),
        };
      }
      if (url === '/api/config') {
        if (init?.method === 'PUT') return { ok: true, json: async () => ({ raw: '' }) };
        return { ok: true, json: async () => ({ raw: '' }) };
      }
      return { ok: true, json: async () => ({}) };
    });

    render(<LlmConfigurationStep onSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /^Custom$/ }));
    fireEvent.change(screen.getByLabelText('Provider ID'), { target: { value: 'ModelBest' } });
    fireEvent.change(screen.getByLabelText('Endpoint'), { target: { value: 'https://example.com/v1' } });
    fireEvent.change(screen.getByLabelText(/API key/), { target: { value: 'sk-test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add model ID' }));
    fireEvent.change(screen.getByPlaceholderText('model-id'), { target: { value: 'gpt-5.6-luna' } });
    fireEvent.keyDown(screen.getByPlaceholderText('model-id'), { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: /Test connection/i }));

    expect(await screen.findByRole('button', { name: /Test passed/i })).toBeTruthy();
    const testCall = calls.find((call) => call.url === '/api/config/test-connection');
    expect(JSON.parse(String(testCall?.init?.body))).toMatchObject({ providerId: 'modelbest' });
    const continueButtons = screen.getAllByRole('button', { name: 'Continue' });
    fireEvent.click(continueButtons[continueButtons.length - 1]!);
    await waitFor(() => {
      const saveCall = calls.find((call) => call.url === '/api/config' && call.init?.method === 'PUT');
      const body = JSON.parse(String(saveCall?.init?.body));
      expect(body.raw).toContain('modelbest:');
      expect(body.raw).not.toContain('ModelBest:');
    });
  });

  it('keeps the test failed when manual image capability input is cancelled', async () => {
    const calls: string[] = [];
    mocks.authenticatedFetch.mockImplementation(async (url: string) => {
      calls.push(url);
      if (url === '/api/config/provider') {
        return { ok: true, json: async () => ({ exists: false, provider: null }) };
      }
      if (url === '/api/config/test-connection') {
        return {
          ok: true,
          json: async () => ({ ok: true, supportsImage: null, imageCheckSource: 'probe' }),
        };
      }
      return { ok: true, json: async () => ({ raw: '' }) };
    });

    render(<LlmConfigurationStep onSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /^Custom$/ }));
    fireEvent.change(screen.getByLabelText('Provider ID'), { target: { value: 'modelbest' } });
    fireEvent.change(screen.getByLabelText('Endpoint'), { target: { value: 'https://example.com/v1' } });
    fireEvent.change(screen.getByLabelText(/API key/), { target: { value: 'sk-test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add model ID' }));
    fireEvent.change(screen.getByPlaceholderText('model-id'), { target: { value: 'gpt-5.6-luna' } });
    fireEvent.keyDown(screen.getByPlaceholderText('model-id'), { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: /Test connection/i }));

    expect(await screen.findByRole('dialog')).toBeTruthy();
    const cancelButtons = screen.getAllByRole('button', { name: 'Cancel' });
    fireEvent.click(cancelButtons[cancelButtons.length - 1]!);
    expect(await screen.findByText(/cancelled/i)).toBeTruthy();
    expect(calls.filter((url) => url.includes('image-capabilities'))).toHaveLength(0);
    expect(screen.getAllByRole('button', { name: 'Continue' }).some(
      (button) => (button as HTMLButtonElement).disabled,
    )).toBe(true);
  });

  it('locks the form controls while save is in flight', async () => {
    let resolveSave!: (response: { ok: boolean; json: () => Promise<{ raw: string }> }) => void;
    const pendingSave = new Promise<{ ok: boolean; json: () => Promise<{ raw: string }> }>((resolve) => { resolveSave = resolve; });
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const onSaved = vi.fn();
    mocks.authenticatedFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url === '/api/config/provider') return { ok: true, json: async () => ({ exists: false, provider: null }) };
      if (url === '/api/config/test-connection') {
        return { ok: true, json: async () => ({ ok: true, supportsImage: false, imageCheckSource: 'catalog' }) };
      }
      if (url === '/api/config' && init?.method === 'PUT') return pendingSave;
      return { ok: true, json: async () => ({ raw: '' }) };
    });

    render(<LlmConfigurationStep onSaved={onSaved} />);
    fireEvent.click(screen.getByRole('button', { name: /^Custom$/ }));
    fireEvent.change(screen.getByLabelText('Provider ID'), { target: { value: 'modelbest' } });
    fireEvent.change(screen.getByLabelText('Endpoint'), { target: { value: 'https://example.com/v1' } });
    fireEvent.change(screen.getByLabelText(/API key/), { target: { value: 'sk-old' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add model ID' }));
    fireEvent.change(screen.getByPlaceholderText('model-id'), { target: { value: 'gpt-5.6-luna' } });
    fireEvent.keyDown(screen.getByPlaceholderText('model-id'), { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: /Test connection/i }));
    expect(await screen.findByRole('button', { name: /Test passed/i })).toBeTruthy();

    const continueButtons = screen.getAllByRole('button', { name: 'Continue' });
    fireEvent.click(continueButtons[continueButtons.length - 1]!);
    await waitFor(() => expect(calls.some((call) => call.url === '/api/config' && call.init?.method === 'PUT')).toBe(true));
    expect(screen.getByLabelText('Provider ID')).toHaveProperty('disabled', true);
    expect(screen.getByLabelText('Endpoint')).toHaveProperty('disabled', true);
    expect(screen.getByLabelText(/API key/)).toHaveProperty('disabled', true);
    expect(onSaved).not.toHaveBeenCalled();
    resolveSave({ ok: true, json: async () => ({ raw: '' }) });

    await waitFor(() => expect(onSaved).toHaveBeenCalledTimes(1));
    const saveCall = calls.find((call) => call.url === '/api/config' && call.init?.method === 'PUT');
    expect(JSON.parse(String(saveCall?.init?.body)).raw).toContain('modelbest:');
  });

  it('aborts an in-flight connection test when the form changes', async () => {
    let rejectTest!: (error: Error) => void;
    const pendingTest = new Promise<never>((_, reject) => { rejectTest = reject; });
    const signals: AbortSignal[] = [];
    mocks.authenticatedFetch.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === '/api/config/provider') return { ok: true, json: async () => ({ exists: false, provider: null }) };
      if (url === '/api/config/test-connection') {
        if (init?.signal) signals.push(init.signal);
        return pendingTest;
      }
      return { ok: true, json: async () => ({ raw: '' }) };
    });

    render(<LlmConfigurationStep onSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /^Custom$/ }));
    fireEvent.change(screen.getByLabelText('Provider ID'), { target: { value: 'modelbest' } });
    fireEvent.change(screen.getByLabelText('Endpoint'), { target: { value: 'https://example.com/v1' } });
    fireEvent.change(screen.getByLabelText(/API key/), { target: { value: 'sk-old' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add model ID' }));
    fireEvent.change(screen.getByPlaceholderText('model-id'), { target: { value: 'gpt-5.6-luna' } });
    fireEvent.keyDown(screen.getByPlaceholderText('model-id'), { key: 'Enter' });
    fireEvent.click(screen.getByRole('button', { name: /Test connection/i }));
    await waitFor(() => expect(signals).toHaveLength(1));
    fireEvent.change(screen.getByLabelText(/API key/), { target: { value: 'sk-new' } });
    await waitFor(() => expect(signals[0]?.aborted).toBe(true));
    rejectTest(Object.assign(new Error('aborted'), { name: 'AbortError' }));
  });

  it('rejects custom provider IDs reserved for catalog aliases', async () => {
    const calls: string[] = [];
    mocks.authenticatedFetch.mockImplementation(async (url: string) => {
      calls.push(url);
      if (url === '/api/config/provider') return { ok: true, json: async () => ({ exists: false, provider: null }) };
      return { ok: true, json: async () => ({ raw: '' }) };
    });

    render(<LlmConfigurationStep onSaved={vi.fn()} />);
    fireEvent.click(screen.getByRole('button', { name: /^Custom$/ }));
    fireEvent.change(screen.getByLabelText('Provider ID'), { target: { value: 'gemini' } });
    fireEvent.change(screen.getByLabelText('Endpoint'), { target: { value: 'https://example.com/v1' } });
    fireEvent.change(screen.getByLabelText(/API key/), { target: { value: 'sk-test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add model ID' }));
    fireEvent.change(screen.getByPlaceholderText('model-id'), { target: { value: 'gpt-5.6-luna' } });
    fireEvent.keyDown(screen.getByPlaceholderText('model-id'), { key: 'Enter' });

    expect(screen.getByText(/reserved/i)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: /Test connection/i }));
    expect(calls).not.toContain('/api/config/test-connection');
  });
});

