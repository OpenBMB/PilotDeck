import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createInterface } from 'node:readline';
import { once } from 'node:events';
import { redactDiagnostic } from '@pilotdeck/config';

export async function exportRuntimeLogs(logPath: string, destination: string): Promise<void> {
  const directory = path.dirname(logPath);
  const files: string[] = [];
  for (const entry of await fs.promises.readdir(directory, { withFileTypes: true })) {
    if (entry.isFile() && /^(?:runtime|renderer)(?:-\d{4}-\d{2}-\d{2}-[\da-f-]+)?\.log$/.test(entry.name)) files.push(path.join(directory, entry.name));
  }
  const reports = path.join(directory, 'diagnostics');
  try {
    if (!(await fs.promises.lstat(reports)).isSymbolicLink()) {
      for (const entry of await fs.promises.readdir(reports, { withFileTypes: true })) {
        if (entry.isFile() && /^(?:gateway|server|desktop)-[\da-f-]+\.json$/.test(entry.name)) files.push(path.join(reports, entry.name));
      }
    }
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  if (!files.length) throw new Error('No runtime logs available');
  const target = path.resolve(destination);
  const samePath = (left: string, right: string) => process.platform === 'win32' ? left.toLowerCase() === right.toLowerCase() : left === right;
  if (files.some(file => samePath(path.resolve(file), target))) throw new Error('Choose a location outside the active log files');
  const temporary = path.join(path.dirname(target), `.pilotdeck-log-export-${randomUUID()}.tmp`);
  const output = fs.createWriteStream(temporary, { flags: 'wx', mode: 0o600 });
  // Retain the error so asynchronous write failures never become uncaught errors.
  let writeError: Error | undefined;
  output.on('error', error => { writeError = error; });
  const write = async (text: string) => {
    if (writeError) throw writeError;
    if (!output.write(text)) await once(output, 'drain');
  };
  try {
    await once(output, 'open');
    await write(`PilotDeck runtime logs — ${new Date().toISOString()}\n`);
    for (const file of files.sort()) {
      await write(`\n===== ${path.relative(directory, file)} =====\n`);
      let input: fs.ReadStream | undefined;
      try {
        input = fs.createReadStream(file);
        const lines = createInterface({ input, crlfDelay: Infinity });
        for await (const line of lines) await write(`${redactDiagnostic(line)}\n`);
      } catch (error) {
        // Rotation can remove an expired archive while the user is saving.
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      } finally { input?.destroy(); }
    }
    output.end();
    await once(output, 'close');
    if (writeError) throw writeError;
    await fs.promises.rename(temporary, target);
  } finally {
    output.destroy();
    if (!output.closed) await once(output, 'close').catch(() => {});
    await fs.promises.rm(temporary, { force: true }).catch(() => {});
  }
}
