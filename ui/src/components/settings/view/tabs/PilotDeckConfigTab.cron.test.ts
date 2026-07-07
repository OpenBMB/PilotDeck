import { describe, expect, it } from 'vitest';
import { isCronConfigEnabled, patch, rewriteProviderRefs } from './pilotDeckConfigForm';

describe('PilotDeckConfigTab Cron settings', () => {
  it.each([
    { label: 'missing cron section', config: {}, expected: false },
    { label: 'cron section without enabled', config: { cron: {} }, expected: true },
    { label: 'explicitly enabled cron section', config: { cron: { enabled: true } }, expected: true },
    { label: 'explicitly disabled cron section', config: { cron: { enabled: false } }, expected: false },
  ])('treats $label as enabled=$expected', ({ config, expected }) => {
    expect(isCronConfigEnabled(config)).toBe(expected);
  });

  it('creates cron.enabled when enabling a missing cron section without changing other config', () => {
    const config = {
      schemaVersion: 1,
      agent: { model: 'provider/model' },
      customEnv: { EXISTING_VALUE: 'preserved' },
    };

    const updated = patch(config, ['cron', 'enabled'], true);

    expect(updated).toEqual({
      ...config,
      cron: { enabled: true },
    });
    expect(config).not.toHaveProperty('cron');
  });
});

describe('PilotDeckConfigTab router refs', () => {
  it('rewrites auto-orchestrate model refs when renaming a provider', () => {
    const config = {
      agent: { model: 'old/main' },
      router: {
        autoOrchestrate: {
          mainAgentModel: 'old/main',
          subagentModel: 'old/sub',
        },
      },
    };

    const updated = rewriteProviderRefs(config, 'old', 'new');

    expect(updated.router?.autoOrchestrate?.mainAgentModel).toBe('new/main');
    expect(updated.router?.autoOrchestrate?.subagentModel).toBe('new/sub');
    expect(config.router.autoOrchestrate.mainAgentModel).toBe('old/main');
    expect(config.router.autoOrchestrate.subagentModel).toBe('old/sub');
  });
});
