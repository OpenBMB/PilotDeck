import { stat } from 'node:fs/promises';
import path from 'node:path';

/** Open directories only; never send URLs, files or relative paths to the OS. */
export async function openDesktopDirectory(value: unknown, openPath: (directory: string) => Promise<string>): Promise<boolean> {
  if (typeof value !== 'string' || !value || value.includes('\0') || !path.isAbsolute(value)) return false;
  try {
    const directory = path.normalize(value);
    if (!(await stat(directory)).isDirectory()) return false;
    return await openPath(directory) === '';
  } catch { return false; }
}
