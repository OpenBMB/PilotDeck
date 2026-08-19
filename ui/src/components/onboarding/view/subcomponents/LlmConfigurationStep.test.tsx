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
});
