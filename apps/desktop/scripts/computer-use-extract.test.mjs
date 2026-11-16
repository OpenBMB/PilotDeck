import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import { extractDriverArchive } from '../../../scripts/prepare-computer-use.mjs';

test('Windows ZIP extraction ignores an incompatible Archive module and handles Unicode paths', { skip: process.platform !== 'win32' }, t => {
  const root = mkdtempSync(join(tmpdir(), 'pilotdeck-driver-zip-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, "源文件 [driver]'"), archive = join(root, "驱动 [archive]'.zip"), output = join(root, '已解压');
  mkdirSync(source); mkdirSync(output);
  writeFileSync(join(source, 'cua-driver.exe'), 'Synthetic driver fixture');
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    "$ErrorActionPreference = 'Stop'; Add-Type -AssemblyName System.IO.Compression.FileSystem; [System.IO.Compression.ZipFile]::CreateFromDirectory($env:ZIP_SOURCE, $env:ZIP_ARCHIVE)"], {
    env: { ...process.env, ZIP_SOURCE: source, ZIP_ARCHIVE: archive }, windowsHide: true,
  });
  const modules = join(root, 'modules'), archiveModule = join(modules, 'Microsoft.PowerShell.Archive');
  mkdirSync(archiveModule, { recursive: true });
  writeFileSync(join(archiveModule, 'Microsoft.PowerShell.Archive.psm1'), "throw 'An incompatible Archive module must not be imported'\n");
  extractDriverArchive(archive, output, { env: { ...process.env, PSModulePath: modules } });
  assert.equal(readFileSync(join(output, 'cua-driver.exe'), 'utf8'), 'Synthetic driver fixture');
  const corrupt = join(root, 'corrupt.zip'); writeFileSync(corrupt, 'Invalid ZIP data');
  assert.throws(() => extractDriverArchive(corrupt, join(root, 'bad-output')));
  assert.equal(readFileSync(join(output, 'cua-driver.exe'), 'utf8'), 'Synthetic driver fixture');
});
