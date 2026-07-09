param(
  [string]$RepoUrl = $env:PILOTDECK_REPO_URL,
  [string]$Branch = $env:PILOTDECK_BRANCH,
  [string]$InstallDir = $env:PILOTDECK_INSTALL_DIR,
  [string]$ConfigPath = $env:PILOTDECK_CONFIG_PATH,
  [int]$ServerPort = $(if ($env:SERVER_PORT) { [int]$env:SERVER_PORT } else { 3001 }),
  [int]$GatewayPort = $(if ($env:PILOTDECK_GATEWAY_PORT) { [int]$env:PILOTDECK_GATEWAY_PORT } else { 18789 }),
  [int]$MaxPortTries = $(if ($env:PILOTDECK_MAX_PORT_TRIES) { [int]$env:PILOTDECK_MAX_PORT_TRIES } else { 20 }),
  [int]$LfsTimeoutSeconds = $(if ($env:PILOTDECK_LFS_TIMEOUT_SECONDS) { [int]$env:PILOTDECK_LFS_TIMEOUT_SECONDS } else { 300 }),
  [switch]$SkipStart,
  [switch]$SkipLfs,
  [switch]$NoPathUpdate,
  [switch]$ForceInstall
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest

if (-not $RepoUrl) { $RepoUrl = 'https://github.com/OpenBMB/PilotDeck.git' }
if (-not $Branch) { $Branch = 'main' }
if (-not $InstallDir) { $InstallDir = Join-Path $HOME '.pilotdeck\app' }
if (-not $ConfigPath) { $ConfigPath = Join-Path $HOME '.pilotdeck\pilotdeck.yaml' }

$MinimumNodeVersion = [version]'22.13.0'
$MaximumNodeMajor = 22
$NodeInstallVersion = if ($env:PILOTDECK_NODE_VERSION) { $env:PILOTDECK_NODE_VERSION } else { '22' }
$RepoChanged = $true

function Write-Ok([string]$Message) { Write-Host "  OK  $Message" -ForegroundColor Green }
function Write-Step([string]$Message) { Write-Host "  ->  $Message" -ForegroundColor Yellow }
function Write-Fail([string]$Message) { throw $Message }

function Test-Command([string]$Name) {
  return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
}

function Get-NodeVersion {
  if (-not (Test-Command node)) { return $null }
  $raw = (& node --version 2>$null)
  if (-not $raw) { return $null }
  return [version]($raw.TrimStart('v'))
}

function Test-NodeSqlite {
  if (-not (Test-Command node)) { return $false }
  $previousErrorAction = $ErrorActionPreference
  try {
    $ErrorActionPreference = 'Continue'
    & node -e "import('node:sqlite').then(() => {}, () => process.exit(1))" 1>$null 2>$null
    return $LASTEXITCODE -eq 0
  } finally {
    $ErrorActionPreference = $previousErrorAction
  }
}

function Get-NodeArchitecture {
  if (-not (Test-Command node)) { return $null }
  $arch = (& node -p "process.arch" 2>$null)
  if (-not $arch) { return $null }
  return $arch.Trim()
}

function Test-NodeArchitecture {
  $arch = Get-NodeArchitecture
  return $arch -eq 'x64'
}

function Test-CurrentNodeRuntime {
  $version = Get-NodeVersion
  return $version -and $version -ge $MinimumNodeVersion -and $version.Major -eq $MaximumNodeMajor -and (Test-NodeSqlite) -and (Test-NodeArchitecture)
}

function Refresh-ProcessPath {
  $machinePath = [Environment]::GetEnvironmentVariable('Path', 'Machine')
  $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
  $paths = @($machinePath, $userPath, $env:Path) -join ';'
  $env:Path = ($paths -split ';' | Where-Object { $_ } | Select-Object -Unique) -join ';'
}

function Resolve-NpmCommand {
  $npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if ($npmCommand) { return $npmCommand.Source }
  $npmCommand = Get-Command npm -ErrorAction SilentlyContinue
  if ($npmCommand) { return $npmCommand.Source }
  Write-Fail 'npm was not found after Node.js setup. Open a new terminal or fix Node.js PATH, then rerun this script.'
}
function Resolve-ClawHubCommand {
  $clawhubCommand = Get-Command clawhub.cmd -ErrorAction SilentlyContinue
  if ($clawhubCommand) { return $clawhubCommand.Source }
  $clawhubCommand = Get-Command clawhub -ErrorAction SilentlyContinue
  if ($clawhubCommand) { return $clawhubCommand.Source }
  return $null
}

function Invoke-WingetInstall([string]$PackageId, [string]$PackageName, [switch]$Optional) {
  & winget install --id $PackageId -e --accept-package-agreements --accept-source-agreements
  if ($LASTEXITCODE -eq 0) { return $true }

  $message = "winget failed to install $PackageName (exit code $LASTEXITCODE)."
  if ($Optional) {
    Write-Step "$message Continuing without $PackageName."
    return $false
  }

  Write-Step $message
  return $false
}

function Add-UserPath([string]$Directory) {
  $resolved = [System.IO.Path]::GetFullPath($Directory)
  $current = [Environment]::GetEnvironmentVariable('Path', 'User')
  $parts = @()
  if ($current) { $parts = $current -split ';' | Where-Object { $_ } }
  if ($parts -contains $resolved) {
    Write-Ok "PATH already contains $resolved"
    return
  }
  [Environment]::SetEnvironmentVariable('Path', (($parts + $resolved) -join ';'), 'User')
  $env:Path = "$resolved;$env:Path"
  Write-Ok "Added $resolved to the user PATH"
  Write-Step "Open a new PowerShell window before using pilotdeck globally."
}

function Add-FnmNodeToPath {
  $fnmRoot = if ($env:FNM_DIR) { $env:FNM_DIR } else { Join-Path $env:APPDATA 'fnm' }
  $versionsDir = Join-Path $fnmRoot 'node-versions'
  if (-not (Test-Path $versionsDir)) { return $false }
  $nodeExe = Get-ChildItem -Path $versionsDir -Directory -Filter "v$NodeInstallVersion*" -ErrorAction SilentlyContinue |
    Sort-Object Name -Descending |
    ForEach-Object { Join-Path $_.FullName 'installation\node.exe' } |
    Where-Object { Test-Path $_ } |
    Select-Object -First 1
  if (-not $nodeExe) { return $false }
  $nodeDir = Split-Path -Parent $nodeExe
  $env:Path = "$nodeDir;$env:Path"
  return $true
}

function Resolve-NodeDownloadVersion {
  if ($NodeInstallVersion -match '^v?\d+\.\d+\.\d+$') {
    if ($NodeInstallVersion.StartsWith('v')) { return $NodeInstallVersion }
    return "v$NodeInstallVersion"
  }
  $major = ($NodeInstallVersion -replace '^v', '' -split '\.')[0]
  try {
    $index = Invoke-RestMethod -Uri 'https://nodejs.org/dist/index.json' -UseBasicParsing
    $match = $index | Where-Object { $_.version -like "v$major.*" -and $_.files -contains 'win-x64-zip' } | Select-Object -First 1
    if ($match) { return $match.version }
  } catch {
    Write-Step "Could not resolve latest Node.js $major from nodejs.org; using minimum runtime $MinimumNodeVersion."
  }
  return "v$MinimumNodeVersion"
}

function Install-PortableNodeRuntime {
  $nodeVersion = Resolve-NodeDownloadVersion
  $installRoot = Join-Path $HOME '.pilotdeck\node'
  $nodeDir = Join-Path $installRoot "node-$nodeVersion-win-x64"
  $nodeExe = Join-Path $nodeDir 'node.exe'
  if (Test-Path $nodeExe) {
    Write-Ok "Portable Node.js $nodeVersion already installed"
  } else {
    New-Item -ItemType Directory -Force -Path $installRoot | Out-Null
    $zipPath = Join-Path ([System.IO.Path]::GetTempPath()) "node-$nodeVersion-win-x64.zip"
    $url = "https://nodejs.org/dist/$nodeVersion/node-$nodeVersion-win-x64.zip"
    Write-Step "Downloading portable Node.js $nodeVersion..."
    Invoke-WebRequest -Uri $url -OutFile $zipPath -UseBasicParsing
    $extractRoot = Join-Path ([System.IO.Path]::GetTempPath()) "pilotdeck-node-$nodeVersion"
    Remove-Item -Recurse -Force -LiteralPath $extractRoot -ErrorAction SilentlyContinue
    Expand-Archive -LiteralPath $zipPath -DestinationPath $extractRoot -Force
    $extracted = Join-Path $extractRoot "node-$nodeVersion-win-x64"
    Remove-Item -Recurse -Force -LiteralPath $nodeDir -ErrorAction SilentlyContinue
    Move-Item -LiteralPath $extracted -Destination $nodeDir
    Remove-Item -Recurse -Force -LiteralPath $extractRoot -ErrorAction SilentlyContinue
    Remove-Item -Force -LiteralPath $zipPath -ErrorAction SilentlyContinue
  }
  $env:Path = "$nodeDir;$env:Path"
}

function Install-NodeRuntime {
  if (Test-Command fnm) {
    & fnm use $NodeInstallVersion 1>$null 2>$null
    [void](Add-FnmNodeToPath)
    if (Test-CurrentNodeRuntime) {
      Write-Ok "Node.js $NodeInstallVersion already available via fnm"
      return
    }
    & fnm install $NodeInstallVersion
    if ($LASTEXITCODE -ne 0) { Write-Fail "fnm failed to install Node.js $NodeInstallVersion." }
    [void](Add-FnmNodeToPath)
    return
  }

  if (Test-Command winget) {
    Refresh-ProcessPath
    if (Test-CurrentNodeRuntime) { return }
    Write-Step "Installing Node.js $NodeInstallVersion LTS with winget..."
    [void](Invoke-WingetInstall 'OpenJS.NodeJS.LTS' 'Node.js')
    Refresh-ProcessPath
    if (Test-CurrentNodeRuntime) { return }
    if (Test-Command node) {
      Write-Step 'winget did not provide the supported Node.js 22 x64 runtime; using portable Node.js for this run.'
    } else {
      Write-Step 'Node.js is not visible in this shell after winget; using portable Node.js for this run.'
    }
  }

  Install-PortableNodeRuntime
}

function Ensure-NodeRuntime {
  if (-not (Test-Command node)) { [void](Add-FnmNodeToPath) }
  $version = Get-NodeVersion
  if (Test-CurrentNodeRuntime) {
    Write-Ok "Node.js v$version found"
    return
  }

  if ($version) {
    Write-Step "Node.js v$version is not the supported Node.js 22 x64 runtime or lacks node:sqlite; installing Node.js $NodeInstallVersion..."
  } else {
    Write-Step "Node.js not found; installing Node.js $NodeInstallVersion..."
  }

  Install-NodeRuntime
  $version = Get-NodeVersion
  $arch = Get-NodeArchitecture
  if (-not $version -or $version -lt $MinimumNodeVersion -or $version.Major -ne $MaximumNodeMajor -or -not (Test-NodeSqlite) -or -not (Test-NodeArchitecture)) {
    Write-Fail "Node.js >= $MinimumNodeVersion and <23 x64 with node:sqlite is required. Current: $(if ($version) { "v$version" } else { 'not found' }), arch $(if ($arch) { $arch } else { 'unknown' })."
  }
  Write-Ok "Node.js v$version installed"
}

function Add-PortableGitToPath {
  $gitRoot = Join-Path $HOME '.pilotdeck\git'
  if (-not (Test-Path $gitRoot)) { return $false }
  $gitExe = Get-ChildItem -Path $gitRoot -Recurse -Filter git.exe -ErrorAction SilentlyContinue |
    Where-Object { $_.FullName -match '[\\/]cmd[\\/]git\.exe$' } |
    Sort-Object FullName -Descending |
    Select-Object -First 1
  if (-not $gitExe) { return $false }
  $gitCmdDir = Split-Path -Parent $gitExe.FullName
  $env:Path = "$gitCmdDir;$env:Path"
  return $true
}

function Resolve-MinGitDownload {
  $latestUrl = 'https://github.com/git-for-windows/git/releases/latest'
  $page = Invoke-WebRequest -Uri $latestUrl -UseBasicParsing
  $tagUrl = [string]$page.BaseResponse.ResponseUri
  if ($tagUrl -notmatch '/tag/(v[0-9.]+)\.windows\.([0-9]+)') {
    if ($page.Content -match '/git-for-windows/git/releases/tag/(v[0-9.]+)\.windows\.([0-9]+)') {
      $tagUrl = "/tag/$($Matches[1]).windows.$($Matches[2])"
    } else {
      Write-Fail 'Could not resolve the latest Git for Windows release tag.'
    }
  }
  $assetVersion = "$($Matches[1].TrimStart('v')).$($Matches[2])"
  $tag = "$($Matches[1]).windows.$($Matches[2])"
  return "https://github.com/git-for-windows/git/releases/download/$tag/MinGit-$assetVersion-64-bit.zip"
}

function Install-PortableGit {
  if (Add-PortableGitToPath) { return }
  $installRoot = Join-Path $HOME '.pilotdeck\git'
  New-Item -ItemType Directory -Force -Path $installRoot | Out-Null
  $zipPath = Join-Path ([System.IO.Path]::GetTempPath()) 'pilotdeck-mingit.zip'
  Write-Step 'Downloading portable Git for Windows (MinGit)...'
  $url = Resolve-MinGitDownload
  Invoke-WebRequest -Uri $url -OutFile $zipPath -UseBasicParsing
  $extractRoot = Join-Path ([System.IO.Path]::GetTempPath()) 'pilotdeck-mingit'
  Remove-Item -Recurse -Force -LiteralPath $extractRoot -ErrorAction SilentlyContinue
  Expand-Archive -LiteralPath $zipPath -DestinationPath $extractRoot -Force
  Remove-Item -Recurse -Force -LiteralPath $installRoot -ErrorAction SilentlyContinue
  New-Item -ItemType Directory -Force -Path $installRoot | Out-Null
  Get-ChildItem -LiteralPath $extractRoot -Force | Move-Item -Destination $installRoot
  Remove-Item -Recurse -Force -LiteralPath $extractRoot -ErrorAction SilentlyContinue
  Remove-Item -Force -LiteralPath $zipPath -ErrorAction SilentlyContinue
  if (-not (Add-PortableGitToPath)) { Write-Fail 'Portable Git install completed but git.exe was not found.' }
}

function Ensure-Prerequisites {
  if (-not (Test-Command git)) {
    if (Test-Command winget) {
      Write-Step 'Installing Git with winget...'
      [void](Invoke-WingetInstall 'Git.Git' 'Git')
      Refresh-ProcessPath
      if (-not (Test-Command git)) { Install-PortableGit }
    } else {
      Install-PortableGit
    }
  }
  Write-Ok 'git found'

  if (Test-Command git-lfs) {
    Write-Ok 'git-lfs found'
  } elseif (Test-Command winget) {
    Write-Step 'Installing Git LFS with winget...'
    if (Invoke-WingetInstall 'GitHub.GitLFS' 'Git LFS' -Optional) {
      Refresh-ProcessPath
      if (-not (Test-Command git-lfs)) { Write-Step 'Git LFS is not visible in this shell; continuing without optional media assets.' }
    }
  } else {
    Write-Step 'git-lfs not found; continuing without LFS media assets.'
  }

  [void](Resolve-NpmCommand)
}

function Test-PortFree([int]$Port) {
  try {
    $listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, $Port)
    $listener.Start()
    $listener.Stop()
    return $true
  } catch {
    return $false
  }
}

