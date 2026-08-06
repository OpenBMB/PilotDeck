// @vitest-environment jsdom
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import LlmConfigurationStep from './LlmConfigurationStep';

const mocks = vi.hoisted(() => ({
  authenticatedFetch: vi.fn(),
  fetchProviderModels: vi.fn(),
  fetchRemoteDefaultModels: vi.fn(),
  translate: vi.fn((key: string) => key),
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({ t: mocks.translate }),
}));

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
      if (url === '/api/codex-auth/status') {
        return {
          ok: true,
          json: async () => ({
            ok: true,
            authenticated: true,
            importAvailable: false,
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
      expect(mocks.fetchRemoteDefaultModels).toHaveBeenCalledWith('openrouter');
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
      expect(screen.getByText(/Using bundled model list\. Local model list unavailable: ECONNREFUSED/)).toBeTruthy();
    });
  });

  it('uses DeepSeek bundled models until an API key is entered', async () => {
    render(<LlmConfigurationStep onSaved={vi.fn()} />);

    await waitFor(() => {
      expect(mocks.fetchRemoteDefaultModels).toHaveBeenCalledWith('openrouter');
    });
    mocks.fetchRemoteDefaultModels.mockClear();

    fireEvent.click(screen.getByRole('button', { name: /^DeepSeek$/ }));

    expect(mocks.fetchRemoteDefaultModels).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Fetch model list' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('combobox', { name: 'Model' }).textContent).toContain('DeepSeek V4 Pro');
  });

  it('uses Kimi bundled models until an API key is entered', async () => {
    render(<LlmConfigurationStep onSaved={vi.fn()} />);

    await waitFor(() => {
      expect(mocks.fetchRemoteDefaultModels).toHaveBeenCalledWith('openrouter');
    });
    mocks.fetchRemoteDefaultModels.mockClear();

    fireEvent.click(screen.getByRole('button', { name: /^Moonshot AI \(Kimi\)$/ }));

    expect(mocks.fetchRemoteDefaultModels).not.toHaveBeenCalled();
    expect(screen.getByRole('button', { name: 'Fetch model list' })).toHaveProperty('disabled', true);
    expect(screen.getByRole('combobox', { name: 'Model' }).textContent).toContain('Kimi K2.6');
  });

  it('uses subscription auth instead of an API key for Codex', async () => {
    mocks.fetchProviderModels.mockResolvedValueOnce([
      { id: 'gpt-5.6-sol', displayName: 'GPT-5.6 Sol' },
    ]);
    render(<LlmConfigurationStep onSaved={vi.fn()} />);

    fireEvent.click(screen.getByRole('button', { name: /^Codex \(ChatGPT subscription\)$/ }));

    expect(screen.queryByLabelText(/^API Key/)).toBeNull();
    await waitFor(() => {
      expect(mocks.fetchProviderModels).toHaveBeenCalledWith({
        providerId: 'codex',
        protocol: 'openai-responses',
        baseUrl: 'https://chatgpt.com/backend-api/codex',
        apiKey: '',
      });
    });
  });

  it('keeps Codex authenticated when the selected provider is selected again', async () => {
    render(<LlmConfigurationStep onSaved={vi.fn()} />);

    const codexButton = screen.getByRole('button', { name: /^Codex \(ChatGPT subscription\)$/ });
    fireEvent.click(codexButton);

    await waitFor(() => {
      expect(screen.getByRole('button', { name: 'Test Connection' })).toHaveProperty('disabled', false);
    });

    fireEvent.click(codexButton);

    expect(screen.getByRole('button', { name: 'Test Connection' })).toHaveProperty('disabled', false);
  });
});
