import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, realpathSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { createWebUpdateService } from './webUpdateService.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const failure = (reason, message) => Object.assign(new Error(message), { reason });
const reasons = {
  development: 'Developer branches/worktrees and development runtimes do not support self-update.',
  localChanges: 'Local changes are present. Update this workspace manually.',
  container: 'Container deployments must update their image manually.',
  desktop: 'Use the desktop application settings to update this installation.',
  notGit: 'Self-update requires a standard Git deployment.',
  unofficial: 'This checkout does not use the official repository.',
  shallow: 'Shallow Git checkouts do not support self-update.',
  unknownVersion: 'The current build version cannot be identified.',
  runtimeMismatch: 'The running version does not match the checkout/build. Restart it before checking again.',
  ahead: 'This deployment is ahead of the latest Release. Automatic downgrades are disabled.',
  diverged: 'This deployment has diverged from the Release. Update it manually.',
  lockBusy: 'Another update or an unconfirmed cleanup holds the update lock.',
  restartRequired: 'An update is already prepared. Restart the service first.',
};
export function describeUpdateReason(reason) { return `${reason}: ${reasons[reason] || 'The Release update is unavailable. See settings or update manually.'}`; }

// This command runs as the local installation owner. Reuse the existing Web
// authentication; never add an unauthenticated network update endpoint.
async function localHeaders(env) {
  const { DatabaseSync } = await import('node:sqlite');
  const { default: jwt } = await import('jsonwebtoken');
  if (!env.DATABASE_PATH || !existsSync(env.DATABASE_PATH)) throw failure('authenticationRequired', 'Local Web credentials are unavailable. Use settings to update.');
  const db = new DatabaseSync(env.DATABASE_PATH, { readOnly: true });
  try {
    const user = db.prepare('SELECT id, username FROM users ORDER BY id LIMIT 1').get();
    const secret = env.JWT_SECRET || db.prepare("SELECT value FROM app_config WHERE key = 'jwt_secret'").get()?.value;
    if (!user || !secret) throw failure('authenticationRequired', 'Set up the Web user before updating through CLI/IM.');
    return { 'Content-Type': 'application/json', Authorization: `Bearer ${jwt.sign({ userId: user.id, username: user.username }, secret, { expiresIn: '2h' })}`,
      ...(env.API_KEY ? { 'x-api-key': env.API_KEY } : {}) };
  } finally { db.close(); }
}

export async function createCommandClient({ projectRoot = ROOT, env = process.env, fetchImpl = fetch,
  headers = () => localHeaders(env), offline = () => createWebUpdateService({ projectRoot, env }),
} = {}) {
  const port = Number(env.SERVER_PORT || 3001);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw failure('invalidPort', 'SERVER_PORT must identify the local Web service.');
  const base = `http://127.0.0.1:${port}`;
  try {
    const health = await fetchImpl(`${base}/health`, { signal: AbortSignal.timeout(3000), redirect: 'error' });
    if (!health.ok) throw failure('runtimeUnavailable', 'The configured Web port is not healthy. Check SERVER_PORT.');
  } catch (error) {
    if (error.cause?.code !== 'ECONNREFUSED') throw error;
    const service = offline();
    return { check: () => service.check(), apply: (target, output) => service.apply(target, output), restart: null };
  }
  const auth = await headers();
  const request = async (route, body, timeoutMs = 120000) => {
    const response = await fetchImpl(`${base}/api/update/${route}`, {
      method: body === undefined ? 'GET' : 'POST', headers: auth,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }), signal: AbortSignal.timeout(timeoutMs), redirect: 'error',
    });
    if (!response.ok) {
      const detail = await response.json().catch(() => ({}));
      throw failure(detail.reason || 'runtimeUnavailable', detail.message || detail.error || `Web update request failed (${response.status}). Use settings or check SERVER_PORT.`);
    }
    return response;
  };
  const context = await (await request('context')).json();
  if (context.projectRoot !== realpathSync(projectRoot)) throw failure('differentInstallation', 'SERVER_PORT points to another installation. Use the matching Web service.');
  return {
    check: async () => (await request('check', {})).json(),
    apply: async (target, output) => {
      const updateId = randomUUID();
      // The server owns the task even if this progress stream is disconnected.
      // Poll its matching result before allowing a restart, just like settings.
      try {
        const response = await request('apply', { target, updateId }, 60 * 60 * 1000);
        let pending = '';
        const decoder = new TextDecoder();
        for await (const chunk of response.body) {
          pending += decoder.decode(chunk, { stream: true });
          let end;
          while ((end = pending.indexOf('\n')) >= 0) {
            const line = pending.slice(0, end); pending = pending.slice(end + 1);
            if (!line.trim()) continue;
            const event = JSON.parse(line);
            if (event.message) output(event.message);
            if (event.status === 'error') throw failure(event.reason || 'applyFailed', event.message);
            if (event.stage === 'complete' && event.status === 'success') return;
          }
        }
      } catch (error) {
        if (error.reason) throw error;
        output('Update connection interrupted; recovering the server task status...');
      }
      const deadline = Date.now() + 60 * 60 * 1000;
      while (Date.now() < deadline) {
        const status = await (await request('status')).json();
        if (status.lastUpdateResult?.updateId === updateId) {
          if (status.lastUpdateResult.success) return;
          throw failure(status.lastUpdateResult.reason || 'applyFailed', 'The server reported that the update failed.');
        }
        if (!status.updateInProgress || status.currentUpdateId !== updateId) throw failure('updateUnconfirmed', 'Update outcome is unconfirmed. Check settings before retrying or restarting.');
        await new Promise(resolve => setTimeout(resolve, 1000));
      }
      throw failure('updateUnconfirmed', 'Update is still unconfirmed. Check settings before restarting.');
    },
    restart: async () => {
      const result = await (await request('restart', {})).json();
      if (result.status !== 'accepted') throw failure('restartUnconfirmed', 'The runtime did not accept the restart request. Restart manually.');
      return result;
    },
  };
}

export async function runWebUpdateCommand({ checkOnly = false, restart = false, client, output = console.log } = {}) {
  client ||= await createCommandClient();
  const status = await client.check();
  if (status.reason === 'upToDate') { output('Already at the latest Release.'); return 2; }
  if (!status.canUpdate) throw failure(status.reason || 'checkFailed', describeUpdateReason(status.reason || 'checkFailed'));
  output(`Release available: ${status.latest.tagName} (${status.latest.sourceSha.slice(0, 8)})`);
  if (checkOnly) return 0;
  if (restart && !client.restart) throw failure('restartUnavailable', 'No running Web service was found. Run update without --restart, then start PilotDeck manually.');
  await client.apply(status.latest, output);
  if (restart) {
    try { await client.restart(); }
    catch (error) { throw failure('restartFailed', `Update prepared, but restart was not confirmed: ${error.message} Restart manually; do not repeat the update.`); }
    output('Update prepared; the running Web service accepted the restart request.');
  } else output('Update prepared. Restart PilotDeck manually to load the new version.');
  return 0;
}
