import crypto from 'crypto';
import { execFile } from 'child_process';
import fs from 'fs';
import fsPromises from 'fs/promises';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { promisify } from 'util';
import { readPilotDeckConfigFile } from './pilotdeckConfig.js';

const execFileAsync = promisify(execFile);

const officePreviewConversionLocks = new Map();

export const OFFICE_PREVIEW_SERVICE_NONE = 'none';
export const OFFICE_PREVIEW_SERVICE_LIBREOFFICE = 'libreoffice';
export const OFFICE_PREVIEW_CACHE_DIR = path.join(os.tmpdir(), 'pilotdeck-office-preview-cache');
export const LIBREOFFICE_TIMEOUT_MS = Number(process.env.PILOTDECK_LIBREOFFICE_TIMEOUT_MS || 120000);
const OFFICE_PREVIEW_LOCK_STALE_MS = LIBREOFFICE_TIMEOUT_MS + 30000;
const OFFICE_PREVIEW_LOCK_RETRY_MS = 100;

export function getConfiguredOfficePreviewService() {
  try {
    const record = readPilotDeckConfigFile();
    const configured = String(record?.config?.webui?.officePreview?.service || '').trim().toLowerCase();
    return configured === OFFICE_PREVIEW_SERVICE_LIBREOFFICE
      ? OFFICE_PREVIEW_SERVICE_LIBREOFFICE
      : OFFICE_PREVIEW_SERVICE_NONE;
  } catch (error) {
    console.warn('Failed to read Office preview service config; defaulting to disabled:', error.message);
    return OFFICE_PREVIEW_SERVICE_NONE;
  }
}

function getConfiguredLibreOfficeBinaryPath() {
  try {
    const record = readPilotDeckConfigFile();
    return String(record?.config?.webui?.officePreview?.binaryPath || '').trim();
  } catch (error) {
    console.warn('Failed to read LibreOffice binary path config; falling back to auto-detect:', error.message);
    return '';
  }
}

function uniqueCandidates(candidates) {
  return Array.from(new Set(candidates.map((candidate) => String(candidate || '').trim()).filter(Boolean)));
}

function getEnvironmentLibreOfficeCandidates() {
  return uniqueCandidates([
    process.env.LIBREOFFICE_PATH,
    process.env.SOFFICE_PATH,
  ]);
}

