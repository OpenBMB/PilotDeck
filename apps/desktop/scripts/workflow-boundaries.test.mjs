import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';

const { parse } = createRequire(new URL('../../../package.json', import.meta.url))('yaml');
const workflow = name => parse(readFileSync(new URL(`../../../.github/workflows/${name}.yml`, import.meta.url), 'utf8'));

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

test('PR checks do not inherit signing secrets or enable production macOS packaging', () => {
  const pr = workflow('desktop-smoke');
  assert.equal(pr.permissions.contents, 'read');
  for (const job of Object.values(pr.jobs)) {
    assert.equal(job.secrets, undefined);
    assert.notEqual(job.with?.require_macos_signing, true);
  }
  const mac = workflow('desktop-macos');
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
  for (const [name, job] of Object.entries(release.jobs)) {
    assert.equal(job.permissions?.contents === 'write', name === 'release');
  }
  assert.deepEqual(release.jobs.release.needs, ['detect', 'linux', 'macos', 'windows']);
  const steps = release.jobs.release.steps;
  const verification = steps.findIndex(step => step.run?.includes('verify-release-assets.mjs'));
  const publication = steps.findIndex(step => step.run?.includes('gh release create'));
  assert.ok(verification >= 0 && publication > verification);
});
