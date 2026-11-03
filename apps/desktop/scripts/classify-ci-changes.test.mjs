import { test } from 'node:test';
import assert from 'node:assert/strict';
import { needsNativePackaging } from './classify-ci-changes.mjs';

test('ordinary UI, gateway and documentation changes keep fast regressions', () => {
  assert.equal(needsNativePackaging(['ui/src/components/chat-v2/ComposerV2.tsx', 'src/agent/loop/AgentLoop.ts', 'docs/desktop.md']), false);
});
test('native dependencies, packaging, runtime bootstrap and release workflows require packages', () => {
  for (const file of ['apps/desktop/src/main.ts', 'apps/desktop/resources/installer.nsh', 'packages/config/index.cjs',
    'pnpm-lock.yaml', 'package.json', 'ui/package.json', 'tsconfig.json', 'ui/vite.config.ts',
    'scripts/prepare-computer-use.mjs', 'ui/server/services/runtimeCoordination.js', 'ui/server/webRuntimeSupervisor.js',
    'scripts/computer-use/cua-driver.json', 'scripts/lib/mac-computer-use.mjs', 'resources/cua-driver/manifest.json', 'skills/pptx/runtime/package.json',
    '.github/workflows/desktop-linux.yml', '.github/workflows/release.yml']) {
    assert.equal(needsNativePackaging([file]), true, file);
  }
});