function readDirectoryNames(directoryPath) {
  try {
    return fs.readdirSync(directoryPath, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

function getMacLibreOfficeAppCandidates() {
  const appDirectories = [
    '/Applications',
    path.join(os.homedir(), 'Applications'),
  ];
  return appDirectories.flatMap((directoryPath) =>
    readDirectoryNames(directoryPath)
      .filter((name) => /^LibreOffice.*\.app$/i.test(name))
      .map((name) => path.join(directoryPath, name, 'Contents/MacOS/soffice')));
}

function getLinuxOptLibreOfficeCandidates() {
  return readDirectoryNames('/opt')
    .filter((name) => /^libreoffice/i.test(name))
    .map((name) => path.join('/opt', name, 'program/soffice'));
}

export function getWindowsLibreOfficeCandidates(environment = process.env) {
  const programDirectories = uniqueCandidates([
    environment.ProgramW6432,
    environment.ProgramFiles,
    environment['ProgramFiles(x86)'],
    'C:\\Program Files',
    'C:\\Program Files (x86)',
  ]);

  // soffice.exe is a GUI-subsystem launcher. Running it with --version from
  // Node can remain alive until the probe times out, while soffice.com is the
  // console launcher intended for command-line use on Windows.
  return programDirectories.map((directoryPath) =>
    path.win32.join(directoryPath, 'LibreOffice', 'program', 'soffice.com'));
}

function getPlatformLibreOfficeCandidates() {
  const macCandidates = [
    '/Applications/LibreOffice.app/Contents/MacOS/soffice',
    '/opt/homebrew/bin/soffice',
    '/usr/local/bin/soffice',
    ...getMacLibreOfficeAppCandidates(),
  ];
  const linuxCandidates = [
    '/usr/bin/soffice',
    '/usr/bin/libreoffice',
    '/usr/local/bin/soffice',
    '/usr/local/bin/libreoffice',
    '/snap/bin/libreoffice',
    '/opt/libreoffice/program/soffice',
    ...getLinuxOptLibreOfficeCandidates(),
  ];
  const windowsCandidates = getWindowsLibreOfficeCandidates();

  return process.platform === 'darwin'
    ? macCandidates
    : process.platform === 'win32'
      ? windowsCandidates
      : linuxCandidates;
}

function getPathLibreOfficeCandidates() {
  const pathCandidates = [
    'soffice',
    'libreoffice',
  ];
  return pathCandidates;
}

function getAutoLibreOfficeCandidates() {
  return uniqueCandidates([
    ...getEnvironmentLibreOfficeCandidates(),
    ...getPlatformLibreOfficeCandidates(),
    ...getPathLibreOfficeCandidates(),
  ]);
}

function getScannableLibreOfficeCandidates() {
  return uniqueCandidates([
    getConfiguredLibreOfficeBinaryPath(),
    ...getEnvironmentLibreOfficeCandidates(),
    ...getPlatformLibreOfficeCandidates(),
  ]);
}

function getLibreOfficeCandidates() {
  const configured = getConfiguredLibreOfficeBinaryPath();
  return configured ? [configured] : getAutoLibreOfficeCandidates();
}

function createOfficePreviewError(message, statusCode, code) {
  const error = new Error(message);
  error.statusCode = statusCode;
  error.code = code;
  return error;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function findCachedPdf(cacheDir) {
  return (await fsPromises.readdir(cacheDir).catch(() => []))
    .find((name) => name.toLowerCase().endsWith('.pdf')) || null;
}

export async function createLibreOfficeConversionWorkspace(cacheDir) {
  const tempDir = await fsPromises.mkdtemp(path.join(cacheDir, 'convert-'));
  try {
    // Keep the LibreOffice profile close to the system temp root. On Windows,
    // nesting it under the hashed cache/output directory makes LibreOffice's
    // internal profile paths exceed the legacy MAX_PATH limit. In that case
    // soffice exits successfully but silently produces no PDF.
    const profileDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), 'pilotdeck-lo-profile-'));
    return { tempDir, profileDir };
  } catch (error) {
    await fsPromises.rm(tempDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

async function acquireDirectoryLock(lockDir) {
  while (true) {
    try {
      await fsPromises.mkdir(lockDir);
      return async () => {
        await fsPromises.rm(lockDir, { recursive: true, force: true }).catch(() => {});
      };
    } catch (error) {
      if (error?.code !== 'EEXIST') {
        throw error;
      }

      const stats = await fsPromises.stat(lockDir).catch(() => null);
      if (stats && Date.now() - stats.mtimeMs > OFFICE_PREVIEW_LOCK_STALE_MS) {
        await fsPromises.rm(lockDir, { recursive: true, force: true }).catch(() => {});
        continue;
      }

      await sleep(OFFICE_PREVIEW_LOCK_RETRY_MS);
    }
  }
}

async function publishConvertedPdf(tempDir, cacheDir) {
  const outputPdf = await findCachedPdf(tempDir);
  if (!outputPdf) {
    throw createOfficePreviewError('LibreOffice did not produce a PDF preview', 500, 'LIBREOFFICE_OUTPUT_MISSING');
  }

  const sourcePdfPath = resolvePathInsideRoot(tempDir, outputPdf);
  const publishedPdfPath = path.join(cacheDir, outputPdf);
  const pendingPdfPath = `${publishedPdfPath}.${process.pid}.${Date.now()}.tmp`;
  await fsPromises.copyFile(sourcePdfPath, pendingPdfPath);
  await fsPromises.rename(pendingPdfPath, publishedPdfPath);
  return resolvePathInsideRoot(cacheDir, outputPdf);
}

function resolvePathInsideRoot(rootPath, targetPath) {
  const normalizedRoot = path.resolve(rootPath);
  const resolved = path.isAbsolute(targetPath)
    ? path.resolve(targetPath)
    : path.resolve(normalizedRoot, targetPath);

  if (resolved !== normalizedRoot && !resolved.startsWith(normalizedRoot + path.sep)) {
    throw createOfficePreviewError('Path must be under project root', 403, 'OFFICE_PREVIEW_PATH_FORBIDDEN');
  }

  return resolved;
}

async function probeLibreOfficeCandidate(candidate) {
  try {
    const result = await execFileAsync(candidate, ['--version'], {
      timeout: 5000,
      windowsHide: true,
    });
    return {
      binaryPath: candidate,
      available: true,
      version: String(result.stdout || result.stderr || '').trim(),
    };
  } catch (error) {
    return {
      binaryPath: candidate,
      available: false,
      version: '',
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

let libreOfficeStatusPromise = null;
let libreOfficeStatusCacheKey = '';
let libreOfficeCandidateStatusesPromise = null;
let libreOfficeCandidateStatusesCacheKey = '';

export async function getLibreOfficeStatus(options = {}) {
  const candidates = getLibreOfficeCandidates();
  const cacheKey = JSON.stringify(candidates);

  if (options.forceRefresh || cacheKey !== libreOfficeStatusCacheKey) {
    libreOfficeStatusPromise = null;
    libreOfficeStatusCacheKey = cacheKey;
  }

  if (!libreOfficeStatusPromise) {
    libreOfficeStatusPromise = (async () => {
      for (const candidate of candidates) {
        const result = await probeLibreOfficeCandidate(candidate);
        if (result.available) {
          return {
            available: true,
            binaryPath: result.binaryPath,
            version: result.version,
          };
        }
      }
      return {
        available: false,
        binaryPath: null,
        version: '',
      };
    })();
  }
  return libreOfficeStatusPromise;
}

export async function getLibreOfficeCandidateStatuses(options = {}) {
  const candidates = getScannableLibreOfficeCandidates();
  const cacheKey = JSON.stringify(candidates);

  if (options.forceRefresh || cacheKey !== libreOfficeCandidateStatusesCacheKey) {
    libreOfficeCandidateStatusesPromise = null;
    libreOfficeCandidateStatusesCacheKey = cacheKey;
  }

  if (!libreOfficeCandidateStatusesPromise) {
    libreOfficeCandidateStatusesPromise = Promise.all(
      candidates.map((candidate) => probeLibreOfficeCandidate(candidate)),
    );
  }

  return libreOfficeCandidateStatusesPromise;
}

async function getLibreOfficeBinary() {
  const status = await getLibreOfficeStatus();
  return status.available ? status.binaryPath : null;
}

export async function convertOfficeDocumentToPdf(sourcePath, options = {}) {
  const resolvedSourcePath = options.projectRoot
    ? resolvePathInsideRoot(options.projectRoot, sourcePath)
    : path.resolve(sourcePath);
  const binary = await getLibreOfficeBinary();
  if (!binary) {
    throw createOfficePreviewError('LibreOffice executable not found', 501, 'LIBREOFFICE_NOT_FOUND');
  }

  const stats = await fsPromises.stat(resolvedSourcePath);
  if (!stats.isFile()) {
    throw createOfficePreviewError('Office preview source is not a file', 404, 'OFFICE_PREVIEW_SOURCE_NOT_FOUND');
  }
  const cacheKey = crypto
    .createHash('sha256')
    .update(`${resolvedSourcePath}:${stats.size}:${stats.mtimeMs}`)
    .digest('hex');
  const cacheDir = path.join(OFFICE_PREVIEW_CACHE_DIR, cacheKey);

  const existingLock = officePreviewConversionLocks.get(cacheKey);
  const conversionPromise = (async () => {
    if (existingLock) {
      if (!options.force) {
        return existingLock;
      }
      await existingLock.catch(() => {});
    }

    return convertOfficeDocumentToPdfWithCache({
      binary,
      cacheDir,
      force: options.force,
      resolvedSourcePath,
    });
  })();
  officePreviewConversionLocks.set(cacheKey, conversionPromise);

  try {
    return await conversionPromise;
  } finally {
    if (officePreviewConversionLocks.get(cacheKey) === conversionPromise) {
      officePreviewConversionLocks.delete(cacheKey);
    }
  }
}

async function convertOfficeDocumentToPdfWithCache({
  binary,
  cacheDir,
  force,
  resolvedSourcePath,
}) {
  const lockDir = `${cacheDir}.lock`;
  let releaseLock = null;

  await fsPromises.mkdir(cacheDir, { recursive: true });

  if (!force) {
    const cachedPdf = await findCachedPdf(cacheDir);
    if (cachedPdf) {
      return resolvePathInsideRoot(cacheDir, cachedPdf);
    }
  }

  releaseLock = await acquireDirectoryLock(lockDir);

  try {
    if (force) {
      const entries = await fsPromises.readdir(cacheDir).catch(() => []);
      await Promise.all(entries.map((entry) => fsPromises.rm(path.join(cacheDir, entry), { recursive: true, force: true }).catch(() => {})));
    }

    const lockedCachedPdf = await findCachedPdf(cacheDir);
    if (lockedCachedPdf) {
      return resolvePathInsideRoot(cacheDir, lockedCachedPdf);
    }

    const { tempDir, profileDir } = await createLibreOfficeConversionWorkspace(cacheDir);

    const args = [
      `-env:UserInstallation=${pathToFileURL(profileDir).href}`,
      '--headless',
      '--nologo',
      '--nodefault',
      '--nolockcheck',
      '--nofirststartwizard',
      '--convert-to',
      'pdf',
      '--outdir',
      tempDir,
      resolvedSourcePath,
    ];

    try {
      let conversionOutput;
      try {
        conversionOutput = await execFileAsync(binary, args, {
          timeout: LIBREOFFICE_TIMEOUT_MS,
          maxBuffer: 8 * 1024 * 1024,
          windowsHide: true,
        });
      } catch (error) {
        error.statusCode = 500;
        error.code = error.code || 'LIBREOFFICE_CONVERT_FAILED';
        throw error;
      }

      try {
        return await publishConvertedPdf(tempDir, cacheDir);
      } catch (error) {
        error.stdout = String(conversionOutput.stdout || '').trim();
        error.stderr = String(conversionOutput.stderr || '').trim();
        throw error;
      }
    } finally {
      await Promise.all([
        fsPromises.rm(tempDir, { recursive: true, force: true }).catch(() => {}),
        fsPromises.rm(profileDir, { recursive: true, force: true }).catch(() => {}),
      ]);
    }
  } finally {
    if (releaseLock) {
      await releaseLock();
    }

    const entries = await fsPromises.readdir(cacheDir).catch(() => []);
    await Promise.all(entries
      .filter((entry) => entry.startsWith('convert-') || entry.endsWith('.tmp'))
      .map((entry) => fsPromises.rm(path.join(cacheDir, entry), { recursive: true, force: true }).catch(() => {})));
  }
}
