import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  authenticatedFetch: vi.fn(),
}));

vi.mock('../utils/api', () => ({
  authenticatedFetch: mocks.authenticatedFetch,
}));

const provider = {
  id: 'openai',
  displayName: 'OpenAI',
  protocol: 'openai-responses',
  defaultUrl: 'https://api.openai.com/v1',
  models: [],
};

function catalogResponse() {
  return new Response(JSON.stringify({ providers: [provider], updatedAt: 1, errors: {} }), {
    status: 200,
    headers: { 'content-type': 'application/json' },
  });
}

describe('refreshModelCatalog', () => {
  beforeEach(() => {
    vi.resetModules();
    mocks.authenticatedFetch.mockReset();
  });

  it('restores the server cache before requesting a refresh', async () => {
    mocks.authenticatedFetch
      .mockResolvedValueOnce(catalogResponse())
      .mockResolvedValueOnce(catalogResponse());
    const { refreshModelCatalog } = await import('./useModelCatalog');

    const providers = await refreshModelCatalog();

    expect(providers).toEqual([provider]);
    expect(mocks.authenticatedFetch).toHaveBeenNthCalledWith(
      1,
      '/api/config/model-catalog',
      expect.objectContaining({ signal: expect.any(AbortSignal) }),
    );
    expect(mocks.authenticatedFetch).toHaveBeenNthCalledWith(
      2,
      '/api/config/model-catalog',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ force: false }),
      }),
    );
  });

  it('runs a forced request after an in-flight normal refresh', async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    mocks.authenticatedFetch
      .mockImplementationOnce(async () => {
        await blocked;
        return catalogResponse();
      })
      .mockResolvedValueOnce(catalogResponse())
      .mockResolvedValueOnce(catalogResponse())
      .mockResolvedValueOnce(catalogResponse());
    const { refreshModelCatalog } = await import('./useModelCatalog');

    const normal = refreshModelCatalog();
    await vi.waitFor(() => expect(mocks.authenticatedFetch).toHaveBeenCalledTimes(1));
    const forced = refreshModelCatalog(true);
    await Promise.resolve();
    expect(mocks.authenticatedFetch).toHaveBeenCalledTimes(1);

    release();
    await Promise.all([normal, forced]);

    expect(mocks.authenticatedFetch).toHaveBeenCalledTimes(4);
    expect(mocks.authenticatedFetch.mock.calls[1]?.[1]).toMatchObject({ method: 'POST', body: JSON.stringify({ force: false }) });
    expect(mocks.authenticatedFetch.mock.calls[3]?.[1]).toMatchObject({ method: 'POST', body: JSON.stringify({ force: true }) });
  });
});
