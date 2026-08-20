import { describe, expect, it } from 'vitest';

import {
  prepareCliSpawn,
  resolveWindowsCliCommand,
} from './processSpawn.js';

describe('Windows CLI spawning', () => {
  it('runs command shims through cmd.exe with escaped verbatim arguments', () => {
    expect(prepareCliSpawn(
      'npm',
      ['run', 'x & calc', '100%', '"quoted"'],
      { cwd: 'C:/work' },
      'win32',
    )).toEqual({
      command: 'cmd.exe',
      args: [
        '/d',
        '/s',
        '/c',
        '""npm.cmd" "run" "x ^& calc" "100^%" "^"quoted^"""',
      ],
      options: {
        cwd: 'C:/work',
        shell: false,
        windowsHide: true,
        windowsVerbatimArguments: true,
      },
    });
  });

  it('does not wrap native executables or non-Windows commands', () => {
    expect(resolveWindowsCliCommand('which', 'win32')).toBe('where.exe');
    expect(prepareCliSpawn('tool.exe', ['a&b'], {}, 'win32')).toEqual({
      command: 'tool.exe',
      args: ['a&b'],
      options: { shell: false, windowsHide: true },
    });
    expect(prepareCliSpawn('npm', ['test'], { shell: true }, 'linux')).toEqual({
      command: 'npm',
      args: ['test'],
      options: { shell: true },
    });
  });
});