function Find-FreePort([int]$BasePort) {
  for ($offset = 0; $offset -lt $MaxPortTries; $offset++) {
    $candidate = $BasePort + $offset
    if (Test-PortFree $candidate) { return $candidate }
  }
  Write-Fail "Could not find a free port from $BasePort within $MaxPortTries tries."
}

function Install-OrUpdateRepo {
  if (Test-Path $InstallDir) {
    if (-not (Test-Path (Join-Path $InstallDir '.git'))) {
      if (-not $ForceInstall) {
        Write-Fail "$InstallDir exists but is not a git checkout. Move it away or rerun with -ForceInstall."
      }
      $backup = "$InstallDir.backup.$(Get-Date -Format yyyyMMdd-HHmmss)"
      Move-Item -LiteralPath $InstallDir -Destination $backup
      Write-Step "Moved existing directory to $backup"
    } else {
      Push-Location $InstallDir
      try {
        $oldHead = (& git rev-parse HEAD).Trim()
        & git fetch --depth 1 origin $Branch
        & git checkout $Branch
        & git reset --hard "origin/$Branch"
        $newHead = (& git rev-parse HEAD).Trim()
        $script:RepoChanged = $oldHead -ne $newHead
      } finally {
        Pop-Location
      }
      Write-Ok "Repository updated at $InstallDir"
      return
    }
  }

  $parent = Split-Path -Parent $InstallDir
  New-Item -ItemType Directory -Force -Path $parent | Out-Null
  $env:GIT_LFS_SKIP_SMUDGE = '1'
  & git -c filter.lfs.smudge= -c filter.lfs.process= -c filter.lfs.required=false clone --branch $Branch --depth 1 $RepoUrl $InstallDir
  if ($LASTEXITCODE -ne 0) { Write-Fail 'git clone failed' }
  Write-Ok "Repository cloned to $InstallDir"
}

