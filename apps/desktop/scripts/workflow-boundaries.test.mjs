import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { runInNewContext } from 'node:vm';

const { parse } = createRequire(new URL('../../../package.json', import.meta.url))('yaml');
const workflow = name => parse(readFileSync(new URL(`../../../.github/workflows/${name}.yml`, import.meta.url), 'utf8'));

test('OBS PR validation is limited to OBS code and workflow changes', () => {
  const obs = workflow('release-to-obs');
  assert.deepEqual(obs.on.pull_request.paths, ['.github/scripts/*obs*.py', '.github/workflows/*obs*.yml']);
  assert.ok(obs.jobs.tests.steps.some(step => step.run?.includes("test_*obs*.py")));
  assert.equal(obs.jobs.tests.environment, undefined);
});

test('application PR suites honor selected boundaries while main and manual runs retain coverage', () => {
  const desktop = workflow('desktop-smoke');
  const web = workflow('web-regression');
  const evaluate = (job, event, outputs) => runInNewContext(job.if, { github: { event_name: event }, needs: { changes: { outputs } } });
  for (const [job, scope] of [[desktop.jobs['checkpoint-regression'], 'checkpoints'], [desktop.jobs['static-checks'], 'checks'],
    [desktop.jobs.windows, 'packaging'], [desktop.jobs.macos, 'packaging'], [desktop.jobs.linux, 'packaging']]) {
    assert.equal(job.needs, 'changes');
    assert.equal(evaluate(job, 'pull_request', { [scope]: 'false' }), false);
    assert.equal(evaluate(job, 'pull_request', { [scope]: 'true' }), true);
    assert.equal(evaluate(job, 'workflow_dispatch', {}), true);
  }
  for (const [job, scope] of [[web.jobs.web, 'web'], [web.jobs.docker, 'docker']]) {
    assert.equal(job.needs, 'changes');
    assert.equal(evaluate(job, 'pull_request', { [scope]: 'false' }), false);
    assert.equal(evaluate(job, 'pull_request', { [scope]: 'true' }), true);
    assert.equal(evaluate(job, 'push', {}), true);
  }
  assert.equal(web.jobs.web['runs-on'], 'ubuntu-24.04');
  assert.deepEqual(web.on.push.branches, ['main']);
  assert.equal(web.concurrency['cancel-in-progress'], "${{ github.event_name == 'pull_request' }}");
  for (const step of web.jobs.web.steps.filter(step => step.run?.includes('exec playwright'))) {
    assert.equal(evaluate(step, 'pull_request', { browser: 'false' }), false);
    assert.equal(evaluate(step, 'pull_request', { browser: 'true' }), true);
    assert.equal(evaluate(step, 'push', {}), true);
  }
});

test('one Docker build retains cached image construction and isolated runtime verification', () => {
  assert.equal(existsSync(new URL('../../../.github/workflows/docker-build.yml', import.meta.url)), false);
  const steps = workflow('web-regression').jobs.docker.steps;
  const build = steps.find(step => step.uses?.startsWith('docker/build-push-action@'));
  assert.equal(build.with.push, false);
  assert.equal(build.with.load, true);
  assert.match(build.with['cache-from'], /type=gha/);
  assert.match(build.with['cache-to'], /type=gha/);
  assert.ok(steps.some(step => step.run?.includes("import './ui/server/runtimeBootstrap.js'")));
});

