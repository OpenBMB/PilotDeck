import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export function findUpdateRoot(start = path.dirname(fileURLToPath(import.meta.url))): string {
  for (let current = start; ; current = path.dirname(current)) {
    if (existsSync(path.join(current, 'scripts/update-web.mjs'))) return current;
    if (path.dirname(current) === current) throw new Error('This installation does not include the Git Web updater. Use application settings or update manually.');
  }
}

/** Shared CLI/IM entry: bounded output, no legacy git comparison or self-exit. */
export function runUpdateProcess(args: string[], { output, projectRoot = findUpdateRoot(), spawnImpl = spawn }: {
  output?: (chunk: string) => void; projectRoot?: string; spawnImpl?: typeof spawn;
} = {}): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    const child = spawnImpl(process.execPath, [path.join(projectRoot, 'scripts/update-web.mjs'), ...args], {
      cwd: projectRoot, env: process.env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true,
    });
    let tail = '';
    const collect = (chunk: Buffer) => { const text = chunk.toString(); tail = (tail + text).slice(-12000); output?.(text); };
    child.stdout?.on('data', collect); child.stderr?.on('data', collect);
    child.once('error', reject);
    child.once('close', code => resolve({ code: code ?? 1, output: tail.trim() }));
  });
}
