import { describe, expect, it } from 'vitest';
import { getDefaultPtyShell, resolveWindowsGitBash } from './defaultShell.js';

describe('resolveWindowsGitBash', () => {
    it('prefers explicit PilotDeck Git Bash path', () => {
        const env = {
            PILOTDECK_GIT_BASH_PATH: 'D:\\Git\\bin\\bash.exe',
            ProgramFiles: 'C:\\Program Files',
        };
        const shell = resolveWindowsGitBash(env, (candidate) => candidate === 'D:\\Git\\bin\\bash.exe');
        expect(shell).toBe('D:\\Git\\bin\\bash.exe');
    });

    it('falls back to Git for Windows under Program Files', () => {
        const env = { ProgramFiles: 'C:\\Program Files' };
        const shell = resolveWindowsGitBash(env, (candidate) => candidate === 'C:\\Program Files\\Git\\bin\\bash.exe');
        expect(shell).toBe('C:\\Program Files\\Git\\bin\\bash.exe');
    });
});

describe('getDefaultPtyShell', () => {
    it('uses Git Bash by default on Windows when available', () => {
        const config = getDefaultPtyShell(
            'win32',
            { ProgramFiles: 'C:\\Program Files' },
            (candidate) => candidate === 'C:\\Program Files\\Git\\bin\\bash.exe',
        );
        expect(config).toEqual({
            shell: 'C:\\Program Files\\Git\\bin\\bash.exe',
            args: expect.any(Function),
            kind: 'git-bash',
        });
        expect(config.args('echo ok')).toEqual(['--login', '-i', '-c', 'echo ok']);
    });

    it('falls back to PowerShell on Windows when Git Bash is unavailable', () => {
        const config = getDefaultPtyShell('win32', {}, () => false);
        expect(config.shell).toBe('powershell.exe');
        expect(config.kind).toBe('powershell');
        expect(config.args('Write-Output ok')).toEqual(['-NoProfile', '-Command', 'Write-Output ok']);
    });

    it('uses bash on non-Windows platforms', () => {
        const config = getDefaultPtyShell('darwin', {}, () => false);
        expect(config.shell).toBe('bash');
        expect(config.kind).toBe('bash');
        expect(config.args('echo ok')).toEqual(['-c', 'echo ok']);
    });
});