test('OBS publication follows the exact completed release and retains manual repair', () => {
  const release = workflow('release');
  const sync = release.jobs['sync-obs'];
  assert.equal(sync.needs, 'release');
  assert.equal(sync.uses, './.github/workflows/release-to-obs.yml');
  assert.equal(sync.with.release_tag, '${{ needs.release.outputs.release_tag }}');
  assert.equal(release.jobs.release.outputs.release_tag, '${{ steps.metadata.outputs.release_tag }}');
  const obs = workflow('release-to-obs');
  assert.equal(obs.on.workflow_call.inputs.release_tag.required, true);
  assert.ok(Object.hasOwn(obs.on, 'workflow_dispatch'));
  assert.equal(obs.concurrency['cancel-in-progress'], false);
  const condition = obs.jobs.sync.if;
  const evaluate = context => runInNewContext(condition, context);
  const upstream = { repository: 'OpenBMB/PilotDeck', ref: 'refs/heads/main', event_name: 'schedule' };
  assert.equal(evaluate({ github: upstream, inputs: { release_tag: 'v2026.10.29' }, vars: {} }), true);
  assert.equal(evaluate({ github: upstream, inputs: { release_tag: '' }, vars: {} }), false);
  assert.equal(evaluate({ github: { ...upstream, ref: 'refs/pull/1/merge', event_name: 'pull_request' }, inputs: { release_tag: '' }, vars: {} }), false);
  assert.equal(evaluate({ github: { ...upstream, repository: 'fork/PilotDeck' }, inputs: { release_tag: 'v2026.10.29' }, vars: {} }), false);
  const steps = obs.jobs.sync.steps;
  const verify = steps.findIndex(s => s.run?.includes('verify-release-assets.mjs'));
  const publish = steps.findIndex(s => s.run?.includes('release_to_obs.py'));
  assert.ok(verify >= 0 && publish > verify);
  assert.ok(steps.some(s => s.run?.includes('releases/tags/$RELEASE_TAG')));
});

test('Linux manual acceptance selects native ARM64 while shared builds default to both architectures', () => {
  const linux = workflow('desktop-linux');
  assert.equal(linux.on.workflow_dispatch.inputs.architecture.default, 'arm64');
  assert.deepEqual(linux.on.workflow_dispatch.inputs.architecture.options, ['arm64', 'x64', 'all']);
  assert.equal(linux.on.workflow_call.inputs.architecture.default, 'all');
  const evaluate = (expression, context) => JSON.parse(JSON.stringify(runInNewContext(
    expression.slice(3, -2), { fromJSON: JSON.parse, ...context },
  )));
  for (const job of [linux.jobs.deb, linux.jobs.rpm]) {
    for (const [architecture, expected] of [['arm64', ['arm64']], ['x64', ['x64']], ['all', ['x64', 'arm64']], [undefined, ['x64', 'arm64']]]) {
      assert.deepEqual(evaluate(job.strategy.matrix.arch, { inputs: { architecture } }), expected);
    }
    assert.equal(evaluate(job['runs-on'], { matrix: { arch: 'arm64' } }), 'ubuntu-22.04-arm');
    assert.equal(evaluate(job['runs-on'], { matrix: { arch: 'x64' } }), 'ubuntu-22.04');
    assert.ok(job.steps.some(step => step.run?.includes('run-linux-display-smoke.sh x11')));
    assert.ok(job.steps.some(step => step.run?.includes('run-linux-display-smoke.sh wayland')));
    assert.ok(job.steps.some(step => step.run?.includes('run-linux-chrome-smoke.sh x11')));
    assert.ok(job.steps.some(step => step.run?.includes('run-linux-chrome-smoke.sh wayland')));
  }
  assert.equal(linux.jobs.rpm.container, 'rockylinux:9');
});

test('shared native builds cannot select arbitrary source or request release write access', () => {
  for (const platform of ['linux', 'macos', 'windows']) {
    const data = workflow(`desktop-${platform}`);
    assert.equal(data.permissions.contents, 'read');
    assert.equal(data.on.workflow_call.inputs.source_sha, undefined);
    for (const job of Object.values(data.jobs)) {
      for (const step of job.steps ?? []) {
        if (step.uses?.startsWith('actions/checkout@')) {
          assert.equal(step.with.ref, '${{ github.sha }}');
          assert.equal(step.with['persist-credentials'], false);
        }
      }
    }
  }
});

