import { describe, expect, it } from 'vitest';
import { prepareCliSpawn, resolveWindowsCliCommand } from './processSpawn.js';

describe('processSpawn Windows CLI shims', () => {
  it('resolves clawhub to the Windows command shim', () => {
    expect(resolveWindowsCliCommand('clawhub', 'win32')).toBe('clawhub.cmd');
  });

  it('runs Windows command shims through cmd.exe', () => {
    const prepared = prepareCliSpawn('clawhub', ['search', 'browser'], {}, 'win32');

    expect(prepared.command).toBe('cmd.exe');
    expect(prepared.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
    expect(prepared.args[3]).toMatch(/clawhub\.cmd/);
    expect(prepared.args[3]).toMatch(/search/);
    expect(prepared.args[3]).toMatch(/browser/);
    expect(prepared.options.windowsHide).toBe(true);
    expect(prepared.options.windowsVerbatimArguments).toBe(true);
  });
});
