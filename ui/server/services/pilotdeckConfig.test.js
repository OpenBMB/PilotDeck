import { describe, expect, it } from 'vitest';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { validatePilotDeckConfig, writePilotDeckConfig } from './pilotdeckConfig.js';

function validConfig(overrides = {}) {
    return {
        agent: { model: 'new/m' },
        model: {
            providers: {
                new: {
                    protocol: 'openai',
                    url: 'https://example.test/v1',
                    apiKey: 'key',
                    models: { m: {} },
                },
            },
        },
        ...overrides,
    };
}

describe('validatePilotDeckConfig gateway validation', () => {
    it('rejects non-object gateway config', () => {
        const validation = validatePilotDeckConfig({ gateway: true });

        expect(validation.valid).toBe(false);
        expect(validation.errors).toContain('gateway: gateway config must be an object.');
    });

    it('rejects unsupported gateway bindAddress', () => {
        const validation = validatePilotDeckConfig({
            gateway: {
                bindAddress: '0.0.0.0',
            },
        });

        expect(validation.valid).toBe(false);
        expect(validation.errors).toContain('gateway.bindAddress: gateway.bindAddress must be 127.0.0.1 in the first phase.');
    });

    it('warns when gateway.tokenPath is configured', () => {
        const validation = validatePilotDeckConfig({
            gateway: {
                tokenPath: '/tmp/token',
            },
        });

        expect(validation.valid).toBe(true);
        expect(validation.warnings).toContain(
            'gateway.tokenPath: gateway.tokenPath is no longer configurable; the gateway token is stored under PilotHome.',
        );
    });

    it('accepts valid gateway config', () => {
        const validation = validatePilotDeckConfig({
            gateway: {
                bindAddress: '127.0.0.1',
            },
        });

        expect(validation.valid).toBe(true);
        expect(validation.errors).toEqual([]);
    });
});

describe('validatePilotDeckConfig router auto-orchestrate refs', () => {
    it('rejects unknown mainAgentModel provider refs', () => {
        const validation = validatePilotDeckConfig(validConfig({
            router: {
                enabled: true,
                autoOrchestrate: {
                    mainAgentModel: 'old/m',
                },
            },
        }));

        expect(validation.valid).toBe(false);
        expect(validation.errors).toContain(
            'router.autoOrchestrate.mainAgentModel="old/m" doesn\'t resolve to a configured provider/model',
        );
    });

    it('rejects unknown subagentModel provider refs', () => {
        const validation = validatePilotDeckConfig(validConfig({
            router: {
                enabled: true,
                autoOrchestrate: {
                    subagentModel: 'old/m',
                },
            },
        }));

        expect(validation.valid).toBe(false);
        expect(validation.errors).toContain(
            'router.autoOrchestrate.subagentModel="old/m" doesn\'t resolve to a configured provider/model',
        );
    });

    it('repairs auto-orchestrate refs orphaned by provider deletion before saving', async () => {
        const previousConfigPath = process.env.PILOTDECK_CONFIG_PATH;
        const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pilotdeck-config-'));
        process.env.PILOTDECK_CONFIG_PATH = path.join(tempDir, 'pilotdeck.yaml');

        try {
            const result = await writePilotDeckConfig(validConfig({
                router: {
                    enabled: true,
                    autoOrchestrate: {
                        mainAgentModel: 'old/main',
                        subagentModel: 'old/sub',
                    },
                },
            }));

            expect(result.validation.valid).toBe(true);
            expect(result.config.router.autoOrchestrate.mainAgentModel).toBe('new/m');
            expect(result.config.router.autoOrchestrate.subagentModel).toBe('new/m');
        } finally {
            if (previousConfigPath === undefined) {
                delete process.env.PILOTDECK_CONFIG_PATH;
            } else {
                process.env.PILOTDECK_CONFIG_PATH = previousConfigPath;
            }
            await fs.rm(tempDir, { recursive: true, force: true });
        }
    });
});
