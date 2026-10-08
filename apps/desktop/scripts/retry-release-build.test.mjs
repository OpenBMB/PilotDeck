import assert from 'node:assert/strict';
import test from 'node:test';
import retry from './retry-release-build.cjs';

const run = {
  id: 34277867930, name: 'Daily Release', path: '.github/workflows/release.yml',
  head_repository: { full_name: 'OpenBMB/PilotDeck' }, head_branch: 'main',
  head_sha: '17aa46d0c55b83ae1d35658971ecc1c2a1e4ce14',
  event: 'schedule', status: 'completed', conclusion: 'failure', run_attempt: 1,
};
const job = (name, conclusion) => ({ name, conclusion, status: 'completed' });
const jobs = [
  job('detect', 'success'), job('build / macOS arm64', 'success'),
  job('build / macOS x64', 'success'), job('build / windows / build', 'failure'),
  job('release', 'skipped'), job('skipped', 'skipped'),
];

function fixture({ event = run, current = event, results = jobs } = {}) {
  const calls = [];
  const github = {
    paginate: async (route, params) => { calls.push({ route, params }); return results; },
    request: async (route, params) => {
      calls.push({ route, params });
      return { data: route.startsWith('GET ') ? current : undefined };
    },
  };
  const context = { repo: { owner: 'OpenBMB', repo: 'PilotDeck' }, payload: { workflow_run: event } };
  return { github, context, calls, execute: () => retry.retryReleaseBuild({ github, context }) };
}

for (const event of ['schedule', 'workflow_dispatch']) {
  test(`${event}: retries the failed build and dependents using the original run`, async () => {
    const f = fixture({ event: { ...run, event } });
    assert.equal((await f.execute()).retried, true);
    assert.deepEqual(f.calls, [
      {
        route: 'GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/jobs',
        params: { owner: 'OpenBMB', repo: 'PilotDeck', run_id: run.id, attempt_number: 1, per_page: 100 },
      },
      { route: 'GET /repos/{owner}/{repo}/actions/runs/{run_id}', params: { owner: 'OpenBMB', repo: 'PilotDeck', run_id: run.id } },
      { route: 'POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun-failed-jobs', params: { owner: 'OpenBMB', repo: 'PilotDeck', run_id: run.id } },
    ]);
  });
}

test('multiple failed platforms are retried with one request', async () => {
  const f = fixture({ results: jobs.map(j => j.name === 'build / macOS x64' ? { ...j, conclusion: 'timed_out' } : j) });
  assert.equal((await f.execute()).retried, true);
  assert.equal(f.calls.filter(c => c.route.startsWith('POST ')).length, 1);
});

test('retries the concise platform job names without retrying publication failures', async () => {
  const results = [job('detect', 'success'), job('Linux / DEB x64', 'success'),
    job('Linux / RPM arm64', 'success'), job('Linux / Fedora arm64', 'success'),
    job('macOS / arm64', 'failure'), job('macOS / x64', 'timed_out'),
    job('Windows / x64', 'success'), job('Windows / arm64', 'failure'),
    job('release', 'skipped'), job('skipped', 'skipped')];
  const f = fixture({ results });
  assert.equal((await f.execute()).retried, true);
  const failedPublication = fixture({ results: results.map(j => j.name === 'release' ? job('release', 'failure') : j) });
  assert.equal((await failedPublication.execute()).retried, false);
  const cancelled = fixture({ results: results.map(j => j.name === 'Windows / arm64' ? job(j.name, 'cancelled') : j) });
  assert.equal((await cancelled.execute()).retried, false);
});

for (const [name, patch] of [
  ['second attempt', { run_attempt: 2 }], ['later manual attempt', { run_attempt: 3 }],
  ['missing attempt', { run_attempt: undefined }], ['successful run', { conclusion: 'success' }],
  ['cancelled run', { conclusion: 'cancelled' }], ['unfinished run', { status: 'in_progress' }],
  ['another branch', { head_branch: 'feature' }], ['PR event', { event: 'pull_request' }],
  ['another repository', { head_repository: { full_name: 'someone/PilotDeck' } }],
  ['another workflow', { name: 'Desktop Smoke' }], ['another workflow path', { path: '.github/workflows/other.yml' }],
]) {
  test(`ignores ${name} without requesting a rerun`, async () => {
    const f = fixture({ event: { ...run, ...patch } });
    assert.equal((await f.execute()).retried, false);
    assert.deepEqual(f.calls, []);
  });
}

for (const [name, results] of [
  ['detection failure', jobs.map(j => j.name === 'detect' ? job(j.name, 'failure') : j)],
  ['publication failure', jobs.map(j => j.name === 'release' ? job(j.name, 'failure') : j)],
  ['publication already succeeded', jobs.map(j => j.name === 'release' ? job(j.name, 'success') : j)],
  ['cancelled sibling build', jobs.map(j => j.name === 'build / macOS arm64' ? job(j.name, 'cancelled') : j)],
  ['all builds succeeded', jobs.map(j => j.name === 'build / windows / build' ? job(j.name, 'success') : j)],
  ['unknown failed job', [...jobs, job('new-stage', 'failure')]],
  ['unfinished job', jobs.map(j => j.name === 'release' ? { ...j, status: 'queued' } : j)],
  ['missing jobs', []], ['missing release job', jobs.filter(j => j.name !== 'release')],
]) {
  test(`does not retry ${name}`, async () => {
    const f = fixture({ results });
    assert.equal((await f.execute()).retried, false);
    assert.equal(f.calls.some(c => c.route.startsWith('POST ')), false);
  });
}

for (const patch of [{ run_attempt: 2 }, { status: 'queued' }, { conclusion: 'cancelled' }, { head_sha: 'different' }]) {
  test(`rechecks the live run before retrying: ${JSON.stringify(patch)}`, async () => {
    const f = fixture({ current: { ...run, ...patch } });
    assert.equal((await f.execute()).retried, false);
    assert.equal(f.calls.some(c => c.route.startsWith('POST ')), false);
  });
}

test('a completed retry cannot trigger a third attempt', async () => {
  const f = fixture();
  assert.equal((await f.execute()).retried, true);
  const next = fixture({ event: { ...run, run_attempt: 2 } });
  assert.equal((await next.execute()).retried, false);
  assert.deepEqual(next.calls, []);
});

test('API errors remain failures instead of reporting a successful retry', async () => {
  const f = fixture();
  f.github.request = async () => { throw new Error('GitHub API unavailable'); };
  await assert.rejects(f.execute, /GitHub API unavailable/);
});