test('PR checks do not inherit signing secrets or enable production signing', () => {
  const pr = workflow('desktop-smoke');
  assert.equal(pr.permissions.contents, 'read');
  for (const job of Object.values(pr.jobs)) {
    assert.equal(job.secrets, undefined);
    assert.notEqual(job.with?.require_macos_signing, true);
    assert.equal(job.with?.require_windows_signing ?? false, false);
  }
  const mac = workflow('desktop-macos');
  const windows = workflow('desktop-windows');
  assert.equal(windows.on.workflow_call.inputs.require_windows_signing.default, false);
  assert.equal(mac.on.workflow_call.inputs.require_macos_signing.default, false);
  for (const name of ['Import Developer ID certificate', 'Verify production macOS identity and notarization',
    'Prepare architecture-specific macOS update feed', 'Upload macOS installer']) {
    assert.equal(mac.jobs.macos.steps.find(step => step.name === name).if, '${{ inputs.require_macos_signing }}', name);
  }
});

test('only the final release job can publish after all platform checks succeed', () => {
  const release = workflow('release');
  assert.equal(release.permissions.contents, 'read');
  assert.equal(release.jobs.macos.with.require_macos_signing, true);
  assert.equal(release.jobs.windows.with.require_windows_signing, true);
  for (const [name, job] of Object.entries(release.jobs)) {
    assert.equal(job.permissions?.contents === 'write', name === 'release');
  }
  assert.deepEqual(release.jobs.release.needs, ['detect', 'linux', 'macos', 'windows']);
  const steps = release.jobs.release.steps;
  const verification = steps.findIndex(step => step.run?.includes('verify-release-assets.mjs'));
  const publication = steps.findIndex(step => step.run?.includes('gh release create'));
  assert.ok(verification >= 0 && publication > verification);
});

test('Windows release signing failures block artifact upload and publication', () => {
  const windows = workflow('desktop-windows').jobs.build;
  const evaluate = (expression, required) => runInNewContext(expression.slice(3, -2), { inputs: { require_windows_signing: required } });
  assert.equal(evaluate(windows.environment, true), 'windows-signing');
  assert.equal(evaluate(windows.environment, false), '');
  const steps = windows.steps;
  const signed = steps.findIndex(step => step.name === 'Build signed Windows ${{ matrix.arch }} installer');
  const unsigned = steps.find(step => step.name === 'Build Windows ${{ matrix.arch }} installer');
  const upload = steps.findIndex(step => step.name === 'Upload Windows installer');
  assert.ok(signed >= 0 && upload > signed);
  assert.equal(evaluate(steps[signed].if, true), true);
  assert.equal(evaluate(steps[signed].if, false), false);
  assert.equal(evaluate(unsigned.if, true), false);
  assert.equal(evaluate(unsigned.if, false), true);
  assert.equal(steps[signed].env.PILOTDECK_WINDOWS_SIGNING, 'required');
  assert.match(steps[signed].run, /windows-signing\.cjs verify/);
  assert.match(steps[signed].run, /throw 'Windows signature verification failed\.'/);
  assert.notEqual(windows['continue-on-error'], true);
  assert.notEqual(steps[signed]['continue-on-error'], true);
  assert.equal(steps[upload].if, undefined); // Implicit success(), never always().
  const release = workflow('release').jobs.release;
  assert.match(release.if, /needs\.windows\.result == 'success'/);
});

test('Windows and macOS publish blockmaps and run real differential qualification', () => {
  for (const platform of ['windows', 'macos']) {
    const data = workflow(`desktop-${platform}`);
    const steps = Object.values(data.jobs).flatMap(job => job.steps ?? []);
    assert.ok(steps.some(step => step.run?.includes('verify-differential-update.cjs')));
    const uploads = steps.filter(step => step.uses?.startsWith('actions/upload-artifact@'));
    assert.ok(uploads.some(step => step.with.path.includes(platform === 'windows' ? '.exe.blockmap' : '.zip.blockmap')));
  }
  const createManifest = workflow('release').jobs.release.steps.find(step => step.name === 'Create release manifest and checksums');
  assert.equal(createManifest.env.PILOTDECK_DIFFERENTIAL_UPDATES, '${{ vars.PILOTDECK_DIFFERENTIAL_UPDATES }}');
});
