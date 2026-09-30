import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse } from 'yaml';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { findModelReferences, rewriteModelReferences } from './modelReferences.js';
import { validatePilotDeckConfig, writePilotDeckConfig } from './pilotdeckConfig.js';

const dirs = [];
afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function config(profiles = { vision: { description: 'Read images', model: 'proxy/org/vision/v1', tools: ['read_file'] } }) {
  return {
    schemaVersion: 1,
    agent: { model: 'proxy/text', subagents: { maxDepth: 2, profiles } },
    model: { providers: { proxy: {
      protocol: 'openai', url: 'http://localhost:1234/v1', apiKey: 'test-only-key',
      models: { text: null, 'org/vision/v1': { multimodal: { input: ['text', 'image'] } } },
    } } },
    memory: { enabled: false },
  };
}

describe('subagent profile settings integration', () => {
  it('includes bound profiles in model deletion references, including disabled profiles', () => {
    const input = config({
      vision: { description: 'Read images', model: 'proxy/org/vision/v1', enabled: false },
      explore: { model: 'inherit' },
    });
    expect(findModelReferences(input, { providerId: 'proxy', modelId: 'org/vision/v1' })).toEqual([
      { path: 'agent.subagents.profiles.vision.model', value: 'proxy/org/vision/v1', kind: 'agent' },
    ]);
  });

  it('renames profile references while preserving role descriptions and tool policies', () => {
    const input = config();
    rewriteModelReferences(input, {
      providerRenames: new Map([['proxy', 'renamed']]),
      modelRenames: new Map([['proxy/org/vision/v1', { modelId: 'org/vision/v2' }]]),
    });
    expect(input.agent.subagents.profiles.vision).toEqual({
      description: 'Read images', model: 'renamed/org/vision/v2', tools: ['read_file'],
    });
  });

  it.each([
    ['blank description', { vision: { description: '   ' } }],
    ['invalid ID', { 'bad role': { description: 'Read images' } }],
    ['missing model', { vision: { description: 'Read images', model: 'proxy/missing' } }],
    ['invalid tools', { vision: { description: 'Read images', tools: 'read_file' } }],
    ['readonly preset escalation', { explore: { readOnly: false } }],
  ])('rejects %s before saving', (_name, profiles) => {
    expect(validatePilotDeckConfig(config(profiles)).valid).toBe(false);
  });

  it.each([-1, 1.5, 6, '2'])('rejects invalid nesting depth %s', maxDepth => {
    const input = config();
    input.agent.subagents.maxDepth = maxDepth;
    expect(validatePilotDeckConfig(input).valid).toBe(false);
  });

  it('saves valid roles without losing secrets or unrelated configuration', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pilotdeck-profile-settings-'));
    dirs.push(dir);
    const file = join(dir, 'pilotdeck.yaml');
    vi.stubEnv('PILOTDECK_CONFIG_PATH', file);
    const input = config();
    input.extension = { builtinPluginsEnabled: { example: false } };
    expect(validatePilotDeckConfig(input).valid).toBe(true);
    await writePilotDeckConfig(input);
    const saved = parse(readFileSync(file, 'utf8'));
    expect(saved.agent.subagents).toMatchObject(input.agent.subagents);
    expect(saved.model.providers.proxy.apiKey).toBe('test-only-key');
    expect(saved.extension).toMatchObject(input.extension);
  });
});
