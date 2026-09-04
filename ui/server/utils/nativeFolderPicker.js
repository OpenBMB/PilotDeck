import { execFile } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { promisify } from 'util';

const defaultExecFileAsync = promisify(execFile);
const WINDOWS_FOLDER_DIALOG_SCRIPT_PATH = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  'nativeFolderPicker.win.ps1',
);

const MAC_FOLDER_DIALOG_SCRIPT = [
  'try',
  '  POSIX path of (choose folder)',
  'on error number -128',
  '  return ""',
  'end try',
].join('\n');

const writeUtf16LePowerShellScript = (targetPath, script) => {
  writeFileSync(targetPath, Buffer.concat([
    Buffer.from([0xff, 0xfe]),
    Buffer.from(script.replace(/^\uFEFF/, ''), 'utf16le'),
  ]));
};

const normalizePickedPath = (stdout) => {
  const pickedPath = String(stdout || '').trim().replace(/^['"]|['"]$/g, '');
  return pickedPath || null;
};

const isCancelExit = (error) => {
  const code = error?.code;
  return code === 1 || code === 122;
};

const runDialog = async (execFileAsync, command, args) => {
  try {
    const { stdout } = await execFileAsync(command, args, {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
    return normalizePickedPath(stdout);
  } catch (error) {
    if (isCancelExit(error)) {
      return null;
    }
    const details = [error?.stderr, error?.message].filter(Boolean).join('\n');
    throw new Error(details || 'Failed to open native folder dialog');
  }
};

const pickWindowsFolder = async (execFileAsync) => {
  const tempDirectory = mkdtempSync(path.join(os.tmpdir(), 'pilotdeck-native-folder-picker-'));
  const tempScript = path.join(tempDirectory, 'pilotdeck-native-folder-picker.ps1');
  const script = readFileSync(WINDOWS_FOLDER_DIALOG_SCRIPT_PATH, 'utf8');
  try {
    writeUtf16LePowerShellScript(tempScript, script);
    return await runDialog(execFileAsync, 'powershell.exe', [
      '-NoProfile',
      '-STA',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      tempScript,
    ]);
  } finally {
    rmSync(tempDirectory, { recursive: true, force: true });
  }
};

const pickMacFolder = (execFileAsync) =>
  runDialog(execFileAsync, 'osascript', ['-e', MAC_FOLDER_DIALOG_SCRIPT]);

const pickLinuxFolder = async (execFileAsync) => {
  const candidates = [
    ['zenity', ['--file-selection', '--directory']],
    ['kdialog', ['--getexistingdirectory']],
    ['yad', ['--file-selection', '--directory']],
  ];

  let lastError = null;
  for (const [command, args] of candidates) {
    try {
      return await runDialog(execFileAsync, command, args);
    } catch (error) {
      lastError = error;
      if (error?.code === 'ENOENT') {
        continue;
      }
      throw error;
    }
  }

  throw lastError || new Error('No native folder dialog is available');
};

export async function pickNativeFolder({
  platform = process.platform,
  execFileAsync = defaultExecFileAsync,
} = {}) {
  if (platform === 'win32') {
    return pickWindowsFolder(execFileAsync);
  }
  if (platform === 'darwin') {
    return pickMacFolder(execFileAsync);
  }
  return pickLinuxFolder(execFileAsync);
}
