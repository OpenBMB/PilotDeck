const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
// Includes PowerShell cold startup. Query failures remain explicit; no PID-only fallback.
const WINDOWS_QUERY_TIMEOUT_MS = 15_000;
const WINDOWS_STARTUP_TIMEOUT_MS = 60_000;
function windowsProcesses(pids, run = execFileSync) {
  if (pids && !pids.every(pid => Number.isSafeInteger(pid) && pid > 0)) throw new Error('Invalid process identity PID');
  if (pids?.length === 0) return [];
  const source = pids
    ? `@(${[...new Set(pids)].join(',')}) | ForEach-Object { try { [System.Diagnostics.Process]::GetProcessById($_) } catch [System.ArgumentException] {} }`
    : '[System.Diagnostics.Process]::GetProcesses()';
  const onError = pids ? 'if (!$item.HasExited) { throw }' : '';
  const command = `$ErrorActionPreference='Stop'; $items=@(${source}); $result=@(foreach($item in $items) { try { [pscustomobject]@{ ProcessId=$item.Id; Birth=$item.StartTime.ToUniversalTime().ToString('o') } } catch { ${onError} } finally { $item.Dispose() } }); ConvertTo-Json -InputObject $result -Compress`;
  try {
    const stdout = run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command],
      { timeout: WINDOWS_QUERY_TIMEOUT_MS, maxBuffer: 8 * 1024 * 1024, windowsHide: true, encoding: 'utf8' });
    const parsed = JSON.parse(stdout || '[]');
    return (Array.isArray(parsed) ? parsed : [parsed]).map(row => {
      if (!Number.isSafeInteger(row.ProcessId) || !row.Birth) throw new Error('Missing process creation identity');
      return { pid: row.ProcessId, birth: row.Birth };
    });
  } catch (error) {
    const detail = error.code === 'ETIMEDOUT' ? `timed out after ${WINDOWS_QUERY_TIMEOUT_MS} ms` : error.message;
    throw Object.assign(new Error(`Windows process identity query ${detail}`), { code: error.code, cause: error });
  }
}
function getProcessIdentities(pids, platform = process.platform) {
  return platform === 'win32' ? windowsProcesses(pids) : listProcesses(platform).filter(row => pids.includes(row.pid));
}
function getProcessIdentity(pid, platform = process.platform) { return getProcessIdentities([pid], platform)[0]; }
function listProcesses(platform = process.platform) {
  if (platform === 'win32') return windowsProcesses();
  const stdout = execFileSync('ps', ['-axo', 'pid=,ppid=,pgid=,stat=,lstart='],
    { timeout: 2000, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8', env: { ...process.env, LC_ALL: 'C' } });
  return stdout.trim().split('\n').filter(Boolean).flatMap(line => {
    const [pid, parent, group, state, ...started] = line.trim().split(/\s+/);
    let birth = started.join(' ');
    if (platform === 'linux') {
      try {
        const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
        birth = stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19];
      } catch { return []; } // Exited during enumeration; never invent an identity.
    }
    return [{ pid: Number(pid), parent: Number(parent), group: Number(group), birth, zombie: state.startsWith('Z') }];
  });
}
const sameProcess = (left, right) => Boolean(left && right && left.birth && left.pid === right.pid && left.birth === right.birth && left.group === right.group);
module.exports = { listProcesses, getProcessIdentity, getProcessIdentities, sameProcess, windowsProcesses, WINDOWS_QUERY_TIMEOUT_MS, WINDOWS_STARTUP_TIMEOUT_MS };
