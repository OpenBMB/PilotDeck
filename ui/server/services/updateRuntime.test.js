import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import {
  getRestartRequestFile,
  isSupervisorRestartEnabled,
  normalizeUpdateRuntimeError,
  requestSupervisorRestart,
  resolveBashExecutable,
  resolveRestartCommand,
} from './updateRuntime.js';

describe('update runtime resolution', () => {
  it('keeps the default bash command on non-Windows platforms', async () => {
    await expect(resolveBashExecutable({
      platform: 'darwin',
      env: {},
      pathExists: () => false,
    })).resolves.toBe('bash');
  });

  it('prefers an explicitly configured bash executable', async () => {
    await expect(resolveBashExecutable({
      platform: 'win32',
      env: { PILOTDECK_BASH_PATH: 'D:\\Tools\\bash.exe' },
      pathExists: (candidate) => candidate === 'D:\\Tools\\bash.exe',
    })).resolves.toBe('D:\\Tools\\bash.exe');
  });

  it('finds bash beside a Windows PATH entry', async () => {
    const toolsDirectory = path.win32.join('C:\\', 'Tools');
    const expected = path.win32.join(toolsDirectory, 'bash.exe');

    await expect(resolveBashExecutable({
      platform: 'win32',
      env: { PATH: toolsDirectory },
      pathExists: (candidate) => candidate === expected,
      execFileAsync: vi.fn(),
    })).resolves.toBe(expected);
  });

  it('falls back to the Git for Windows installation discovered by where git', async () => {
    const gitExecutable = path.win32.join('C:\\', 'Program Files', 'Git', 'cmd', 'git.exe');
    const expected = path.win32.join('C:\\', 'Program Files', 'Git', 'bin', 'bash.exe');
    const execFileAsync = vi.fn(async (_command, args) => {
      if (args[0] === 'git') return { stdout: `${gitExecutable}\r\n` };
      throw new Error('not found');
    });

    await expect(resolveBashExecutable({
      platform: 'win32',
      env: {},
      pathExists: (candidate) => candidate === expected,
      execFileAsync,
    })).resolves.toBe(expected);
  });

  it('prefers Git Bash over the Windows WSL bash launcher', async () => {
    const systemBash = path.win32.join('C:\\', 'Windows', 'System32', 'bash.exe');
    const gitExecutable = path.win32.join('C:\\', 'Program Files', 'Git', 'cmd', 'git.exe');
    const gitBash = path.win32.join('C:\\', 'Program Files', 'Git', 'bin', 'bash.exe');
    const existing = new Set([systemBash, gitBash]);
    const execFileAsync = vi.fn(async (_command, args) => {
      if (args[0] === 'git') return { stdout: `${gitExecutable}\r\n` };
      if (args[0] === 'bash') return { stdout: `${systemBash}\r\n` };
      throw new Error('not found');
    });

    await expect(resolveBashExecutable({
      platform: 'win32',
      env: {
        PATH: [
          path.win32.dirname(systemBash),
          path.win32.dirname(gitExecutable),
        ].join(path.win32.delimiter),
        SystemRoot: 'C:\\Windows',
      },
      pathExists: (candidate) => existing.has(candidate),
      execFileAsync,
    })).resolves.toBe(gitBash);
  });

  it('rejects the WSL bash launcher when no compatible Windows bash exists', async () => {
    const systemBash = path.win32.join('C:\\', 'Windows', 'System32', 'bash.exe');
    const execFileAsync = vi.fn(async (_command, args) => {
      if (args[0] === 'bash') return { stdout: `${systemBash}\r\n` };
      throw new Error('not found');
    });

    await expect(resolveBashExecutable({
      platform: 'win32',
      env: {
        PATH: path.win32.dirname(systemBash),
        SystemRoot: 'C:\\Windows',
      },
      pathExists: (candidate) => candidate === systemBash,
      execFileAsync,
    })).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('defaults Windows restarts to the built source server', async () => {
    const command = await resolveRestartCommand({
      platform: 'win32',
      projectRoot: 'C:\\PilotDeck',
    });

    expect(command.command).toBe('cmd.exe');
    expect(command.args.at(-1)).toContain('cd /d "C:\\PilotDeck\\ui" && npm run start:built');
  });

  it('keeps dev mode for Windows restarts when launched in dev mode', async () => {
    const command = await resolveRestartCommand({
      platform: 'win32',
      env: { PILOTDECK_RESTART_MODE: 'dev' },
      projectRoot: 'C:\\PilotDeck',
    });

    expect(command.command).toBe('cmd.exe');
    expect(command.args.at(-1)).toContain('cd /d "C:\\PilotDeck" && npm run dev');
  });

  it('defaults non-Windows restarts to the built source server', async () => {
    const command = await resolveRestartCommand({
      platform: 'darwin',
      env: {},
      projectRoot: '/opt/pilotdeck',
    });

    expect(command.command).toBe('bash');
    expect(command.args).toEqual(['-c', 'sleep 2 && cd "/opt/pilotdeck/ui" && npm run start:built']);
  });

  it('keeps dev mode for non-Windows restarts when launched in dev mode', async () => {
    const command = await resolveRestartCommand({
      platform: 'darwin',
      env: { PILOTDECK_RESTART_MODE: 'dev' },
      projectRoot: '/opt/pilotdeck',
    });

    expect(command.command).toBe('bash');
    expect(command.args).toEqual(['-c', 'sleep 2 && cd "/opt/pilotdeck" && npm run dev']);
  });

  it('provides an actionable message when bash cannot be spawned', () => {
    expect(normalizeUpdateRuntimeError(Object.assign(new Error('spawn failed'), {
      code: 'ENOENT',
    }))).toContain('PILOTDECK_BASH_PATH');
  });

  it('detects supervisor restarts only when a request file is configured', () => {
    expect(isSupervisorRestartEnabled({
      PILOTDECK_RESTART_SUPERVISOR: '1',
      PILOTDECK_RESTART_REQUEST_FILE: '/tmp/pilotdeck-restart.json',
    })).toBe(true);
    expect(isSupervisorRestartEnabled({
      PILOTDECK_RESTART_SUPERVISOR: '1',
    })).toBe(false);
    expect(isSupervisorRestartEnabled({
      PILOTDECK_RESTART_REQUEST_FILE: '/tmp/pilotdeck-restart.json',
    })).toBe(false);
  });

  it('writes the supervisor restart request file', () => {
    const mkdir = vi.fn();
    const writeFile = vi.fn();
    const filePath = requestSupervisorRestart({
      env: {
        PILOTDECK_RESTART_MODE: 'dev',
        PILOTDECK_RESTART_REQUEST_FILE: '/tmp/pilotdeck/restart.json',
      },
      now: () => new Date('2026-08-21T00:00:00.000Z'),
      mkdir,
      writeFile,
    });

    expect(filePath).toBe('/tmp/pilotdeck/restart.json');
    expect(mkdir).toHaveBeenCalledWith('/tmp/pilotdeck', { recursive: true });
    expect(writeFile).toHaveBeenCalledWith(
      '/tmp/pilotdeck/restart.json',
      expect.stringContaining('"mode": "dev"'),
    );
  });

  it('derives a temp restart request file when none is configured', () => {
    expect(getRestartRequestFile({
      env: { PILOTDECK_RESTART_MODE: 'start-built' },
      pid: 123,
      tmpdir: () => '/tmp',
    })).toBe(path.join('/tmp', 'pilotdeck-restart-start-built-123.json'));
  });
});
