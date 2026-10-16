import { pathToFileURL } from 'node:url';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

const [pd, home, project, phase = 'normal'] = process.argv.slice(2);
const { ensureProjectBinding } = await import(pathToFileURL(join(pd, 'dist/src/pilot/staffdeck/projectBinding.js')));
const env = { ...process.env, ...JSON.parse(readFileSync(join(home, '../env.json'), 'utf8')), PILOT_HOME: home };
const request = async (url, options) => {
  if (phase === 'uuid' && url.pathname === '/api/auth/me') process.kill(process.pid, 'SIGKILL');
  if (phase === 'before-commit' && url.pathname.endsWith('agents:ensure-project-binding')) process.kill(process.pid, 'SIGKILL');
  const response = await fetch(url, options);
  if (phase === 'after-commit' && url.pathname.endsWith('agents:ensure-project-binding')) process.kill(process.pid, 'SIGKILL');
  return response;
};
const activate = async () => {
  if (phase === 'activation') process.kill(process.pid, 'SIGKILL');
  if (phase === 'after-activation') {
    // Return control to the activation boundary while preventing the following state commit.
    queueMicrotask(() => process.kill(process.pid, 'SIGKILL'));
  }
};
const values = await Promise.all(Array.from({ length: phase === 'normal' ? 20 : 1 }, () =>
  ensureProjectBinding(project, { env, request, activate })));
if (values.some(value => value.agentId !== values[0].agentId || value.bindingId !== values[0].bindingId)) {
  throw new Error('Concurrent requests disagree on project identity');
}
console.log(JSON.stringify({ ...values[0], localRequests: values.length }));