function Ensure-LfsAssets {
  if ($SkipLfs -or $env:PILOTDECK_SKIP_LFS -eq '1') {
    Write-Step 'Skipping Git LFS assets.'
    return
  }
  if (-not (Test-Command git-lfs)) { return }

  Push-Location $InstallDir
  try {
    & git lfs install --local *> $null
    $process = Start-Process -FilePath 'git' -ArgumentList @('lfs', 'pull') -NoNewWindow -PassThru
    if (-not $process.WaitForExit($LfsTimeoutSeconds * 1000)) {
      Stop-Process -Id $process.Id -Force -ErrorAction SilentlyContinue
      Write-Step "git lfs pull timed out after ${LfsTimeoutSeconds}s; continuing without optional media assets."
      return
    }
    if ($process.ExitCode -ne 0) { Write-Step 'git lfs pull failed; continuing without optional media assets.' }
  } finally {
    Pop-Location
  }
}

function Test-DepsUpToDate {
  return (Test-Path (Join-Path $InstallDir 'node_modules')) -and
    (Test-Path (Join-Path $InstallDir 'ui\node_modules')) -and
    (Test-Path (Join-Path $InstallDir 'dist\src\cli\pilotdeck.js')) -and
    (Test-Path (Join-Path $InstallDir 'ui\dist'))
}

