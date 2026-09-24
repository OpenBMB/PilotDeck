// Build and run a separate, per-user test application. Never touches PilotDeck's
// installation, application ID, user data, registry keys or running processes.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { build, Platform, Arch } = require('electron-builder');
const { prepareWindowsInstaller } = require('./prepare-windows-installer.cjs');

(async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotdeck-nsis-e2e-'));
  const project = path.join(root, 'desktop project');
  const payload = path.join(root, 'payload');
  let target = path.join(root, 'PilotDeck Installer Test');
  const resources = path.join(project, 'resources');
  const name = `pilotdeck-installer-test-${crypto.randomUUID()}`;
  const productName = 'PilotDeck Installer Test';
  let installed = false;
  function run(exe, args) {
    // NSIS _?= consumes the raw remainder of the command line, including spaces;
    // wrapping that final argument in quotes disables its wait-in-place behavior.
    const inPlaceUninstall = args.at(-1)?.startsWith('_?=');
    const result = spawnSync(exe, args, { windowsHide: true, encoding: 'utf8', timeout: 90_000,
      ...(inPlaceUninstall ? { windowsVerbatimArguments: true, argv0: `"${exe}"` } : {}) });
    assert.equal(result.status, 0, `${exe}: ${result.error || result.stderr || result.stdout || result.status}`);
    if (result.stdout) console.log(result.stdout.trim());
  }
  try {
    fs.mkdirSync(resources, { recursive: true });
    fs.mkdirSync(path.join(payload, 'resources', 'git'), { recursive: true });
    for (const file of ['installer.nsh', 'installer-start-app.nsh', 'installer-payload.nsh'])
      fs.copyFileSync(path.join(__dirname, '..', 'resources', file), path.join(resources, file));
    // Launch paths have their own compiler test. The fixture executable is data;
    // never dispatch it to Explorer from the interactive finish page.
    const include = path.join(resources, 'installer.nsh');
    fs.writeFileSync(include, fs.readFileSync(include, 'utf8').replace(
      /Exec '[^\r\n]*explorer\.exe[^\r\n]*'/g, 'DetailPrint "Test fixture: launch suppressed"'));
    fs.cpSync(path.join(__dirname, '..', 'resources', 'installer'), path.join(resources, 'installer'), { recursive: true });
    // It is deliberately not an executable: silent tests never launch the app.
    fs.writeFileSync(path.join(payload, `${productName}.exe`), 'installer fixture');
    fs.writeFileSync(path.join(payload, 'resources', 'git', '组件.txt'), 'all components retained');
    fs.writeFileSync(path.join(project, 'package.json'), JSON.stringify({ name, productName, version: '1.0.0', description: 'Installer fixture', author: 'PilotDeck' }));
    const { output } = await prepareWindowsInstaller(project);
    const compiler = path.join(process.env.WINDIR, 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
    const realDecoder = path.join(root, 'real-7za.exe');
    fs.copyFileSync(path.join(output, '7za.exe'), realDecoder);
    run(compiler, ['/nologo', '/target:exe', `/out:${path.join(output, '7za.exe')}`,
      `/resource:${realDecoder},decoder`, path.join(__dirname, 'fixtures', 'installer-slow-decoder.cs')]);
    const uiTests = path.join(root, 'installer-ui-tests.exe');
    run(compiler, ['/nologo', '/target:exe', `/out:${uiTests}`, path.join(__dirname, 'fixtures', 'installer-ui-tests.cs')]);
    const config = {
      appId: `cn.pilotdeck.test.${name}`, productName, electronVersion: '42.3.3',
      directories: { output: path.join(root, 'artifacts') },
      win: { signAndEditExecutable: false },
      nsis: {
        oneClick: false, perMachine: false, allowElevation: false,
        allowToChangeInstallationDirectory: true,
        createDesktopShortcut: false, createStartMenuShortcut: false,
        include: 'resources/installer.nsh',
      },
    };
    const artifacts = await build({ projectDir: project, prepackaged: payload, targets: Platform.WINDOWS.createTarget('nsis', Arch.x64), config, publish: 'never' });
    const setup = artifacts.find(file => file.endsWith('.exe'));
    assert.ok(setup, 'compiled installer');
    for (const label of ['fresh install', 'upgrade']) {
      installed = true;
      if (label === 'upgrade') {
        fs.writeFileSync(path.join(target, 'preserved-during-update.txt'), 'previous installation stays in place');
        const refused = spawnSync(setup, ['/S', '/currentuser', `/D=${target}`], { windowsHide: true, timeout: 90_000 });
        assert.equal(refused.status, 1223, 'unattended replacement requires explicit update intent');
        assert.equal(fs.readFileSync(path.join(target, 'resources', 'git', '组件.txt'), 'utf8'), 'all components retained');
        const wrongTarget = path.join(root, 'wrong update destination');
        const misdirected = spawnSync(setup, ['--updated', '/S', '/currentuser', `/D=${wrongTarget}`], { windowsHide: true, timeout: 90_000 });
        assert.equal(misdirected.status, 1, 'update to a different directory must fail before replacement');
        assert.ok(fs.existsSync(path.join(target, `${productName}.exe`)), 'wrong target keeps installed executable');
        assert.ok(!fs.existsSync(path.join(wrongTarget, `${productName}.exe`)), 'wrong target stays empty');
      }
      // electron-updater launches upgrades without /D; NSIS must reuse the
      // registered InstallLocation instead of installing in a default folder.
      run(setup, label === 'upgrade'
        ? ['--updated', '/S', '/currentuser']
        : ['/S', '/currentuser', `/D=${target}`]);
      assert.equal(fs.readFileSync(path.join(target, 'resources', 'git', '组件.txt'), 'utf8'), 'all components retained', label);
      assert.ok(fs.existsSync(path.join(target, `Uninstall ${productName}.exe`)), 'uninstaller exists');
      if (label === 'upgrade') assert.ok(fs.existsSync(path.join(target, 'preserved-during-update.txt')), 'automatic update must not uninstall the old version');
      assert.ok(!fs.readdirSync(root).some(file => file.startsWith('.pilotdeck-install-')), 'staging cleaned');
    }
    const marker = path.join(target, 'old-version-marker.txt');
    fs.writeFileSync(marker, 'must survive refusal and cancellation');
    for (const mode of ['decline', 'cancel-now', 'cancel', 'overwrite', 'approve']) {
      run(uiTests, [setup, target, mode]);
      assert.equal(fs.readFileSync(path.join(target, 'resources', 'git', '组件.txt'), 'utf8'), 'all components retained');
      if (mode !== 'approve') assert.equal(fs.readFileSync(marker, 'utf8'), 'must survive refusal and cancellation', 'in-place replacement preserves unknown files');
      else assert.ok(!fs.existsSync(marker), 'confirmed upgrade runs old-version uninstall');
      assert.ok(fs.existsSync(path.join(target, `Uninstall ${productName}.exe`)));
      assert.ok(!fs.readdirSync(root).some(file => file.startsWith('.pilotdeck-install-')), 'cancel/commit cleans staging');
    }

    // Older installers can register a custom directory that does not include
    // APP_FILENAME. An --updated run must use that exact path. Previously,
    // instFilesPre appended APP_FILENAME and staged inside the old directory;
    // the previous uninstall-first flow then deleted that payload before commit.
    const registryRoot = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall';
    const query = spawnSync('reg.exe', ['query', registryRoot, '/s', '/f', productName], { encoding: 'utf8', windowsHide: true });
    assert.equal(query.status, 0, query.stderr || 'test uninstall registry entry missing');
    const registryMatch = query.stdout.match(/HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\([^\r\n]+)/i);
    assert.ok(registryMatch, 'isolated uninstall registry key');
    const key = registryMatch[1].trim();
    const legacyTarget = path.join(root, 'legacy location');
    fs.renameSync(target, legacyTarget);
    target = legacyTarget;
    run('reg.exe', ['add', `HKCU\\Software\\${key}`, '/v', 'InstallLocation', '/t', 'REG_SZ', '/d', target, '/f']);
    run('reg.exe', ['add', `${registryRoot}\\${key}`, '/v', 'UninstallString', '/t', 'REG_SZ', '/d', `"${path.join(target, `Uninstall ${productName}.exe`)}" /currentuser`, '/f']);
    run(setup, ['--updated', '/S', '/currentuser']);
    assert.ok(fs.existsSync(path.join(target, `${productName}.exe`)), 'upgrade must install at original custom directory');
    assert.ok(!fs.existsSync(path.join(target, productName)), 'upgrade must not create a nested application directory');
    assert.ok(!fs.readdirSync(target).some(name => name.startsWith('.pilotdeck-install-')), 'staging must not remain in installed directory');
    run(uiTests, [setup, target, 'approve-updated']);
    assert.ok(fs.existsSync(path.join(target, `${productName}.exe`)), 'interactive updater must preserve original custom directory');
    assert.ok(!fs.existsSync(path.join(target, productName)), 'interactive updater must not create a nested application directory');
    run(path.join(target, `Uninstall ${productName}.exe`), ['/S', '/currentuser', `_?=${target}`]);
    installed = false;
    assert.ok(!fs.existsSync(path.join(target, 'resources')), 'uninstall removed test payload');
    console.log('PASS: real NSIS silent/interactive upgrades, consent, cumulative progress, cancellation and uninstall');
  } finally {
    if (installed && fs.existsSync(path.join(target, `Uninstall ${productName}.exe`)))
      run(path.join(target, `Uninstall ${productName}.exe`), ['/S', '/currentuser', `_?=${target}`]);
    // Absolute paths under this newly created test root only.
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
    if (process.env.LOCALAPPDATA) fs.rmSync(path.join(process.env.LOCALAPPDATA, `${name}-updater`), { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
