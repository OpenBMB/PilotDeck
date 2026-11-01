const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function loadSigningConfig(env = process.env, platform = process.platform) {
  if (platform !== 'win32') return null;
  const mode = env.PILOTDECK_WINDOWS_SIGNING || 'auto';
  if (!['auto', 'required', 'off'].includes(mode)) throw new Error('PILOTDECK_WINDOWS_SIGNING must be auto, required or off.');
  if (mode === 'off') return null;
  const file = env.PILOTDECK_WINDOWS_SIGNING_CONFIG || (env.LOCALAPPDATA && path.join(env.LOCALAPPDATA, 'PilotDeck', 'build-signing.json'));
  const hasLocal = file && fs.existsSync(file);
  const local = hasLocal ? JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) : {};
  const certificateSha1 = (env.PILOTDECK_WINDOWS_CERT_SHA1 || local.certificateSha1 || '').replace(/\s/g, '').toUpperCase();
  if (!certificateSha1 && !hasLocal && mode === 'auto') return null;
  if (!/^[A-F0-9]{40}$/.test(certificateSha1)) throw new Error('Windows signing needs a 40-character certificate thumbprint. Configure build-signing.json or PILOTDECK_WINDOWS_CERT_SHA1.');
  const publisherName = env.PILOTDECK_WINDOWS_PUBLISHER || local.publisherName;
  if (typeof publisherName !== 'string' || !publisherName.trim()) throw new Error('Windows signing needs publisherName (certificate common name).');
  const signToolPath = env.SIGNTOOL_PATH || local.signToolPath;
  if (!signToolPath || !path.isAbsolute(signToolPath) || !fs.existsSync(signToolPath)) throw new Error('Windows signing needs the absolute path to Windows SDK signtool.exe (SIGNTOOL_PATH).');
  const timestampServer = env.PILOTDECK_WINDOWS_TIMESTAMP_URL || local.timestampServer || 'http://time.certum.pl';
  if (!/^https?:\/\//.test(timestampServer)) throw new Error('Timestamp server must be an HTTP(S) URL.');
  const provider = env.PILOTDECK_WINDOWS_SIGNING_PROVIDER || local.provider || 'store';
  if (!['store', 'ssign'].includes(provider)) throw new Error('Windows signing provider must be store or ssign.');
  const cloudToolPath = env.PILOTDECK_SSIGN_PATH || local.cloudToolPath;
  if (provider === 'ssign' && (!cloudToolPath || !path.isAbsolute(cloudToolPath) || !fs.existsSync(cloudToolPath))) throw new Error('Cloud signing needs an absolute PILOTDECK_SSIGN_PATH.');
  return { certificateSha1, publisherName: publisherName.trim(), signToolPath, timestampServer, provider, cloudToolPath };
}

function inspectSignature(file, config) {
  execFileSync(config.signToolPath, ['verify', '/pa', '/all', file], { windowsHide: true, stdio: 'pipe', timeout: 120_000 });
  const result = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-File', path.join(__dirname, 'verify-windows-signature.ps1'),
    '-Path', file, '-Thumbprint', config.certificateSha1, '-Publisher', config.publisherName],
  { windowsHide: true, encoding: 'utf8', timeout: 120_000,
    // A parent PowerShell 7 session can export an incompatible module path to 5.1.
    env: { ...process.env, PSModulePath: path.join(process.env.WINDIR || 'C:\\Windows', 'System32', 'WindowsPowerShell', 'v1.0', 'Modules') } });
  return JSON.parse(result.trim());
}

function signFile(file, config = loadSigningConfig()) {
  if (!config) throw new Error('Windows signing is not configured.');
  if (process.platform !== 'win32') throw new Error('Certificate-store signing requires Windows.');
  console.log(`[signing] SHA-256 + RFC3161: ${path.basename(file)}`);
  try {
    if (config.provider === 'ssign') {
      if (!process.env.CERTUM_EMAIL || !process.env.CERTUM_OTP || process.env.CERTUM_TOKEN) throw new Error('Missing or conflicting cloud credentials.');
      // The OTP seed stays in the environment, never arguments, logs or config files.
      execFileSync(config.cloudToolPath, ['--timestamp-url', config.timestampServer, '--name', 'PilotDeck', file],
        { windowsHide: true, stdio: 'pipe', timeout: 120_000 });
    } else {
      execFileSync(config.signToolPath, ['sign', '/sha1', config.certificateSha1, '/s', 'My',
        '/tr', config.timestampServer, '/td', 'sha256', '/fd', 'sha256', '/d', 'PilotDeck', file],
      { windowsHide: true, stdio: 'pipe', timeout: 120_000 });
    }
    return inspectSignature(file, config);
  } catch (error) {
    // No PIN, OTP, password or private key is ever supplied to this process.
    // A cloud client's error body may contain authentication URLs or tokens.
    // Do not attach the child-process error/cause to electron-builder's logs.
    throw new Error(`Signing/verification failed for ${path.basename(file)} (${config.provider}, exit ${error.status ?? 'unknown'}). Check SimplySign login/credentials, certificate identity and validity, and timestamp connectivity.`);
  }
}

function isOwnedExecutable(file) {
  // Preserve the signatures of bundled Git, Node, Electron helpers and other vendors.
  const name = path.basename(file);
  return name === 'PilotDeck.exe' || name === 'install-payload.exe'
    || /^PilotDeck-.+-(?:setup|portable)\.(?:__uninstaller\.)?exe$/i.test(name);
}

async function builderSign(options) {
  if (!isOwnedExecutable(options.path)) return;
  if (options.hash !== 'sha256') throw new Error('PilotDeck signing requires SHA-256.');
  signFile(options.path);
}

function applySigningConfig(base, config) {
  if (!config) return base;
  return {
    ...base,
    forceCodeSigning: true,
    win: {
      ...base.win,
      verifyUpdateCodeSignature: true,
      signtoolOptions: {
        publisherName: config.publisherName,
        signingHashAlgorithms: ['sha256'],
        sign: builderSign,
      },
    },
  };
}

module.exports = { loadSigningConfig, signFile, inspectSignature, isOwnedExecutable, builderSign, applySigningConfig };

if (require.main === module) {
  try {
    const config = loadSigningConfig({ ...process.env, PILOTDECK_WINDOWS_SIGNING: 'required' });
    const [command, ...files] = process.argv.slice(2);
    if (!['sign', 'verify'].includes(command) || !files.length) throw new Error('Usage: node windows-signing.cjs <sign|verify> <file.exe> [...]');
    for (const file of files) console.log(JSON.stringify(command === 'sign' ? signFile(path.resolve(file), config) : inspectSignature(path.resolve(file), config)));
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
