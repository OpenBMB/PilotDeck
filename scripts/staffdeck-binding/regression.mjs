import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const pd = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const sd = process.env.STAFFDECK_CHECKOUT || resolve(pd, '../StaffDeck');
const qa = process.env.BINDING_QA_ROOT; assert.ok(qa);
mkdirSync(qa, { recursive: true, mode: 0o700 });
const python = process.env.BINDING_QA_PYTHON; assert.ok(python);
const env = { ...process.env }; delete env.NODE_OPTIONS;
if (existsSync(join(qa, 'env.json'))) {
  env.PILOTDECK_CONFIG_PATH = join(pd, 'products/pilotdeck-staffdeck-sop/profiles/formal-host.yaml');
  delete env.PILOTDECK_FRONTEND_PROFILE;
}
const commands = [
  ['core-build', pd, 'npm', ['run', 'build']],
  ['ui-build', join(pd, 'ui'), 'npm', ['run', 'build']],
  ['ui-typecheck', join(pd, 'ui'), 'npm', ['run', 'typecheck']],
  ['core-tests', pd, process.execPath, ['--test',
    'dist/tests/pilot/staffdeck-project-binding.spec.js', 'dist/tests/pilot/staffdeck-project-binding-faults.spec.js',
    'dist/tests/composition/public-approval-bridge.spec.js', 'dist/tests/sop/staffdeck-sop-agent-loop.spec.js',
    'dist/tests/sop/staffdeck-sop-discovery-client.spec.js']],
  ['shell-tests', join(pd, 'ui'), 'npx', ['vitest', 'run', 'src/components/app-shell/MainAreaV2.test.tsx',
    'src/components/app-shell/SidebarV2.test.tsx', 'src/components/app-shell/appShellSelection.test.tsx',
    'src/components/app-shell/useSessionIndicators.test.tsx', 'src/components/app-shell/StaffDeckProjectBinding.test.tsx']],
  ['publish-tests', pd, process.execPath, ['--test', 'ui/server/staffdeck-publish-route.test.js',
    'ui/server/staffdeck-publish-runtime.test.mjs']],
  ['ui-tests', join(pd, 'ui'), 'npx', ['vitest', 'run', 'server/routes/projects.binding.test.js',
    'server/routes/modules.test.js', 'server/routes/modules-sdk.test.js', 'server/routes/modules-public-bridge.test.js',
    'server/routes/staffdeck-copy.test.js', 'src/components/app-shell/StaffDeckProjectBinding.test.tsx',
    'src/composition/modules/staffdeck/publish-runtime-integration.test.tsx',
    'src/composition/modules/staffdeck/public-approval-consumer.test.tsx']],
  ['sd-tests', sd, python, ['-m', 'pytest', '-q', 'backend/tests/test_project_agent_binding.py',
    'backend/tests/test_project_binding_upgrade.py', 'backend/tests/test_pilotdeck_domain_binding.py',
    'backend/tests/test_pilotdeck_approval_binding.py', 'backend/tests/test_sop_capability_authority.py',
    'backend/tests/test_public_pilotdeck_knowledge_read.py', 'backend/tests/test_capability_scope.py',
    'backend/tests/test_public_sop_route.py', 'backend/tests/test_public_sop_selected_base.py',
    'backend/tests/test_public_staffdeck_facade.py',
    'backend/tests_harness/test_pilotdeck_harness_model.py']],
  ['pd-diff', pd, 'git', ['diff', '--check']], ['sd-diff', sd, 'git', ['diff', '--check']],
];
const results = [];
for (const [name, cwd, command, args] of commands) {
  if (process.env.BINDING_QA_ONLY && process.env.BINDING_QA_ONLY !== name) continue;
  const started = Date.now();
  const value = spawnSync(command, args, { cwd,
    env: { ...env, PYTHONPATH: 'backend:backend/src', PYTEST_DISABLE_PLUGIN_AUTOLOAD: '1' },
    encoding: 'utf8', timeout: 300000, maxBuffer: 16 * 1024 * 1024 });
  const output = (value.stdout || '') + (value.stderr || '');
  writeFileSync(join(qa, `${name}-private.log`), output, { mode: 0o600 });
  const summary = output.split('\n').filter(line => /# (tests|pass|fail|skipped|duration_ms)|\d+ passed|Tests\s+\d+|Duration|built in/.test(line))
    .map(line => line.replace(/\x1b\[[0-9;]*m/g, ''));
  results.push({ name, cwd, command: [command, ...args], status: value.status === 0 ? 'PASS' : 'FAIL',
    exitCode: value.status, elapsedMs: Date.now() - started, summary,
    ...(value.error ? { error: value.error.message } : {}) });
  writeFileSync(join(qa, `regression-result${process.env.BINDING_QA_ONLY ? '-' + process.env.BINDING_QA_ONLY : ''}.json`), JSON.stringify(results, null, 2));
  console.log(results.at(-1).status, name, results.at(-1).elapsedMs, summary.join('; '));
}
if (results.some(result => result.status === 'FAIL')) process.exitCode = 1;
