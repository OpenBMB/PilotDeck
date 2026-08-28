import { describe, expect, it, vi } from 'vitest';
import { pickNativeFolder } from './nativeFolderPicker.js';

describe('pickNativeFolder', () => {
  it('opens the Windows folder dialog without a preset path', async () => {
    const execFileAsync = vi.fn().mockResolvedValue({ stdout: 'C:\\Users\\wukai\\Desktop\n' });

    await expect(pickNativeFolder({ platform: 'win32', execFileAsync })).resolves.toBe(
      'C:\\Users\\wukai\\Desktop',
    );

    expect(execFileAsync).toHaveBeenCalledTimes(1);
    const [command, args, options] = execFileAsync.mock.calls[0];
    expect(command).toBe('powershell.exe');
    expect(args).toEqual(expect.arrayContaining(['-STA', '-File']));
    expect(args.at(-1)).toMatch(/pilotdeck-native-folder-picker\.ps1$/);
    expect(options.windowsHide).toBe(true);
  });

  it('opens the macOS folder dialog without a default location', async () => {
    const execFileAsync = vi.fn().mockResolvedValue({ stdout: '/Users/wukai/Projects\n' });

    await expect(pickNativeFolder({ platform: 'darwin', execFileAsync })).resolves.toBe(
      '/Users/wukai/Projects',
    );

    const [command, args] = execFileAsync.mock.calls[0];
    expect(command).toBe('osascript');
    expect(args[1]).toContain('choose folder');
    expect(args[1]).not.toContain('default location');
  });

  it('opens the Linux folder dialog without a starting filename', async () => {
    const execFileAsync = vi.fn().mockResolvedValue({ stdout: '/home/wukai/code\n' });

    await expect(pickNativeFolder({ platform: 'linux', execFileAsync })).resolves.toBe(
      '/home/wukai/code',
    );

    const [command, args] = execFileAsync.mock.calls[0];
    expect(command).toBe('zenity');
    expect(args).toEqual(['--file-selection', '--directory']);
  });

  it('returns null when the user cancels', async () => {
    const execFileAsync = vi.fn().mockResolvedValue({ stdout: '' });

    await expect(pickNativeFolder({ platform: 'win32', execFileAsync })).resolves.toBeNull();
  });
});
