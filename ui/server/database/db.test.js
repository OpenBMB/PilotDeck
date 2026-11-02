// @vitest-environment node
import { spawnSync } from 'node:child_process';
import { chmodSync, copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { expect, it } from 'vitest';

it.each([false, true])('opens a user database before other services load (custom path: %s)', custom => {
  const root = mkdtempSync(join(tmpdir(), 'pilotdeck-database-startup-'));
  const install = join(root, 'installation');
  const databaseDir = join(install, 'database');
  const home = join(root, 'home');
  const database = join(home, custom ? 'custom/auth.db' : 'auth.db');
  const config = join(root, 'pilotdeck.yaml');
  try {
    mkdirSync(databaseDir, { recursive: true });
    mkdirSync(join(database, '..'), { recursive: true });
    writeFileSync(database, '');
    writeFileSync(join(install, 'package.json'), '{"type":"module"}');
    symlinkSync(fileURLToPath(new URL('../../node_modules', import.meta.url)), join(install, 'node_modules'), 'junction');
    const envUrl = new URL('../load-env.js', import.meta.url).href;
    writeFileSync(join(databaseDir, 'db.js'), readFileSync(new URL('./db.js', import.meta.url), 'utf8')
      .replace("import '../load-env.js';", `import ${JSON.stringify(envUrl)};`));
    copyFileSync(new URL('./init.sql', import.meta.url), join(databaseDir, 'init.sql'));
    if (custom) writeFileSync(config, `webui:\n  runtime:\n    databasePath: ${JSON.stringify(database)}\n`);
    chmodSync(databaseDir, 0o555);
    const env = { ...process.env, PILOT_HOME: home, PILOTDECK_CONFIG_PATH: config };
    delete env.DATABASE_PATH;
    const result = spawnSync(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', `
      import { db } from ${JSON.stringify(pathToFileURL(join(databaseDir, 'db.js')).href)};
      console.log('DB_PROBE:' + JSON.stringify({ name: db.name, answer: db.prepare('SELECT 1 AS value').get().value }));
      db.close();
    `], { env, encoding: 'utf8', timeout: 15000 });
    expect(result.status, result.stderr).toBe(0);
    const probe = result.stdout.split('\n').find(line => line.startsWith('DB_PROBE:'));
    expect(JSON.parse(probe.slice('DB_PROBE:'.length))).toEqual({ name: database, answer: 1 });
  } finally {
    chmodSync(databaseDir, 0o755);
    rmSync(root, { recursive: true, force: true });
  }
});
