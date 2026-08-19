import { existsSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import { readFileSync } from 'node:fs';

const root = resolve(import.meta.dirname, '../../..');

describe('onboarding delivery resources', () => {
  it('ships all public onboarding assets and keeps the probe server-internal', () => {
    const providers = readdirSync(resolve(root, 'ui/public/onboarding/providers')).filter((file) => file.endsWith('.svg')).sort();
    expect(providers).toEqual([
      'anthropic.svg', 'bailian-color.svg', 'deepseek-color.svg', 'gemini-color.svg', 'kimi.svg',
      'minimax-color.svg', 'ollama.svg', 'openai.svg', 'openrouter-color.svg', 'volcengine-color.svg', 'zhipu-color.svg',
    ]);
    for (const file of ['pilotdeck-logo-lockup-transparent.png', 'pilotdeck-p-mark-transparent.png', 'pilotdeck-p-mark-transparent-v2.png']) {
      expect(existsSync(resolve(root, 'ui/public', file))).toBe(true);
    }
    expect(existsSync(resolve(root, 'ui/server/assets/onboarding/image-capability-probe.png'))).toBe(true);
    expect(readFileSync(resolve(root, 'ui/server/assets/onboarding/image-capability-probe.png')).subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  });

  it('parses the OpenAPI handoff contract and resolves local component refs', () => {
    const doc = parse(readFileSync(resolve(root, 'docs/pilotdeck-onboarding-api.openapi.yaml'), 'utf8'));
    expect(doc.openapi).toBe('3.1.0');
    const refs = JSON.stringify(doc).match(/#\/components\/[^" ]+/g) || [];
    for (const ref of refs) {
      const [section, name] = ref.replace('#/components/', '').split('/');
      expect(doc.components?.[section]?.[name]).toBeDefined();
    }
  });
});