function Invoke-Npm([string[]]$Arguments, [string]$WorkingDirectory) {
  Push-Location $WorkingDirectory
  try {
    $env:HUSKY = '0'
    $npmPath = Resolve-NpmCommand
    & $npmPath @Arguments
    if ($LASTEXITCODE -ne 0) { Write-Fail "npm $($Arguments -join ' ') failed in $WorkingDirectory" }
  } finally {
    Pop-Location
  }
}

function Test-PlaywrightChromeForTesting {
  $candidates = @()
  if ($env:LOCALAPPDATA) {
    $candidates += Join-Path $env:LOCALAPPDATA 'ms-playwright'
  }
  if ($env:USERPROFILE) {
    $candidates += Join-Path $env:USERPROFILE '.cache\ms-playwright'
  }

  foreach ($root in $candidates) {
    if (-not (Test-Path $root)) { continue }
    $match = Get-ChildItem -LiteralPath $root -Directory -Filter 'mcp-chrome-for-testing-*' -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($match) { return $true }
  }
  return $false
}

function Ensure-BrowserUseDependency {
  Write-Step 'Checking Playwright browser for browser-use plugin...'
  if (Test-PlaywrightChromeForTesting) {
    Write-Ok 'Chrome for Testing already installed'
    return
  }

  if ($env:PILOTDECK_SKIP_BROWSER_INSTALL -ne '0') {
    Write-Step 'Skipping Chrome for Testing download (default) to keep install fast.'
    Write-Step 'PilotDeck core features are still available without this optional browser-use dependency.'
    Write-Step "To enable browser-use later, run: Set-Location `"$InstallDir`"; npm run install:browser"
    Write-Step 'Or re-run the installer with PILOTDECK_SKIP_BROWSER_INSTALL=0.'
    return
  }

  Invoke-Npm -Arguments @('run', 'install:browser') -WorkingDirectory $InstallDir
  Write-Ok 'Chrome for Testing installed'
}

function Ensure-ClawHubCli {
  Write-Step 'Checking ClawHub CLI for skill marketplace features...'
  $clawhubPath = Resolve-ClawHubCommand
  if ($clawhubPath) {
    Write-Ok "ClawHub CLI already installed ($clawhubPath)"
    return
  }

  try {
    Invoke-Npm -Arguments @('install', '-g', 'clawhub', '--no-audit', '--no-fund', '--loglevel=error') -WorkingDirectory $InstallDir
    Refresh-ProcessPath
    $clawhubPath = Resolve-ClawHubCommand
    if ($clawhubPath) {
      Write-Ok 'ClawHub CLI installed'
    } else {
      Write-Step 'ClawHub CLI install completed but clawhub is not on PATH; skill marketplace features may not work until PATH is refreshed.'
    }
  } catch {
    Write-Step "ClawHub CLI install failed; skill marketplace features may not work. $($_.Exception.Message)"
  }
}

function Install-AndBuild {
  if (-not $RepoChanged -and (Test-DepsUpToDate)) {
    Write-Ok 'Dependencies and build artifacts are up to date'
    return
  }

  Invoke-Npm -Arguments @('install', '--no-audit', '--no-fund', '--loglevel=error') -WorkingDirectory $InstallDir
  Invoke-Npm -Arguments @('install', '--no-audit', '--no-fund', '--loglevel=error') -WorkingDirectory (Join-Path $InstallDir 'ui')

  $env:PILOTDECK_CONFIG_PATH = $ConfigPath
  Invoke-Npm -Arguments @('run', 'build') -WorkingDirectory $InstallDir
  Invoke-Npm -Arguments @('run', 'build') -WorkingDirectory (Join-Path $InstallDir 'ui')
  Write-Ok 'PilotDeck built successfully'
}

function Write-CmdLauncher {
  $binDir = Join-Path $HOME '.pilotdeck\bin'
  New-Item -ItemType Directory -Force -Path $binDir | Out-Null
  $cmdPath = Join-Path $binDir 'pilotdeck.cmd'
  $ps1Path = Join-Path $binDir 'pilotdeck.ps1'
  $escapedInstallDir = $InstallDir.Replace("'", "''")
  $escapedConfigPath = $ConfigPath.Replace("'", "''")
  $nodeCommand = Get-Command node -ErrorAction SilentlyContinue
  $npmPath = Resolve-NpmCommand
  $escapedNodeDir = if ($nodeCommand) { (Split-Path -Parent $nodeCommand.Source).Replace("'", "''") } else { '' }
  $escapedNpmPath = $npmPath.Replace("'", "''")

  @"
@echo off
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0pilotdeck.ps1" %*
"@ | Set-Content -LiteralPath $cmdPath -Encoding ASCII

  @"
`$ErrorActionPreference = 'Stop'
`$InstallDir = '$escapedInstallDir'
`$ConfigPath = if (`$env:PILOTDECK_CONFIG_PATH) { `$env:PILOTDECK_CONFIG_PATH } else { '$escapedConfigPath' }
`$ServerPort = if (`$env:SERVER_PORT) { [int]`$env:SERVER_PORT } else { 3001 }
`$GatewayPort = if (`$env:PILOTDECK_GATEWAY_PORT) { [int]`$env:PILOTDECK_GATEWAY_PORT } else { 18789 }
`$MaxPortTries = if (`$env:PILOTDECK_MAX_PORT_TRIES) { [int]`$env:PILOTDECK_MAX_PORT_TRIES } else { 20 }
`$NodeDir = '$escapedNodeDir'
`$NpmPath = '$escapedNpmPath'
if (`$NodeDir -and (Test-Path `$NodeDir)) { `$env:Path = "`$NodeDir;`$env:Path" }

function Test-PortFree([int]`$Port) {
  try {
    `$listener = [System.Net.Sockets.TcpListener]::new([System.Net.IPAddress]::Loopback, `$Port)
    `$listener.Start(); `$listener.Stop(); return `$true
  } catch { return `$false }
}
function Find-FreePort([int]`$BasePort) {
  for (`$offset = 0; `$offset -lt `$MaxPortTries; `$offset++) {
    `$candidate = `$BasePort + `$offset
    if (Test-PortFree `$candidate) { return `$candidate }
  }
  throw "Could not find a free port from `$BasePort"
}

if (`$args.Count -gt 0 -and `$args[0] -eq 'status') {
  `$nextPort = Find-FreePort `$ServerPort
  Write-Host "Install path: `$InstallDir"
  Write-Host "Config:       `$ConfigPath"
  Write-Host "Next start:   http://localhost:`$nextPort"
  exit 0
}
if (`$args.Count -gt 0 -and (`$args[0] -eq 'help' -or `$args[0] -eq '--help' -or `$args[0] -eq '-h')) {
  Write-Host 'Usage: pilotdeck [status|help] [--port PORT] [--config PATH]'
  exit 0
}
for (`$i = 0; `$i -lt `$args.Count; `$i++) {
  switch -Regex (`$args[`$i]) {
    '^--port$' { `$i++; `$ServerPort = [int]`$args[`$i]; continue }
    '^--port=(.+)$' { `$ServerPort = [int]`$Matches[1]; continue }
    '^--config$' { `$i++; `$ConfigPath = `$args[`$i]; continue }
    '^--config=(.+)$' { `$ConfigPath = `$Matches[1]; continue }
  }
}

