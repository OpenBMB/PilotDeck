// Build a harmless user-level fixture that exercises the real uninstall macro.
// It has no bundled cleanup helper, registry entries or installed application.
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { createRequire } = require('node:module');
const builderRequire = createRequire(require.resolve('electron-builder'));
const lib = path.dirname(builderRequire.resolve('app-builder-lib/package.json'));
const { getMakeNsisPath, getNsisPluginsPath } = require(path.join(lib,'out/toolsets/windows.js'));
const { NsisScriptGenerator } = require(path.join(lib,'out/targets/nsis/nsisScriptGenerator.js'));

(async () => {
  const directory = path.resolve(__dirname,'../../../artifacts/uninstall-verification-2026-11-02');
  fs.mkdirSync(directory,{recursive:true});
  const binary = await getMakeNsisPath(), plugins = await getNsisPluginsPath();
  const generator = new NsisScriptGenerator();
  generator.addIncludeDir(path.join(lib,'templates/nsis/include'));
  generator.addPluginDir('x86-unicode',path.join(plugins,'x86-unicode'));
  generator.include(path.join(lib,'templates/nsis/include/StdUtils.nsh'));
  generator.flags(['updated']);
  const output = path.join(directory,'installer-fixture.exe'), target = path.join(directory,'fixture');
  const script = `Unicode true
RequestExecutionLevel user
SetCompress off
${generator.build()}
Var installMode
!define BUILD_UNINSTALLER
!define PROJECT_DIR "${path.resolve(__dirname,'..')}"
!include "MUI2.nsh"
!include "${path.resolve(__dirname,'../resources/installer.nsh')}"
Name "PilotDeck Uninstall Verification"
OutFile "${output}"
InstallDir "${target}"
ShowUninstDetails show
!insertmacro customUnWelcomePage
!insertmacro MUI_UNPAGE_INSTFILES
!insertmacro customUninstallPage
!insertmacro MUI_UNPAGE_FINISH
!insertmacro MUI_LANGUAGE "English"
!insertmacro MUI_LANGUAGE "SimpChinese"
Function un.onInit
  !insertmacro customUnInit
FunctionEnd
Section
  CreateDirectory "$INSTDIR"
  WriteUninstaller "$INSTDIR\\uninstall-fixture.exe"
SectionEnd
Section "Uninstall"
  !insertmacro customUnInstall
  DetailPrint "Verification only: no application or user files are removed."
SectionEnd
`;
  const log = execFileSync(binary.path,['-V4','-INPUTCHARSET','UTF8','-'],{cwd:path.join(lib,'templates/nsis'),input:script,env:{...process.env,...binary.env},encoding:'utf8',maxBuffer:10*1024*1024});
  fs.writeFileSync(path.join(directory,'compile.log'),log);
  assert.match(log, /MessageBox: 292:.*pilotdeck_keep_personal_data/, 'fallback retains data by default');
  assert.match(log, /CreateDialog|nsDialogs|CreateControl/, 'native custom data page is compiled');
  assert.match(log, /LangString: "PD_UnKeep" 2052/, 'Chinese resources are included');
  assert.ok(log.includes('TestParameter'),'update flag guard is compiled');
  assert.ok(fs.statSync(output).size>0);
  execFileSync(output,['/S',`/D=${target}`],{windowsHide:true,timeout:30000});
  assert.ok(fs.existsSync(path.join(target,'uninstall-fixture.exe')));
  assert.ok(fs.readFileSync(path.join(target,'uninstall-fixture.exe')).includes(Buffer.from('保留个人数据（推荐）','utf16le')), 'Chinese text survives compilation without encoding corruption');
  console.log(`PASS: uninstall macro compiles with update/silent guards; harmless fixture: ${target}`);
})().catch(error=>{console.error(error);process.exitCode=1;});
