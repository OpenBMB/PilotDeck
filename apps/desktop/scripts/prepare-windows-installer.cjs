// Build-only tools. No additional runtime, download or PowerShell compilation is
// required on the user's machine. Keep the upstream upgrade/uninstall lifecycle.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');

function replaceOnce(source, search, replacement) {
  if (source.split(search).length !== 2) {
    throw new Error(`Unsupported electron-builder NSIS template: expected one ${JSON.stringify(search)}`);
  }
  return source.replace(search, replacement);
}

async function prepareWindowsInstaller(desktopRoot = path.resolve(__dirname, '..')) {
  if (process.platform !== 'win32') throw new Error('Prepare the Windows installer on Windows.');
  const builderRequire = createRequire(require.resolve('electron-builder'));
  const libRoot = path.dirname(builderRequire.resolve('app-builder-lib/package.json'));
  const templates = path.join(libRoot, 'templates', 'nsis');
  const output = path.join(desktopRoot, 'resources', '.installer-tools');
  fs.mkdirSync(output, { recursive: true });
  const compiler = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
  execFileSync(compiler, ['/nologo', '/optimize+', '/target:exe', '/platform:anycpu',
    `/out:${path.join(output, 'install-payload.exe')}`,
    path.join(desktopRoot, 'resources', 'installer', 'InstallPayload.cs')], { windowsHide: true, stdio: 'pipe' });

  // Use the same checksum-verified decoder toolset as the archive builder.
  const { getPath7za } = require(path.join(libRoot, 'out', 'toolsets', '7zip.js'));
  const decoder = await getPath7za();
  fs.copyFileSync(decoder, path.join(output, '7za.exe'));
  for (const name of ['LICENSE.txt', 'COPYING']) {
    fs.copyFileSync(path.join(path.dirname(decoder), '..', name), path.join(output, name));
  }

  // nsis.script bypasses electron-builder's uninstaller generation/signing.
  // Instead use a private copy of its templates, retaining the standard target.
  // Never patch node_modules. The Windows integration test exercises this bridge
  // when the locked builder version is updated.
  const stagedTemplates = path.join(output, 'templates');
  fs.cpSync(templates, stagedTemplates, { recursive: true });
  let section = replaceOnce(fs.readFileSync(path.join(templates, 'installSection.nsh'), 'utf8'),
    '!include installer.nsh', '!include installer.nsh\n!include "${PROJECT_DIR}\\resources\\installer-payload.nsh"');
  section = replaceOnce(section, 'SetDetailsPrint none', 'SetDetailsPrint both');
  // Prepare the payload before the upstream uninstaller can touch the old app.
  const begin = section.indexOf('!insertmacro uninstallOldVersion SHELL_CONTEXT');
  const end = section.indexOf('!insertmacro installApplicationFiles');
  if (begin < 0 || end <= begin) throw new Error('Unsupported NSIS installation lifecycle');
  let commit = section.slice(begin, end);
  commit = commit.replace(/(!insertmacro uninstallOldVersion [^\r\n]+)/g,
    '$1\n!insertmacro PilotDeckCheckUninstall');
  section = section.slice(0, begin) + section.slice(end);
  section = replaceOnce(section, 'InitPluginsDir',
    'InitPluginsDir\n!insertmacro PilotDeckConfirmUpgrade\nStrCpy $PilotDeckState "$PLUGINSDIR\\payload.state"');
  section = '!macro PilotDeckReplaceOldVersion\n' + commit + '!macroend\n' + section;
  fs.writeFileSync(path.join(stagedTemplates, 'installSection.nsh'), section);
  // The directory page is skipped for --updated, but the install-page
  // pre-callback still appends APP_FILENAME to custom paths. A visible updater
  // must retain the registered installation directory byte for byte.
  let assisted = fs.readFileSync(path.join(templates, 'assistedInstaller.nsh'), 'utf8');
  assisted = replaceOnce(assisted, 'Function instFilesPre\n      ${StrContains}',
    'Function instFilesPre\n      ${If} ${isUpdated}\n        Return\n      ${EndIf}\n      ${StrContains}');
  fs.writeFileSync(path.join(stagedTemplates, 'assistedInstaller.nsh'), assisted);
  const nsisUtil = require(path.join(libRoot, 'out', 'targets', 'nsis', 'nsisUtil.js'));
  if (!Object.getOwnPropertyDescriptor(nsisUtil, 'nsisTemplatesDir')?.writable) {
    throw new Error('Unsupported electron-builder NSIS template directory API');
  }
  nsisUtil.nsisTemplatesDir = stagedTemplates;
  return { output, libRoot };
}

module.exports = { prepareWindowsInstaller, replaceOnce };
if (require.main === module) prepareWindowsInstaller().catch(error => { console.error(error); process.exitCode = 1; });