`$env:PILOTDECK_CONFIG_PATH = `$ConfigPath
`$env:SERVER_PORT = [string](Find-FreePort `$ServerPort)
`$env:PILOTDECK_GATEWAY_PORT = [string](Find-FreePort `$GatewayPort)
`$env:PILOTDECK_GATEWAY_URL = "ws://127.0.0.1:`$env:PILOTDECK_GATEWAY_PORT/ws"
& node (Join-Path `$InstallDir 'scripts\bootstrap-pilotdeck-config.mjs')
Write-Host "pilotdeck: starting at http://localhost:`$env:SERVER_PORT"
Set-Location (Join-Path `$InstallDir 'ui')
& `$NpmPath run start:built
"@ | Set-Content -LiteralPath $ps1Path -Encoding UTF8

  if (-not $NoPathUpdate) { Add-UserPath $binDir }
  Write-Ok "pilotdeck launcher written to $cmdPath"
}

function Bootstrap-Config {
  $env:PILOTDECK_CONFIG_PATH = $ConfigPath
  & node (Join-Path $InstallDir 'scripts\bootstrap-pilotdeck-config.mjs')
  if ($LASTEXITCODE -ne 0) { Write-Fail 'Config bootstrap failed' }
}

Ensure-NodeRuntime
Ensure-Prerequisites
Install-OrUpdateRepo
Ensure-LfsAssets
Install-AndBuild
Ensure-BrowserUseDependency
Ensure-ClawHubCli
Write-CmdLauncher

$env:PILOTDECK_CONFIG_PATH = $ConfigPath
$env:SERVER_PORT = [string](Find-FreePort $ServerPort)
$env:PILOTDECK_GATEWAY_PORT = [string](Find-FreePort $GatewayPort)
$env:PILOTDECK_GATEWAY_URL = "ws://127.0.0.1:$env:PILOTDECK_GATEWAY_PORT/ws"
Bootstrap-Config

Write-Host ''
Write-Host 'Installation complete!' -ForegroundColor Green
Write-Host "  App location: $InstallDir"
Write-Host "  Config file:  $ConfigPath"
Write-Host "  CLI command:  pilotdeck"
Write-Host "  UI:           http://localhost:$env:SERVER_PORT"
Write-Host "  Gateway:      $env:PILOTDECK_GATEWAY_URL"
Write-Host ''
Write-Host 'Open the Web UI to finish onboarding: choose a provider, paste an API key, and pick a model.'
Write-Host ''

if (-not $SkipStart) {
  Write-Host "Starting server; open http://localhost:$env:SERVER_PORT"
  Set-Location (Join-Path $InstallDir 'ui')
  $npmPath = Resolve-NpmCommand
  & $npmPath run start:built
}
