const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const checked = new Set();

function restrictConfigurationDirectory(directory) {
  directory = path.resolve(directory);
  if (checked.has(directory)) return;
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') { fs.chmodSync(directory, 0o700); checked.add(directory); return; }
  const certificate = path.join(directory, '.private-acl-v1');
  if (fs.existsSync(certificate)) { checked.add(directory); return; }
  // Windows chmod does not implement POSIX confidentiality. Establish a protected
  // inheritable DACL once; future atomic files inherit it without spawning helpers.
  // The path is data in the child environment, never interpolated into PS code.
  const source = `$ErrorActionPreference='Stop'
$identity=[Security.Principal.WindowsIdentity]::GetCurrent()
$acl=New-Object Security.AccessControl.DirectorySecurity
$acl.SetOwner($identity.User)
$acl.SetAccessRuleProtection($true,$false)
foreach($sid in @($identity.User,(New-Object Security.Principal.SecurityIdentifier('S-1-5-18')),(New-Object Security.Principal.SecurityIdentifier('S-1-5-32-544')))) {
  $rule=New-Object Security.AccessControl.FileSystemAccessRule($sid,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
  $acl.AddAccessRule($rule)
}
[IO.Directory]::SetAccessControl($env:PD_TASK_PRIVATE_DIRECTORY,$acl)
`;
  execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(source, 'utf16le').toString('base64')], {
    windowsHide: true, timeout: 30_000, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PD_TASK_PRIVATE_DIRECTORY: directory },
  });
  try { fs.writeFileSync(certificate, 'PilotDeck protected directory ACL v1\n', { flag: 'wx', mode: 0o600 }); }
  catch (error) { if (error.code !== 'EEXIST') throw error; }
  checked.add(directory);
}
module.exports = { restrictConfigurationDirectory };
