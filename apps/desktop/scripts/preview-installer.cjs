// Harmless UI review fixture: no registry writes, file installation or app launch.
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
const builder = createRequire(require.resolve('electron-builder'));
const lib = path.dirname(builder.resolve('app-builder-lib/package.json'));
const { getMakeNsisPath, getNsisPluginsPath } = require(path.join(lib, 'out/toolsets/windows.js'));
const { NsisScriptGenerator } = require(path.join(lib, 'out/targets/nsis/nsisScriptGenerator.js'));
(async () => {
  const directory = path.resolve(__dirname, '../../../artifacts/startup-refinement-2026-11-02');
  fs.mkdirSync(directory, { recursive: true });
  const binary = await getMakeNsisPath(), plugins = await getNsisPluginsPath();
  const generator = new NsisScriptGenerator();
  generator.addIncludeDir(path.join(lib, 'templates/nsis/include'));
  generator.addPluginDir('x86-unicode', path.join(plugins, 'x86-unicode'));
  generator.include(path.join(lib, 'templates/nsis/include/StdUtils.nsh'));
  generator.flags(['updated']);
  for (const [language, id] of [['en', 1033], ['zh-CN', 2052]]) {
    const output = path.join(directory, `installer-preview-${language}.exe`);
    const script = `Unicode true
RequestExecutionLevel user
${generator.build()}
!define PROJECT_DIR "${path.resolve(__dirname, '..')}"
!define PRODUCT_NAME "PilotDeck"
!define PRODUCT_FILENAME "PilotDeck"
!define VERSION "2026.1102.0"
!include "${path.resolve(__dirname, '../resources/installer.nsh')}"
!include "common.nsh"
!include "MUI2.nsh"
Name "PilotDeck Installer Preview"
OutFile "${output}"
InstallDir "$TEMP\\PilotDeck Installer Preview"
Var PreviewProgress
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro customPageAfterChangeDir
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_PAGE_FINISH
!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "SimpChinese"
Function .onInit
  StrCpy $LANGUAGE ${id}
FunctionEnd
Section
  StrCpy $PreviewProgress 0
  loop:
    SendMessage $PilotDeckProgress 0x0402 $PreviewProgress 0
    Sleep 500
    IntOp $PreviewProgress $PreviewProgress + 5
    IntCmp $PreviewProgress 1000 done loop done
  done:
  !insertmacro customInstall
SectionEnd
`;
    execFileSync(binary.path, ['-V2', '-INPUTCHARSET', 'UTF8', '-'], { cwd: path.join(lib, 'templates/nsis'), input: script, env: { ...process.env, ...binary.env }, stdio: ['pipe', 'pipe', 'pipe'] });
    console.log(output);
  }
})().catch(error => { console.error(error.message); process.exitCode = 1; });
