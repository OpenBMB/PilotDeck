const assert = require('node:assert/strict');
const { createRequire } = require('node:module');
const { resolve } = require('node:path');

async function verifyRuntimePty(runtimeRoot) {
  const runtimeRequire = createRequire(resolve(runtimeRoot, 'package.json'));
  const pty = runtimeRequire('node-pty');
  const windows = process.platform === 'win32';
  const child = pty.spawn(windows ? (process.env.ComSpec || 'cmd.exe') : '/bin/sh',
    windows ? ['/d', '/s', '/c', 'echo pilotdeck-pty-ok'] : ['-c', 'printf pilotdeck-pty-ok'],
    { name: 'xterm', cols: 80, rows: 24, cwd: runtimeRoot, env: process.env });
  let output = '';
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      try { child.kill(); } finally { reject(new Error('PTY smoke timed out')); }
    }, 10_000);
    child.onData(chunk => { output += chunk; });
    child.onExit(({ exitCode }) => {
      clearTimeout(timeout);
      if (exitCode === 0) resolve();
      else reject(new Error(`PTY exited with ${exitCode}`));
    });
  });
  assert.match(output, /pilotdeck-pty-ok/);
}

module.exports = { verifyRuntimePty };
if (require.main === module) {
  verifyRuntimePty(resolve(process.argv[2] || '.'))
    .then(() => console.log('PASS: runtime node-pty load and spawn'))
    .catch(error => { console.error(error); process.exitCode = 1; });
}
