// Retain the old wrapper name so a run started before the workflow migration
// can still receive its one allowed retry after this change reaches main.
const isBuild = job => /^(?:build|Linux|macOS|Windows)(?: \/ |$)/.test(job.name);
const isFailure = job => ['failure', 'timed_out'].includes(job.conclusion);

function eligibleRun(run, repository) {
  return Number.isSafeInteger(run?.id) && run.id > 0
    && run.name === 'Daily Release'
    && run.path === '.github/workflows/release.yml'
    && run.head_repository?.full_name === repository
    && run.head_branch === 'main'
    && ['schedule', 'workflow_dispatch'].includes(run.event)
    && run.status === 'completed' && run.conclusion === 'failure'
    && run.run_attempt === 1;
}

function eligibleJobs(jobs) {
  // A failed build must be the only reason publishing did not run. In
  // particular, never retry a partially published Release or a cancelled build.
  return jobs.length > 0 && jobs.every(job => job.status === 'completed')
    && jobs.some(job => job.name === 'detect' && job.conclusion === 'success')
    && jobs.some(job => job.name === 'release' && job.conclusion === 'skipped')
    && jobs.some(job => isBuild(job) && isFailure(job))
    && jobs.every(job => isBuild(job)
      ? ['success', 'failure', 'timed_out', 'skipped'].includes(job.conclusion)
      : ['success', 'skipped'].includes(job.conclusion));
}

async function retryReleaseBuild({ github, context }) {
  const original = context.payload.workflow_run;
  const repository = `${context.repo.owner}/${context.repo.repo}`;
  const skip = message => ({ retried: false, message });
  if (!eligibleRun(original, repository)) return skip('No retry: only the first failed Daily Release on main is eligible.');

  const params = { ...context.repo, run_id: original.id };
  const jobs = await github.paginate('GET /repos/{owner}/{repo}/actions/runs/{run_id}/attempts/{attempt_number}/jobs', {
    ...params, attempt_number: 1, per_page: 100,
  });
  if (!eligibleJobs(jobs)) return skip('No retry: failure is outside the build stage, a job was cancelled, or publishing already ran.');

  // The completed event can be stale after a manual retry. Check again directly
  // before requesting a rerun; concurrency also serializes duplicate events.
  const { data: latest } = await github.request('GET /repos/{owner}/{repo}/actions/runs/{run_id}', params);
  if (!eligibleRun(latest, repository) || latest.head_sha !== original.head_sha) {
    return skip('No retry: this run has already been retried or its state changed.');
  }

  // GitHub retains successful jobs, detect outputs, source SHA and artifacts.
  // Dependent publishing starts only if all of the retried builds succeed.
  await github.request('POST /repos/{owner}/{repo}/actions/runs/{run_id}/rerun-failed-jobs', params);
  return {
    retried: true,
    message: `Requested the only automatic build retry for Daily Release run ${original.id}. Successful jobs and release metadata are retained.`,
  };
}

module.exports = { retryReleaseBuild };
