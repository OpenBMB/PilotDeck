import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
    buildDefaultPilotDeckConfig,
    readPilotDeckConfigFile,
    sanitizeProviderCredentials,
    validatePilotDeckConfig,
} from './pilotdeckConfig.js';

const tempDirs = [];

afterEach(() => {
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
});

describe('validatePilotDeckConfig gateway validation', () => {
    it('accepts a complete Trans-Speech configuration from Settings', () => {
        const validation = validatePilotDeckConfig({
            tools: {
                transSpeech: {
                    enabled: true,
                    baseUrl: 'http://172.16.21.9:8090',
                    language: 'zh',
                    asrProfile: 'sensevoice',
                    diarize: true,
                    timeoutMs: 330000,
                    maxConcurrentTasks: 1,
                    generate: { polish: true, minutes: true, actions: false },
                },
            },
        });

        expect(validation.valid).toBe(true);
    });

    it('rejects an incomplete enabled Trans-Speech configuration before saving', () => {
        const validation = validatePilotDeckConfig({
            tools: { transSpeech: { enabled: true } },
        });

        expect(validation.valid).toBe(false);
        expect(validation.errors).toContain(
            'tools.transSpeech.baseUrl: tools.transSpeech.baseUrl must be a non-empty string.',
        );
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
