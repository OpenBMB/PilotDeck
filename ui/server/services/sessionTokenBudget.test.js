import { afterEach, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({ live: vi.fn(), history: vi.fn(), project: vi.fn() }));
vi.mock('../pilotdeck-bridge.js', () => ({
    getSessionTokenBudget: mocks.live,
    withPilotDeckGatewayReadRetry: operation => operation({ readSessionMessages: mocks.history }),
}));
vi.mock('../projects.js', () => ({ extractProjectDirectory: mocks.project }));
import { readSessionTokenBudget } from './sessionTokenBudget.js';

afterEach(() => vi.resetAllMocks());
const unknown = { used: 0, total: 0, unknown: true };
const restored = { used: 50540, total: 1048576, source: 'history' };

it('restores a cold Web process budget from the existing history reader', async () => {
    mocks.live.mockReturnValue(unknown);
    mocks.project.mockResolvedValue('/fixture');
    mocks.history.mockResolvedValue({ tokenUsage: restored });
    expect(await readSessionTokenBudget('fixture', 'web:s')).toEqual(restored);
    expect(mocks.project).toHaveBeenCalledWith('fixture');
    expect(mocks.history).toHaveBeenCalledWith({ sessionKey: 'web:s', projectKey: '/fixture', direction: 'backward', limit: 1 });
});

it('keeps a genuinely unavailable budget unknown', async () => {
    mocks.live.mockReturnValue(unknown);
    mocks.history.mockResolvedValue({});
    expect(await readSessionTokenBudget('fixture', 'web:new')).toEqual(unknown);
});

it('uses live budgets without reading history or resolving the project', async () => {
    mocks.live.mockReturnValue(restored);
    expect(await readSessionTokenBudget('fixture', 'web:s')).toEqual(restored);
    expect(mocks.history).not.toHaveBeenCalled();
    expect(mocks.project).not.toHaveBeenCalled();
});

it('does not replace a live update published during the disk read', async () => {
    const live = { used: 60000, total: 1048576 };
    mocks.live.mockReturnValueOnce(unknown).mockReturnValue(live);
    mocks.history.mockResolvedValue({ tokenUsage: restored });
    expect(await readSessionTokenBudget('fixture', 'web:s')).toEqual(live);
});
