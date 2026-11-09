import { execFile } from 'node:child_process';
import { access, realpath } from 'node:fs/promises';
import { constants } from 'node:fs';
import { delimiter, isAbsolute, join } from 'node:path';
import { promisify } from 'node:util';

export type GitRuntimeStatus = {
  state: 'ready' | 'unavailable';
  source: 'bundled' | 'configured' | 'system';
  version?: string;
  executable?: string;
};
const execute = promisify(execFile);
type RunOptions = { env: NodeJS.ProcessEnv; windowsHide: boolean; timeout: number; maxBuffer: number };
type Run = (file: string, args: string[], options: RunOptions) => Promise<{ stdout: string }>;
const probe: Run = (file, args, options) => execute(file, args, options);
const value = (env: NodeJS.ProcessEnv, name: string) => process.platform === 'win32'
  ? env[Object.keys(env).sort().find(key => key.toUpperCase() === name && env[key] !== undefined) ?? name]
  : env[name];

/** Reports the execution host's Git; never installs tools or reads repositories. */
export async function getGitRuntimeStatus({ env = process.env, run = probe }: { env?: NodeJS.ProcessEnv; run?: Run } = {}): Promise<GitRuntimeStatus> {
  const configured = env.PILOTDECK_GIT_PATH;
  const declared = configured && isAbsolute(configured) ? await realpath(configured).catch(() => undefined) : undefined;
  const candidates = (value(env, 'PATH') || '').split(delimiter).filter(Boolean)
    .map(directory => join(directory.replace(/^"|"$/g, ''), process.platform === 'win32' ? 'git.exe' : 'git'));
  for (const candidate of candidates) {
    if (!isAbsolute(candidate)) continue;
    try { await access(candidate, constants.X_OK); } catch { continue; }
    const executable = await realpath(candidate).catch(() => candidate);
    const source = executable === declared ? env.PILOTDECK_BUNDLED_GIT === '1' ? 'bundled' : 'configured' : 'system';
    try {
      const { stdout } = await run(executable, ['--version'], { env, windowsHide: true, timeout: 5000, maxBuffer: 16 * 1024 });
      const version = /^git version ([^\r\n]+)$/.exec(stdout.trim())?.[1];
      if (!version) return { state: 'unavailable', source };
      return { state: 'ready', source, executable, version };
    } catch { return { state: 'unavailable', source }; }
  }
  return { state: 'unavailable', source: 'system' };
}
