// Windows PowerShell requires a console-capable launch. A detached Node host
// keeps it independent of the guardian's libuv kill-on-parent-exit Job while
// retaining ordinary, hidden PowerShell startup and file-backed diagnostics.
const { spawn } = require('node:child_process');
const path = require('node:path');
const holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass',
  '-File', path.join(__dirname, 'processJob.ps1'), ...process.argv.slice(2)], {
  stdio: 'inherit', windowsHide: true,
});
holder.once('error', error => { console.error('Windows Job host:', error); process.exit(1); });
holder.once('exit', (code, signal) => {
  if (code !== 0) console.error(`Windows Job supervisor exited: code=${code}, signal=${signal}`);
  process.exit(code ?? 1);
});
