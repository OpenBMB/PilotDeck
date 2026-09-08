// Compile and inspect expanded launch paths with the installed builder's NSIS
// templates/toolchain. Does not execute the resulting Windows installer.
const { createRequire } = require('node:module');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const builderRequire = createRequire(require.resolve('electron-builder'));
const libRoot = path.dirname(builderRequire.resolve('app-builder-lib/package.json'));
const { getMakeNsisPath, getNsisPluginsPath } = require(path.join(libRoot, 'out/toolsets/windows.js'));
const { NsisScriptGenerator } = require(path.join(libRoot, 'out/targets/nsis/nsisScriptGenerator.js'));
const templates = path.join(libRoot, 'templates/nsis');
const resources = path.resolve(__dirname, '../resources');
(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotdeck-nsis-test-'));
  try {
    const binary = await getMakeNsisPath();
    const plugins = await getNsisPluginsPath();
    const generator = new NsisScriptGenerator();
    generator.addIncludeDir(templates);
    generator.addIncludeDir(path.join(templates, 'include'));
    generator.addIncludeDir(resources);
    generator.addPluginDir('x86-unicode', path.join(plugins, 'x86-unicode'));
    generator.include(path.join(templates, 'include/StdUtils.nsh'));
    generator.flags(['updated', 'force-run']);
    // Same ordering as NsisTarget's shared header + installer.nsi: custom
    // include, common, assisted finish page, customHeader, install section.
    const launchSection = fs.readFileSync(path.join(templates, 'installSection.nsh'), 'utf8').split('!macro doStartApp')[1];
    assert.ok(launchSection);
    const script = "Unicode true\n" + generator.build() + `
!define PRODUCT_NAME "PilotDeck"
!define PRODUCT_FILENAME "PilotDeck"
!define VERSION "2026.907.0"
!include "${path.join(resources, 'installer.nsh')}"
!include "common.nsh"
!include "MUI2.nsh"
!insertmacro MUI_PAGE_INSTFILES
!insertmacro customFinishPage
!insertmacro MUI_LANGUAGE "English"
!insertmacro customHeader
OutFile "${path.join(root, 'installer.exe')}"
Section
!macro doStartApp${launchSection}
SectionEnd
`;
    // Absolute custom include avoids colliding with the builder's installer.nsi.
    const file = path.join(root, 'test.nsi'); fs.writeFileSync(file, script);
    const options = { cwd: resources, env: { ...process.env, ...binary.env }, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024 };
    const compiledLog = execFileSync(binary.path, ['-V4', file], options);

    assert.equal((compiledLog.match(/Exec: .*explorer\.exe/g) || []).length, 2, 'interactive and silent launches both use explorer');
    assert.ok(!/Plugin command: ExecShellAsUser/.test(compiledLog), 'no default user-launch call survives expansion');

    assert.ok(fs.statSync(path.join(root, 'installer.exe')).size > 0);
    console.log('PASS: NSIS compiles; interactive and silent --force-run paths both expand to explorer.exe');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
})().catch(error => { console.error(error); process.exitCode = 1; });
