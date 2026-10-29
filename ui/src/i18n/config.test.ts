// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { parse, stringify } from 'yaml';
import i18n from './config.js';

const mocks = vi.hoisted(() => ({ authenticatedFetch: vi.fn() }));

vi.unmock('react-i18next');
vi.mock('../utils/api', () => ({ authenticatedFetch: mocks.authenticatedFetch }));

const emptyConfig = {
  schemaVersion: 1,
  agent: { model: '' },
  model: { providers: {} },
  alwaysOn: { projects: {} },
};

beforeEach(async () => {
  mocks.authenticatedFetch.mockResolvedValue({ ok: false });
  await changeLanguage('en');
  mocks.authenticatedFetch.mockReset();
  localStorage.clear();
});

async function changeLanguage(language: string) {
  await i18n.changeLanguage(language);
  // The language listener saves asynchronously, outside changeLanguage's promise.
  await new Promise(resolve => setTimeout(resolve, 0));
}

describe('language configuration persistence', () => {
  it.each(['en', 'zh-CN'])('keeps %s local when the config API returns defaults for a missing file', async (language) => {
    mocks.authenticatedFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ exists: false, raw: stringify(emptyConfig) }),
    });

    await changeLanguage(language);

    expect(localStorage.getItem('userLanguage')).toBe(language);
    expect(mocks.authenticatedFetch.mock.calls).toEqual([['/api/config']]);
  });

  it('does not save a failed configuration response', async () => {
    mocks.authenticatedFetch.mockResolvedValue({
      ok: false,
      json: async () => ({ exists: true, raw: stringify(emptyConfig) }),
    });

    await changeLanguage('zh-CN');

    expect(mocks.authenticatedFetch.mock.calls).toEqual([['/api/config']]);
  });

  it('still updates the language of an existing empty model pool', async () => {
    mocks.authenticatedFetch.mockResolvedValue({
      ok: true,
      json: async () => ({ exists: true, raw: stringify(emptyConfig) }),
    });

    await changeLanguage('zh-CN');

    expect(mocks.authenticatedFetch).toHaveBeenCalledTimes(2);
    const [url, options] = mocks.authenticatedFetch.mock.calls[1]!;
    expect(url).toBe('/api/config');
    expect(options.method).toBe('PUT');
    expect(parse(JSON.parse(options.body).raw)).toEqual({
      ...emptyConfig,
      alwaysOn: { ...emptyConfig.alwaysOn, language: 'zh-CN' },
    });
  });

  it('does not rewrite an existing config whose language already matches', async () => {
    mocks.authenticatedFetch.mockResolvedValue({
      ok: true,
      json: async () => ({
        exists: true,
        raw: stringify({ ...emptyConfig, alwaysOn: { language: 'zh-CN' } }),
      }),
    });

    await changeLanguage('zh-CN');

    expect(mocks.authenticatedFetch.mock.calls).toEqual([['/api/config']]);
  });
});
