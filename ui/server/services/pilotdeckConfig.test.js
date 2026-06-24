import { describe, expect, it } from 'vitest';
import { applyConfigToProcessEnv, buildRuntimeEnv } from './pilotdeckConfig.js';

describe('buildRuntimeEnv proxy config', () => {
    it('exports proxy URL and no-proxy list when both are configured', () => {
        const env = buildRuntimeEnv({
            proxy: {
                url: 'http://proxy.example:8080',
                noProxy: 'localhost,127.0.0.1,internal.example',
            },
        });

        expect(env.HTTPS_PROXY).toBe('http://proxy.example:8080');
        expect(env.https_proxy).toBe('http://proxy.example:8080');
        expect(env.NO_PROXY).toBe('localhost,127.0.0.1,internal.example');
        expect(env.no_proxy).toBe('localhost,127.0.0.1,internal.example');
    });

    it('does not export no-proxy env vars when no-proxy is blank', () => {
        const env = buildRuntimeEnv({
            proxy: {
                url: 'http://proxy.example:8080',
                noProxy: '   ',
            },
        });

        expect(env.HTTPS_PROXY).toBe('http://proxy.example:8080');
        expect(env.https_proxy).toBe('http://proxy.example:8080');
        expect(env.NO_PROXY).toBeUndefined();
        expect(env.no_proxy).toBeUndefined();
    });

    it('does not export no-proxy env vars without a proxy URL', () => {
        const env = buildRuntimeEnv({
            proxy: {
                noProxy: 'internal.example',
            },
        });

        expect(env.HTTPS_PROXY).toBeUndefined();
        expect(env.https_proxy).toBeUndefined();
        expect(env.NO_PROXY).toBeUndefined();
        expect(env.no_proxy).toBeUndefined();
    });

    it('removes previously applied proxy env vars when proxy config is removed', () => {
        const keys = ['HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy'];
        const previous = new Map(keys.map((key) => [key, process.env[key]]));
        try {
            keys.forEach((key) => delete process.env[key]);

            applyConfigToProcessEnv({
                proxy: {
                    url: 'http://proxy.example:8080',
                    noProxy: 'internal.example',
                },
            });
            expect(process.env.HTTPS_PROXY).toBe('http://proxy.example:8080');
            expect(process.env.NO_PROXY).toBe('internal.example');

            applyConfigToProcessEnv({});
            expect(process.env.HTTPS_PROXY).toBeUndefined();
            expect(process.env.https_proxy).toBeUndefined();
            expect(process.env.NO_PROXY).toBeUndefined();
            expect(process.env.no_proxy).toBeUndefined();
        } finally {
            for (const [key, value] of previous) {
                if (value === undefined) {
                    delete process.env[key];
                } else {
                    process.env[key] = value;
                }
            }
        }
    });

    it('restores pre-existing proxy env vars after config-managed proxy is removed', () => {
        const keys = ['HTTPS_PROXY', 'https_proxy', 'NO_PROXY', 'no_proxy'];
        const previous = new Map(keys.map((key) => [key, process.env[key]]));
        try {
            process.env.HTTPS_PROXY = 'http://env-proxy.example:8080';
            process.env.https_proxy = 'http://env-proxy.example:8080';
            process.env.NO_PROXY = 'env.internal';
            process.env.no_proxy = 'env.internal';

            applyConfigToProcessEnv({
                proxy: {
                    url: 'http://config-proxy.example:8080',
                    noProxy: 'config.internal',
                },
            });
            expect(process.env.HTTPS_PROXY).toBe('http://config-proxy.example:8080');
            expect(process.env.NO_PROXY).toBe('config.internal');

            applyConfigToProcessEnv({});
            expect(process.env.HTTPS_PROXY).toBe('http://env-proxy.example:8080');
            expect(process.env.https_proxy).toBe('http://env-proxy.example:8080');
            expect(process.env.NO_PROXY).toBe('env.internal');
            expect(process.env.no_proxy).toBe('env.internal');
        } finally {
            for (const [key, value] of previous) {
                if (value === undefined) {
                    delete process.env[key];
                } else {
                    process.env[key] = value;
                }
            }
        }
    });
});
