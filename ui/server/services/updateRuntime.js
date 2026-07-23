import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { promisify } from 'node:util';

const defaultExecFileAsync = promisify(execFile);

function appendExistingCandidate(candidates, value, pathExists) {
  const candidate = String(value || '').trim();
  if (!candidate || !pathExists(candidate) || candidates.includes(candidate)) return;
  candidates.push(candidate);
}

async function whereExecutables(name, execFileAsync) {
  try {
    const { stdout } = await execFileAsync('where', [name]);
    return String(stdout || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  } catch {
    return [];
  }
}

export async function resolveBashExecutable({
  platform = process.platform,
  env = process.env,
  pathExists = existsSync,
  execFileAsync = defaultExecFileAsync,
} = {}) {
  const configuredPath = String(env.PILOTDECK_BASH_PATH || '').trim();
  if (configuredPath && pathExists(configuredPath)) return configuredPath;
  if (platform !== 'win32') return 'bash';

  const pathApi = path.win32;
  const candidates = [];
  for (const entry of String(env.PATH || '').split(pathApi.delimiter)) {
    const directory = String(entry || '').trim();
    if (!directory) continue;
    appendExistingCandidate(candidates, pathApi.join(directory, 'bash.exe'), pathExists);
  }

  for (const candidate of await whereExecutables('bash', execFileAsync)) {
    appendExistingCandidate(candidates, candidate, pathExists);
  }

  const gitPath = (await whereExecutables('git', execFileAsync))[0];
  if (gitPath) {
    const gitRoot = pathApi.resolve(pathApi.dirname(gitPath), '..');
    appendExistingCandidate(candidates, pathApi.join(gitRoot, 'bin', 'bash.exe'), pathExists);
    appendExistingCandidate(candidates, pathApi.join(gitRoot, 'usr', 'bin', 'bash.exe'), pathExists);
  }

  [
    'C:\\Program Files\\Git\\bin\\bash.exe',
    'C:\\Program Files\\Git\\usr\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\bin\\bash.exe',
    'C:\\Program Files (x86)\\Git\\usr\\bin\\bash.exe',
  ].forEach((candidate) => appendExistingCandidate(candidates, candidate, pathExists));

  return candidates[0] || 'bash';
}

export async function resolveRestartCommand({
  platform = process.platform,
  env = process.env,
  projectRoot,
  pathExists = existsSync,
  execFileAsync = defaultExecFileAsync,
} = {}) {
  if (platform === 'win32') {
    return {
      command: 'cmd.exe',
      args: [
        '/d',
        '/s',
        '/c',
        `timeout /t 2 /nobreak >nul && cd /d "${projectRoot}" && npm run dev`,
      ],
    };
  }

  const bashExecutable = await resolveBashExecutable({
    platform,
    env,
    pathExists,
    execFileAsync,
  });
  return {
    command: bashExecutable,
    args: ['-c', `sleep 2 && cd "${projectRoot}" && npm run dev`],
  };
}

export function normalizeUpdateRuntimeError(error) {
  if (error?.code === 'ENOENT') {
    return 'Unable to locate a bash executable. Install Git Bash and set PILOTDECK_BASH_PATH if needed.';
  }
  return error instanceof Error ? error.message : String(error);
}
