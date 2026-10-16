import { spawn } from 'node:child_process';
import { dirname, resolve, join } from 'node:path';
import { homedir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { readLocalSopConfig } from '../ui/server/localSopRuntime.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const env = { ...process.env };
env.PILOTDECK_CONFIG_PATH = resolve(env.PILOTDECK_CONFIG_PATH || join(env.PILOT_HOME || join(homedir(), '.pilotdeck'), 'pilotdeck.yaml'));
if (!readLocalSopConfig(env)) throw new Error('Enable modules.sop.localRuntime.enabled in your PilotDeck YAML first. See NATIVE-SOP.md.');
let child;
let stopping = false;
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { stopping = true; child?.kill(signal); });
const run = (command, args) => new Promise((resolveRun, reject) => {
  child = spawn(command, args, { cwd: root, env, stdio: 'inherit' });
  child.once('error', reject);
  child.once('exit', (code, signal) => code === 0 ? resolveRun() : reject(new Error(`Command exited (${code ?? signal})`)));
});
try {
  // Frontend composition must use exactly the profile used at runtime.
  await run(process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm', ['run', 'build:web']);
  if (!stopping) await run(process.execPath, ['ui/server/webRuntimeSupervisor.js', 'start-built']);
} catch (error) {
  if (!stopping) { console.error(error.message); process.exitCode = 1; }
}
