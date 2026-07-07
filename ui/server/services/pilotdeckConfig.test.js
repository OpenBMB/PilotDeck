import { describe, expect, it } from 'vitest';
import { sanitizeProviderCredentials, validatePilotDeckConfig } from './pilotdeckConfig.js';

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

    it('accepts Ollama providers without an apiKey', () => {
        const validation = validatePilotDeckConfig({
            agent: { model: 'ollama/qwen3:0.6b' },
            model: {
                providers: {
                    ollama: {
                        protocol: 'openai',
                        url: 'http://localhost:11434/v1',
                        models: {
                            'qwen3:0.6b': {},
                        },
                    },
                },
            },
        });

        expect(validation.valid).toBe(true);
        expect(validation.errors).toEqual([]);
    });

    it('removes blank Ollama apiKeys during sanitization', () => {
        const config = sanitizeProviderCredentials({
            model: {
                providers: {
                    ollama: {
                        protocol: 'openai',
                        url: ' http://localhost:11434/v1 ',
                        apiKey: '   ',
                        models: {
                            'qwen3:0.6b': {},
                        },
                    },
                },
            },
        });

        expect(config.model.providers.ollama).not.toHaveProperty('apiKey');
        expect(config.model.providers.ollama.url).toBe('http://localhost:11434/v1');
    });
});
