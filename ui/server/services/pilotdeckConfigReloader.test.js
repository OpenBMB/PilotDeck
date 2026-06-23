import { afterEach, describe, expect, it, vi } from 'vitest';
import { reinstallGlobalProxy } from '../utils/proxy.js';
import { reloadPilotDeckConfig } from './pilotdeckConfigReloader.js';

vi.mock('../utils/proxy.js', () => ({
    reinstallGlobalProxy: vi.fn(),
}));

vi.mock('./memoryService.js', () => ({
    closeMemoryServices: vi.fn(),
    startMemoryScheduler: vi.fn(),
}));

describe('reloadPilotDeckConfig proxy reload', () => {
    const proxyKeys = ['PILOTDECK_PROXY', 'HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'NO_PROXY', 'no_proxy'];
    const previousEnv = new Map(proxyKeys.map((key) => [key, process.env[key]]));

    afterEach(() => {
        vi.clearAllMocks();
        for (const [key, value] of previousEnv) {
            if (value === undefined) {
                delete process.env[key];
            } else {
                process.env[key] = value;
            }
        }
    });

    it('reinstalls the UI server proxy dispatcher after applying config env', async () => {
        proxyKeys.forEach((key) => delete process.env[key]);

        await reloadPilotDeckConfig({
            proxy: {
                url: 'http://proxy.example:8080',
                noProxy: 'internal.example',
            },
        });

        expect(process.env.HTTPS_PROXY).toBe('http://proxy.example:8080');
        expect(process.env.NO_PROXY).toBe('internal.example');
        expect(reinstallGlobalProxy).toHaveBeenCalledWith('http://proxy.example:8080');
    });

    it('removes the UI server proxy dispatcher when config and env do not define a proxy', async () => {
        proxyKeys.forEach((key) => delete process.env[key]);
        await reloadPilotDeckConfig({
            proxy: {
                url: 'http://proxy.example:8080',
                noProxy: 'internal.example',
            },
        });

        vi.clearAllMocks();
        await reloadPilotDeckConfig({});

        expect(process.env.HTTPS_PROXY).toBeUndefined();
        expect(process.env.NO_PROXY).toBeUndefined();
        expect(reinstallGlobalProxy).toHaveBeenCalledWith(undefined);
    });

    it('falls back to pre-existing env proxy after config proxy is removed', async () => {
        proxyKeys.forEach((key) => delete process.env[key]);
        process.env.HTTPS_PROXY = 'http://env-proxy.example:8080';

        await reloadPilotDeckConfig({
            proxy: {
                url: 'http://config-proxy.example:8080',
            },
        });

        vi.clearAllMocks();
        await reloadPilotDeckConfig({});

        expect(process.env.HTTPS_PROXY).toBe('http://env-proxy.example:8080');
        expect(reinstallGlobalProxy).toHaveBeenCalledWith('http://env-proxy.example:8080');
    });
});
