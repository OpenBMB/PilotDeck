import crypto from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { inspectPptx, validatePptxPackage } from './ooxml.mjs';
import {
  assertDistinctPaths,
  assertInternalPath,
  fileSha256,
  writeJson,
} from './paths.mjs';
import { loadDependencies } from './runtime.mjs';

const execFileAsync = promisify(execFile);
const PATCH_ENVIRONMENT_KEYS = [
  'HOME',
  'LANG',
  'LC_ALL',
  'PATH',
  'PILOTDECK_WORK_DIR',
  'PPTX_RUNTIME_ROOT',
  'TEMP',
  'TMP',
  'TMPDIR',
];

function digest(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function safePackagePath(value) {
  const normalized = String(value).replaceAll('\\', '/');
  if (!normalized || normalized.startsWith('/') || normalized.includes('\0')) {
    throw new Error(`Unsafe PPTX package path: ${value}`);
  }
  const resolved = path.posix.normalize(normalized);
  if (resolved === '..' || resolved.startsWith('../')) {
    throw new Error(`Unsafe PPTX package path: ${value}`);
  }
  return resolved.replace(/\/$/u, '');
}

async function unpackPackage(inputPath, packageDir) {
  const { JSZip } = loadDependencies();
  const zip = await JSZip.loadAsync(await fs.readFile(inputPath));
  await fs.mkdir(packageDir, { recursive: true });
  for (const name of Object.keys(zip.files).sort()) {
    const entry = zip.files[name];
    const relative = safePackagePath(name);
    if (!relative) continue;
    const destination = path.join(packageDir, ...relative.split('/'));
    if (entry.dir) {
      await fs.mkdir(destination, { recursive: true });
      continue;
    }
    await fs.mkdir(path.dirname(destination), { recursive: true });
    await fs.writeFile(destination, await entry.async('nodebuffer'));
  }
}

async function packageFiles(root, current = root) {
  const results = [];
  for (const entry of await fs.readdir(current, { withFileTypes: true })) {
    const absolute = path.join(current, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Fallback package may not contain symbolic links: ${absolute}`);
    if (entry.isDirectory()) results.push(...await packageFiles(root, absolute));
    else if (entry.isFile()) results.push(path.relative(root, absolute).split(path.sep).join('/'));
    else throw new Error(`Fallback package contains an unsupported filesystem entry: ${absolute}`);
  }
  return results.sort();
}

async function packageHashes(packageDir) {
  const hashes = new Map();
  for (const part of await packageFiles(packageDir)) {
    hashes.set(part, digest(await fs.readFile(path.join(packageDir, ...part.split('/')))));
  }
  return hashes;
}

function packageChanges(before, after) {
  return [...new Set([...before.keys(), ...after.keys()])]
    .sort()
    .filter((part) => before.get(part) !== after.get(part))
    .map((part) => ({
      part,
      action: !before.has(part) ? 'added' : !after.has(part) ? 'deleted' : 'modified',
    }));
}

async function repackPackage(packageDir, outputPath) {
  const { JSZip } = loadDependencies();
  const zip = new JSZip();
  for (const part of await packageFiles(packageDir)) {
    zip.file(part, await fs.readFile(path.join(packageDir, ...part.split('/'))));
  }
  await fs.writeFile(outputPath, await zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 6 },
  }));
}

function patchEnvironment(packageDir) {
  const environment = Object.fromEntries(
    PATCH_ENVIRONMENT_KEYS
      .filter((key) => process.env[key] !== undefined)
      .map((key) => [key, process.env[key]]),
  );
  return {
    ...environment,
    PPTX_FALLBACK_MODE: 'package-patch',
    PPTX_PACKAGE_DIR: packageDir,
  };
}

async function runPatch(script, packageDir, timeoutSeconds) {
  try {
    const result = await execFileAsync(process.execPath, [script, '--package-dir', packageDir], {
      cwd: path.dirname(script),
      env: patchEnvironment(packageDir),
      encoding: 'utf8',
      maxBuffer: 1024 * 1024,
      timeout: timeoutSeconds * 1000,
    });
    return { status: 'ok', stdout: result.stdout ?? '', stderr: result.stderr ?? '' };
  } catch (error) {
    return {
      status: 'error',
      stdout: typeof error?.stdout === 'string' ? error.stdout : '',
      stderr: typeof error?.stderr === 'string' ? error.stderr : '',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function fallbackPatchPptx(options) {
  const input = path.resolve(options.inputPath);
  const script = assertInternalPath(options.scriptPath, 'PPTX fallback script');
  const output = assertInternalPath(options.outputPath, 'PPTX fallback candidate');
  const report = assertInternalPath(
    options.reportPath ?? `${output}.fallback-report.json`,
    'PPTX fallback report',
  );
  assertDistinctPaths({ input, script, candidate: output, report });
  if (path.extname(input).toLowerCase() !== '.pptx' || path.extname(output).toLowerCase() !== '.pptx') {
    throw new Error('PPTX fallback input and output must use .pptx extensions');
  }
  if (!['.js', '.mjs'].includes(path.extname(script).toLowerCase())) {
    throw new Error('PPTX fallback scripts must use .js or .mjs');
  }

  const sourceManifest = await inspectPptx(input);
  const sourceSha256 = sourceManifest.sha256;
  await fs.mkdir(path.dirname(output), { recursive: true });
  const temporaryRoot = await fs.mkdtemp(path.join(path.dirname(output), '.pptx-fallback-'));
  const packageDir = path.join(temporaryRoot, 'package');
  const stagedOutput = path.join(temporaryRoot, 'candidate.pptx');
  let patchResult = { status: 'error', stdout: '', stderr: '', error: 'Patch did not run' };
  let changes = [];

  try {
    await unpackPackage(input, packageDir);
    const before = await packageHashes(packageDir);
    patchResult = await runPatch(script, packageDir, options.timeoutSeconds ?? 120);
    const after = await packageHashes(packageDir);
    changes = packageChanges(before, after);

    if (patchResult.status !== 'ok') {
      throw new Error(`PPTX fallback script failed: ${patchResult.error}`);
    }
    if (changes.length === 0) throw new Error('PPTX fallback script did not change the package');
    if (await fileSha256(input) !== sourceSha256) throw new Error('The PPTX fallback source changed during patching');

    await repackPackage(packageDir, stagedOutput);
    const validation = await validatePptxPackage(stagedOutput);
    const manifest = await inspectPptx(stagedOutput);
    if (manifest.slideCount < 1) throw new Error('PPTX fallback produced an empty presentation');

    await fs.rm(output, { force: true });
    await fs.rename(stagedOutput, output);
    const result = {
      status: 'ok',
      mode: 'package-patch',
      input,
      inputSha256: sourceSha256,
      script,
      scriptSha256: await fileSha256(script),
      output,
      outputSha256: manifest.sha256,
      slideCount: manifest.slideCount,
      changedParts: changes.map((change) => change.part),
      changes,
      validation,
      stdout: patchResult.stdout.slice(-4000),
      stderr: patchResult.stderr.slice(-4000),
    };
    await writeJson(report, result);
    return { ...result, report };
  } catch (error) {
    await writeJson(report, {
      status: 'error',
      mode: 'package-patch',
      input,
      inputSha256: sourceSha256,
      script,
      output,
      changedParts: changes.map((change) => change.part),
      changes,
      stdout: patchResult.stdout.slice(-4000),
      stderr: patchResult.stderr.slice(-4000),
      error: error instanceof Error ? error.message : String(error),
    }).catch(() => {});
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}; see fallback report: ${report}`,
      { cause: error },
    );
  } finally {
    await fs.rm(temporaryRoot, { recursive: true, force: true }).catch(() => {});
  }
}
