import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    applyConfigToProcessEnv,
    buildDefaultPilotDeckConfig,
    buildMemoryLlmOptions,
    buildRuntimeEnv,
    readPilotDeckConfigFile,
    resolveConfiguredProviderApiKey,
    resolveModel,
    sanitizeProviderCredentials,
    serializePilotDeckConfigResponse,
    validatePilotDeckConfig,
    writePilotDeckConfig,
} from './pilotdeckConfig.js';

const tempDirs = [];

afterEach(() => {
    vi.unstubAllEnvs();
    delete process.env.PILOTDECK_CONFIG_PATH;
    for (const dir of tempDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

function useTempConfig(contents, filename = 'pilotdeck.yaml') {
    const dir = mkdtempSync(join(tmpdir(), 'pilotdeck-config-test-'));
    tempDirs.push(dir);
    const configPath = join(dir, filename);
    if (contents !== null) {
        writeFileSync(configPath, contents, 'utf8');
    }
    process.env.PILOTDECK_CONFIG_PATH = configPath;
    return configPath;
}

describe('readPilotDeckConfigFile fallback behavior', () => {
    it('uses built-in Office preview by default', () => {
        expect(buildDefaultPilotDeckConfig().webui.officePreview).toEqual({
            service: 'builtin',
            binaryPath: '',
        });
    });

    it('returns defaults when the config file is missing', () => {
        const configPath = useTempConfig(null);

        const record = readPilotDeckConfigFile();

        expect(record.exists).toBe(false);
        expect(record.configPath).toBe(configPath);
        expect(record.raw).toBe('');
        expect(record.rawYaml).toEqual({});
        expect(record.parseError).toBeNull();
        expect(record.config.schemaVersion).toBe(1);
        expect(record.config.webui.officePreview.service).toBe('builtin');
    });

    it('reads and normalizes valid YAML', () => {
        useTempConfig('schemaVersion: 1\nmodel:\n  providers: {}\n');

        const record = readPilotDeckConfigFile();

        expect(record.exists).toBe(true);
        expect(record.parseError).toBeNull();
        expect(record.rawYaml).toMatchObject({ schemaVersion: 1, model: { providers: {} } });
        expect(record.config.model.providers).toEqual({});
        expect(record.config.memory.enabled).toBe(true);
    });

    it('keeps raw YAML and falls back to defaults when YAML is invalid', () => {
        const raw = 'schemaVersion: 1\nmodel:\n  providers: [\n';
        useTempConfig(raw);

        const record = readPilotDeckConfigFile();

        expect(record.exists).toBe(true);
        expect(record.raw).toBe(raw);
        expect(record.rawYaml).toBeNull();
        expect(record.parseError).toEqual(expect.any(String));
        expect(record.config.schemaVersion).toBe(1);
        expect(record.config.model.providers).toEqual({});
    });

    it('serializes a safe revision token with the masked disk snapshot', () => {
        useTempConfig('schemaVersion: 1\nadapters:\n  feishu:\n    appSecret: super-secret\n');

        const response = serializePilotDeckConfigResponse(readPilotDeckConfigFile());

        expect(response.revision).toMatch(/^[a-f0-9]{64}$/);
        expect(response.raw).toContain('appSecret: "********"');
        expect(response.raw).not.toContain('super-secret');
    });
});

describe('validatePilotDeckConfig gateway validation', () => {
    it('uses catalog default URLs for memory and runtime settings', () => {
        const config = {
            agent: { model: 'deepseek/model-a' },
            model: {
                providers: {
                    deepseek: {
                        protocol: 'openai',
                        url: '',
                        apiKey: 'key',
                        models: { 'model-a': {} },
                    },
                },
            },
            memory: { enabled: true, model: 'deepseek/model-a' },
        };

        expect(buildMemoryLlmOptions(config).baseUrl).toBe('https://api.deepseek.com/v1');
        expect(buildRuntimeEnv(config)).toMatchObject({
            PILOTDECK_API_BASE_URL: 'https://api.deepseek.com/v1',
            PILOTDECK_MEMORY_BASE_URL: 'https://api.deepseek.com/v1',
        });
    });

    it('resolves catalog environment API keys for runtime and memory settings', () => {
        vi.stubEnv('ANTHROPIC_API_KEY', ' sk-from-env ');
        const config = {
            agent: { model: 'anthropic/claude' },
            model: {
                providers: {
                    anthropic: {
                        protocol: 'anthropic',
                        url: '',
                        models: { claude: {} },
                    },
                },
            },
            memory: { enabled: true, model: 'anthropic/claude' },
        };

        expect(buildRuntimeEnv(config)).toMatchObject({
            PILOTDECK_API_KEY: 'sk-from-env',
            PILOTDECK_MEMORY_API_KEY: 'sk-from-env',
        });
        expect(buildRuntimeEnv(config)).not.toHaveProperty('OPENAI_API_KEY');
        expect(buildMemoryLlmOptions(config).apiKey).toBe('sk-from-env');
    });

    it('preserves provider environment keys across an explicit-key provider switch', () => {
        const originalEnv = { ...process.env };
        const openaiConfig = {
            agent: { model: 'openai/gpt-test' },
            model: {
                providers: {
                    openai: {
                        protocol: 'openai',
                        url: '',
                        apiKey: 'openai-from-config',
                        models: { 'gpt-test': {} },
                    },
                },
            },
            memory: { enabled: false },
        };
        const anthropicConfig = {
            agent: { model: 'anthropic/claude' },
            model: {
                providers: {
                    anthropic: {
                        protocol: 'anthropic',
                        url: '',
                        models: { claude: {} },
                    },
                },
            },
            memory: { enabled: false },
        };

        try {
            process.env.OPENAI_API_KEY = 'openai-from-env';
            process.env.ANTHROPIC_API_KEY = 'anthropic-from-env';

            applyConfigToProcessEnv(openaiConfig);
            expect(process.env.OPENAI_API_KEY).toBe('openai-from-env');
            expect(process.env.ANTHROPIC_API_KEY).toBe('anthropic-from-env');
            expect(process.env.PILOTDECK_API_KEY).toBe('openai-from-config');

            applyConfigToProcessEnv(anthropicConfig);
            expect(process.env.PILOTDECK_API_KEY).toBe('anthropic-from-env');
        } finally {
            for (const key of Object.keys(process.env)) {
                if (!(key in originalEnv)) delete process.env[key];
            }
            Object.assign(process.env, originalEnv);
        }
    });

    it('accepts an omitted URL for catalog providers', () => {
        for (const providerId of ['openai', 'minimax']) {
            const validation = validatePilotDeckConfig({
                agent: { model: `${providerId}/gpt-test` },
                model: {
                    providers: {
                        [providerId]: {
                            protocol: 'openai',
                            url: '',
                            apiKey: 'key',
                            models: { 'gpt-test': {} },
                        },
                    },
                },
            });

            expect(validation.valid).toBe(true);
            expect(validation.errors).toEqual([]);
        }
    });

    it('accepts an omitted API key when the catalog environment key is available', () => {
        vi.stubEnv('ANTHROPIC_API_KEY', 'anthropic-from-env');
        const validation = validatePilotDeckConfig({
            agent: { model: 'ollama/qwen' },
            model: {
                providers: {
                    ollama: {
                        protocol: 'openai',
                        url: 'http://localhost:11434/v1',
                        models: { qwen: {} },
                    },
                    anthropic: {
                        protocol: 'anthropic',
                        url: 'https://api.anthropic.com',
                        models: { claude: {} },
                    },
                },
            },
        });

        expect(validation.valid).toBe(true);
        expect(validation.errors).toEqual([]);
    });

    it('rejects an omitted API key when the catalog environment key is unavailable', () => {
        vi.stubEnv('ANTHROPIC_API_KEY', '');
        const validation = validatePilotDeckConfig({
            agent: { model: 'anthropic/claude' },
            model: {
                providers: {
                    anthropic: {
                        protocol: 'anthropic',
                        url: 'https://api.anthropic.com',
                        models: { claude: {} },
                    },
                },
            },
        });

        expect(validation.valid).toBe(false);
        expect(validation.errors).toContain('model.providers.anthropic.apiKey is required');
    });

    it('does not apply a catalog environment key to a custom provider endpoint', () => {
        vi.stubEnv('OPENAI_API_KEY', 'openai-from-env');
        const provider = {
            protocol: 'openai',
            url: 'https://proxy.example/v1',
            models: { 'gpt-test': {} },
        };
        const validation = validatePilotDeckConfig({
            agent: { model: 'openai/gpt-test' },
            model: { providers: { openai: provider } },
        });

        expect(resolveConfiguredProviderApiKey('openai', provider)).toBe('');
        expect(validation.valid).toBe(false);
        expect(validation.errors).toContain('model.providers.openai.apiKey is required');
    });

    it('accepts an explicit environment reference for a custom provider endpoint', () => {
        vi.stubEnv('PROXY_API_KEY', 'proxy-from-env');
        const provider = {
            protocol: 'openai',
            url: 'https://proxy.example/v1',
            apiKey: '${PROXY_API_KEY}',
            models: { 'gpt-test': {} },
        };
        const validation = validatePilotDeckConfig({
            agent: { model: 'openai/gpt-test' },
            model: { providers: { openai: provider } },
        });

        expect(resolveConfiguredProviderApiKey('openai', provider)).toBe('proxy-from-env');
        expect(validation.valid).toBe(true);
    });

    it('migrates the legacy interactive spreadsheet mode to built-in preview', () => {
        const validation = validatePilotDeckConfig({
            webui: {
                officePreview: {
                    service: 'libreoffice',
                    spreadsheetMode: 'auto',
                },
            },
        });

        expect(validation.valid).toBe(true);
        expect(validation.config.webui.officePreview).toEqual({
            service: 'builtin',
            binaryPath: '',
        });
    });

    it('migrates the legacy print spreadsheet mode to LibreOffice preview', () => {
        const validation = validatePilotDeckConfig({
            webui: {
                officePreview: {
                    service: 'libreoffice',
                    spreadsheetMode: 'print',
                },
            },
        });

        expect(validation.valid).toBe(true);
        expect(validation.config.webui.officePreview).toEqual({
            service: 'libreoffice',
            binaryPath: '',
        });
    });

    it('migrates the legacy disabled Office service to built-in preview', () => {
        const validation = validatePilotDeckConfig({
            webui: {
                officePreview: {
                    service: 'none',
                },
            },
        });

        expect(validation.valid).toBe(true);
        expect(validation.config.webui.officePreview.service).toBe('builtin');
    });

    it('rejects unsupported Office preview services', () => {
        const validation = validatePilotDeckConfig({
            webui: {
                officePreview: {
                    service: 'unexpected',
                },
            },
        });

        expect(validation.valid).toBe(false);
        expect(validation.errors).toContain(
            'webui.officePreview.service must be "builtin" or "libreoffice"',
        );
    });

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

    it('accepts null model definitions as empty objects', () => {
        const validation = validatePilotDeckConfig({
            agent: { model: 'ollama/qwen3:0.6b' },
            model: {
                providers: {
                    ollama: {
                        protocol: 'openai',
                        url: 'http://localhost:11434/v1',
                        models: {
                            'qwen3:0.6b': null,
                        },
                    },
                },
            },
        });

        expect(validation.valid).toBe(true);
        expect(validation.errors).toEqual([]);
        expect(validation.config.model.providers.ollama.models['qwen3:0.6b']).toBeNull();
        expect(resolveModel(validation.config, 'ollama/qwen3:0.6b').def).toEqual({});
    });

    it('still treats absent model keys as missing', () => {
        const validation = validatePilotDeckConfig({
            agent: { model: 'ollama/missing-model' },
            model: {
                providers: {
                    ollama: {
                        protocol: 'openai',
                        url: 'http://localhost:11434/v1',
                        models: {
                            'qwen3:0.6b': null,
                        },
                    },
                },
            },
        });

        expect(validation.valid).toBe(false);
        expect(validation.errors).toContain(
            'agent.model="ollama/missing-model" doesn\'t resolve to a configured provider/model',
        );
    });

    it('still rejects non-object model definitions', () => {
        expect(() => resolveModel({
            agent: { model: 'ollama/qwen3:0.6b' },
            model: {
                providers: {
                    ollama: {
                        protocol: 'openai',
                        url: 'http://localhost:11434/v1',
                        models: {
                            'qwen3:0.6b': 'invalid',
                        },
                    },
                },
            },
        }, 'ollama/qwen3:0.6b')).toThrow(
            'Model definition for provider "ollama" must be an object: qwen3:0.6b',
        );
    });

    it('warns instead of failing when agent.subagents.default references a missing provider', () => {
        const validation = validatePilotDeckConfig({
            agent: {
                model: 'ollama/qwen3:0.6b',
                subagents: { default: 'missing/qwen3:0.6b' },
            },
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
        expect(validation.warnings).toContain(
            'agent.subagents.default="missing/qwen3:0.6b" doesn\'t resolve to a configured provider/model; subagents will inherit agent.model',
        );
    });

    it('warns instead of failing when agent.subagents.default references a missing model', () => {
        const validation = validatePilotDeckConfig({
            agent: {
                model: 'ollama/qwen3:0.6b',
                subagents: { default: 'ollama/missing-model' },
            },
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
        expect(validation.warnings).toContain(
            'agent.subagents.default="ollama/missing-model" doesn\'t resolve to a configured provider/model; subagents will inherit agent.model',
        );
    });

    it('rejects agent.model when the configured model is missing', () => {
        const validation = validatePilotDeckConfig({
            agent: { model: 'ollama/missing-model' },
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

        expect(validation.valid).toBe(false);
        expect(validation.errors).toContain(
            'agent.model="ollama/missing-model" doesn\'t resolve to a configured provider/model',
        );
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

    it('rejects incomplete providers even when they are not the active agent model', () => {
        const validation = validatePilotDeckConfig({
            agent: { model: '_placeholder/_placeholder' },
            model: {
                providers: {
                    _placeholder: {
                        protocol: 'openai',
                        url: 'https://example.invalid/v1',
                        apiKey: 'PLACEHOLDER_RUN_ONBOARDING_TO_REPLACE',
                        models: { _placeholder: {} },
                    },
                    provider1: {
                        protocol: 'openai',
                        url: '',
                        apiKey: '',
                        models: {},
                    },
                },
            },
        });

        expect(validation.valid).toBe(false);
        expect(validation.errors).toEqual(expect.arrayContaining([
            'model.providers.provider1.url is required',
            'model.providers.provider1.apiKey is required',
            'model.providers.provider1.models must contain at least one model',
        ]));
    });

    it('keeps the bootstrap provider when an unrelated setting is saved before onboarding', async () => {
        useTempConfig(null);

        const result = await writePilotDeckConfig({
            agent: { model: '_placeholder/_placeholder' },
            model: {
                providers: {
                    _placeholder: {
                        protocol: 'openai',
                        url: 'https://example.invalid/v1',
                        apiKey: 'PLACEHOLDER_RUN_ONBOARDING_TO_REPLACE',
                        models: { _placeholder: {} },
                    },
                },
            },
            tools: { webSearch: { enabled: false } },
        });

        expect(result.config.agent.model).toBe('_placeholder/_placeholder');
        expect(result.config.model.providers).toHaveProperty('_placeholder');
        expect(result.config.tools.webSearch.enabled).toBe(false);
    });

    it('keeps the bootstrap provider while a real provider is configured but not selected', async () => {
        useTempConfig(null);

        const result = await writePilotDeckConfig({
            agent: { model: '_placeholder/_placeholder' },
            model: {
                providers: {
                    _placeholder: {
                        protocol: 'openai',
                        url: 'https://example.invalid/v1',
                        apiKey: 'PLACEHOLDER_RUN_ONBOARDING_TO_REPLACE',
                        models: { _placeholder: {} },
                    },
                    ollama: {
                        protocol: 'openai',
                        url: 'http://localhost:11434/v1',
                        models: { 'qwen3:0.6b': {} },
                    },
                },
            },
        });

        expect(result.config.model.providers).toHaveProperty('_placeholder');
        expect(result.config.model.providers).toHaveProperty('ollama');
    });

    it('removes an unreferenced empty provider draft left by older settings builds', async () => {
        useTempConfig(null);

        const previousConfig = {
            agent: { model: 'ollama/qwen3:0.6b' },
            model: {
                providers: {
                    ollama: {
                        protocol: 'openai',
                        url: 'http://localhost:11434/v1',
                        models: { 'qwen3:0.6b': {} },
                    },
                    provider1: {
                        protocol: 'openai',
                        url: '',
                        apiKey: '',
                        models: {},
                    },
                },
            },
        };
        const result = await writePilotDeckConfig(previousConfig, { previousConfig });

        expect(result.config.model.providers).toHaveProperty('ollama');
        expect(result.config.model.providers).not.toHaveProperty('provider1');
    });

    it('removes bootstrap providers and rewrites their references after selecting a real model', async () => {
        useTempConfig(null);

        const result = await writePilotDeckConfig({
            agent: {
                model: 'ollama/qwen3:0.6b',
                subagents: { default: '_placeholder/_placeholder' },
            },
            memory: { model: '_placeholder/_placeholder' },
            model: {
                providers: {
                    _placeholder: {
                        protocol: 'openai',
                        url: 'https://example.invalid/v1',
                        apiKey: 'PLACEHOLDER_RUN_ONBOARDING_TO_REPLACE',
                        models: { _placeholder: {} },
                    },
                    ollama: {
                        protocol: 'openai',
                        url: 'http://localhost:11434/v1',
                        models: { 'qwen3:0.6b': {} },
                    },
                },
            },
            router: {
                scenarios: {
                    default: '_placeholder/_placeholder',
                    vision: '_placeholder/_placeholder',
                },
                fallback: {
                    default: ['_placeholder/_placeholder'],
                    vision: ['_placeholder/_placeholder'],
                },
                stats: {
                    baselineModel: '_placeholder/_placeholder',
                    modelPricing: {
                        '_placeholder/_placeholder': { input: 99, output: 99 },
                        'ollama/qwen3:0.6b': { input: 0, output: 0 },
                    },
                },
                tokenSaver: {
                    judge: '_placeholder/_placeholder',
                    defaultTier: 'fast',
                    tiers: { fast: { model: '_placeholder/_placeholder' } },
                },
            },
        });

        expect(result.config.model.providers).not.toHaveProperty('_placeholder');
        expect(result.config.agent.subagents.default).toBe('inherit');
        expect(result.config.memory.model).toBe('inherit');
        expect(result.config.router.scenarios).toEqual({
            default: 'ollama/qwen3:0.6b',
            vision: 'ollama/qwen3:0.6b',
        });
        expect(result.config.router.fallback).toEqual({
            default: ['ollama/qwen3:0.6b'],
            vision: ['ollama/qwen3:0.6b'],
        });
        expect(result.config.router.stats.baselineModel).toBe('ollama/qwen3:0.6b');
        expect(result.config.router.stats.modelPricing).toEqual({
            'ollama/qwen3:0.6b': { input: 0, output: 0 },
        });
        expect(result.config.router.tokenSaver.judge).toBe('ollama/qwen3:0.6b');
        expect(result.config.router.tokenSaver.tiers.fast.model).toBe('ollama/qwen3:0.6b');
    });

    it('resets a placeholder subagent default when writing config', async () => {
        const configPath = useTempConfig(null);

        const result = await writePilotDeckConfig({
            agent: {
                model: 'ollama/qwen3:0.6b',
                subagents: { default: '_placeholder/_placeholder' },
            },
            model: {
                providers: {
                    _placeholder: {
                        protocol: 'openai',
                        url: 'https://example.invalid/v1',
                        apiKey: 'PLACEHOLDER_RUN_ONBOARDING_TO_REPLACE',
                        models: {
                            _placeholder: {},
                        },
                    },
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

        expect(result.config.agent.subagents.default).toBe('inherit');
        expect(result.config.model.providers).not.toHaveProperty('_placeholder');
        expect(result.configPath).toBe(configPath);
    });
});

describe('validatePilotDeckConfig router settings', () => {
    const base = {
        agent: { model: 'openai/gpt-test' },
        model: {
            providers: {
                openai: {
                    protocol: 'openai',
                    url: 'https://api.example.test/v1',
                    apiKey: 'test-key',
                    models: { 'gpt-test': {} },
                },
            },
        },
    };

    function withRouter(router) {
        return validatePilotDeckConfig({ ...base, router });
    }

    it('accepts pricing units and keeps a missing unit backward compatible', () => {
        const validation = withRouter({
            stats: {
                modelPricing: {
                    'openai/gpt-test': { input: 1, output: 2, cacheRead: 0.5 },
                },
            },
        });

        expect(validation.valid).toBe(true);
        expect(validation.config.router.stats.modelPricing['openai/gpt-test']).toEqual({
            input: 1,
            output: 2,
            cacheRead: 0.5,
        });
    });

    it('validates router stats baselineModel against configured models', () => {
        const valid = withRouter({
            stats: { baselineModel: { provider: 'openai', model: 'gpt-test' } },
        });
        expect(valid.valid).toBe(true);

        const invalid = withRouter({
            stats: { baselineModel: { provider: 'openai', model: 'missing' } },
        });
        expect(invalid.valid).toBe(false);
        expect(invalid.errors).toContain(
            'router.stats.baselineModel="openai/missing" doesn\'t resolve to a configured provider/model',
        );
    });

    it('accepts legacy string baselineModel references', () => {
        const validation = withRouter({
            stats: { baselineModel: 'openai/gpt-test' },
        });
        expect(validation.valid).toBe(true);
        expect(validation.errors).toEqual([]);
    });

    it('rejects invalid pricing values and units', () => {
        const validation = withRouter({
            stats: {
                modelPricing: {
                    'openai/gpt-test': { input: -1, output: Number.NaN, unit: 'EUR/token' },
                },
            },
        });

        expect(validation.valid).toBe(false);
        expect(validation.errors).toEqual(expect.arrayContaining([
            'router.stats.modelPricing.openai/gpt-test.input must be a finite non-negative number',
            'router.stats.modelPricing.openai/gpt-test.output must be a finite non-negative number',
            'router.stats.modelPricing.openai/gpt-test.unit must be one of $/百万 Token or ¥/百万 Token',
        ]));
    });

    it('validates default tier, tier models, and subagent policy', () => {
        const validation = withRouter({
            tokenSaver: {
                judge: 'openai/gpt-test',
                defaultTier: 'missing',
                tiers: {
                    medium: { model: 'openai/missing', description: 42 },
                },
                subagent: { policy: 'invalid' },
            },
        });

        expect(validation.valid).toBe(false);
        expect(validation.errors).toEqual(expect.arrayContaining([
            'router.tokenSaver.tiers.medium.model="openai/missing" doesn\'t resolve to a configured provider/model',
            'router.tokenSaver.tiers.medium.description must be a string',
            'router.tokenSaver.defaultTier="missing" must exist in router.tokenSaver.tiers',
            'router.tokenSaver.subagent.policy must be one of skip / judge',
        ]));
    });

    it('does not validate ignored router children when router is disabled', () => {
        const validation = withRouter({
            enabled: false,
            tokenSaver: { judge: 'missing/model', subagent: { policy: 'invalid' } },
            stats: {
                modelPricing: { invalid: { input: -1 } },
                baselineModel: { provider: 'missing', model: 'model' },
            },
        });

        expect(validation.valid).toBe(true);
    });
});

describe('validatePilotDeckConfig web search settings', () => {
    const base = {
        agent: { model: 'openai/gpt-test' },
        model: {
            providers: {
                openai: {
                    protocol: 'openai',
                    url: 'https://api.example.test/v1',
                    apiKey: 'test-key',
                    models: { 'gpt-test': {} },
                },
            },
        },
    };

    it('rejects an unknown provider and non-HTTP endpoint through common config validation', () => {
        const validation = validatePilotDeckConfig({
            ...base,
            tools: { webSearch: { provider: 'zai', endpoint: 'ftp://example.test/search' } },
        });
        expect(validation.valid).toBe(false);
        expect(validation.errors).toEqual(expect.arrayContaining([
            expect.stringContaining('tools.webSearch.provider'),
            expect.stringContaining('tools.webSearch.endpoint'),
        ]));
    });

    it('accepts all supported built-in search providers', () => {
        for (const provider of ['glm', 'tavily', 'custom', 'serper', 'brave']) {
            const validation = validatePilotDeckConfig({
                ...base,
                tools: { webSearch: { provider, ...(provider === 'custom' ? { endpoint: 'https://search.example.test' } : {}) } },
            });
            expect(validation.errors).not.toEqual(expect.arrayContaining([
                expect.stringContaining('tools.webSearch.provider'),
            ]));
        }
    });
});
