import { symlinkSync } from 'node:fs';

/** Only file links require an elevated token or Developer Mode on Windows.
 * Directory escape cases should use real junctions so they run on every host. */
export function fileSymlinkOrSkip(context, target, link) {
  try { symlinkSync(target, link, 'file'); }
  catch (error) {
    if (process.platform === 'win32' && error.code === 'EPERM') {
      context.skip('File symlinks require Windows Developer Mode or an elevated token.');
      return false;
    }
    throw error;
  }
  return true;
}
