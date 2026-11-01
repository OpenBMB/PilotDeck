// @vitest-environment node
import { afterEach, expect, it } from 'vitest';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { prepareClawHubExecution } from './clawHubCli.js';

const temporaryDirectories = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })),
  );
});

it.each(['development', 'packaged'])(
  'resolves and executes the bundled CLI in the %s layout',
  async (layout) => {
    const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'pilotdeck-clawhub-layout-'));
    temporaryDirectories.push(temporary);
    const root = path.join(
      temporary,
      'Application With Spaces',
      layout === 'packaged' ? 'runtime' : 'project',
    );
    const route = path.join(root, 'ui', 'server', 'routes', 'skills.js');
    const dependencyRoot = layout === 'packaged' ? root : path.join(root, 'ui');
    const packageRoot = path.join(dependencyRoot, 'node_modules', 'clawhub');
    const cli = path.join(packageRoot, 'bin', 'clawdhub.js');
    await fs.mkdir(path.dirname(cli), { recursive: true });
    await fs.writeFile(
      path.join(packageRoot, 'package.json'),
      JSON.stringify({ name: 'clawhub', bin: { clawhub: 'bin/clawdhub.js' } }),
    );
    await fs.writeFile(cli, 'console.log(JSON.stringify(process.argv.slice(2)))');
    const args = ['inspect', '@author/skill', '--file', 'a file & name.md'];
    const execution = prepareClawHubExecution(
      args,
      { timeout: 1000 },
      { moduleUrl: pathToFileURL(route), platform: 'win32' },
    );
    expect(execution.command).toBe(process.execPath);
    expect(execution.args).toEqual([await fs.realpath(cli), ...args]);
    expect(execution.options).toMatchObject({ timeout: 1000, windowsHide: true });
    const { stdout } = await promisify(execFile)(
      execution.command,
      execution.args,
      execution.options,
    );
    expect(JSON.parse(stdout)).toEqual(args);
  },
);

it('runs the legacy Windows PATH fallback through cmd.exe when the bundled CLI is unavailable', async () => {
  const temporary = await fs.mkdtemp(path.join(os.tmpdir(), 'pilotdeck-no-clawhub-'));
  temporaryDirectories.push(temporary);
  const missingPackage = path.join(temporary, 'node_modules', 'clawhub');
  await fs.mkdir(missingPackage, { recursive: true });
  await fs.writeFile(
    path.join(missingPackage, 'package.json'),
    JSON.stringify({ name: 'clawhub', exports: { './bin/clawdhub.js': './missing.js' } }),
  );
  const execution = prepareClawHubExecution(
    ['search', 'report'],
    {},
    { moduleUrl: pathToFileURL(path.join(temporary, 'routes', 'skills.js')), platform: 'win32' },
  );
  expect(execution.command).toBe('cmd.exe');
  expect(execution.args.slice(0, 3)).toEqual(['/d', '/s', '/c']);
  expect(execution.args[3]).toContain('clawhub.cmd');
  expect(execution.options.windowsHide).toBe(true);
});
