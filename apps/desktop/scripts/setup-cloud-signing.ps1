param([string]$Destination = (Join-Path $env:RUNNER_TEMP 'pilotdeck-signing-tools'))
$ErrorActionPreference = 'Stop'
# Pinned release, including the EV intermediate-certificate fix. Updating either
# value requires reviewing the upstream release and re-running a real signing test.
$url = 'https://github.com/Le-Syl21/ssign/releases/download/v0.1.8/ssign-windows-x86_64.zip'
$expected = '89cbac647d19819a1a82645d2254ac51d2b34050835421294584385dadde1298'
New-Item -ItemType Directory -Force -Path $Destination | Out-Null
$archive = Join-Path $Destination 'ssign.zip'
Invoke-WebRequest -Uri $url -OutFile $archive
if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash -ne $expected) { throw 'ssign download checksum mismatch.' }
Expand-Archive -LiteralPath $archive -DestinationPath $Destination -Force
$cloudTool = Join-Path $Destination 'ssign.exe'
if (-not (Test-Path -LiteralPath $cloudTool)) { throw 'ssign.exe is missing.' }
& $cloudTool --version
if ($LASTEXITCODE -ne 0) { throw 'ssign cannot run on this Windows host.' }

if ($env:SIGNTOOL_PATH -and (Test-Path -LiteralPath $env:SIGNTOOL_PATH)) {
  $signTool = $env:SIGNTOOL_PATH
} else {
  $sdkRoot = Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10\bin'
  $nativeArch = if ($env:PROCESSOR_ARCHITECTURE -eq 'ARM64') { 'arm64' } else { 'x64' }
  $signTool = Get-ChildItem -LiteralPath $sdkRoot -Directory |
    Where-Object { $_.Name -match '^10\.0\.\d+\.\d+$' } |
    Sort-Object { [version]$_.Name } -Descending |
    ForEach-Object { Join-Path $_.FullName "$nativeArch\signtool.exe" } |
    Where-Object { Test-Path -LiteralPath $_ } | Select-Object -First 1
}
if (-not $signTool) { throw 'Install the Windows SDK signing tools or set SIGNTOOL_PATH.' }
if ($env:GITHUB_ENV) {
  "PILOTDECK_SSIGN_PATH=$cloudTool" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
  "SIGNTOOL_PATH=$signTool" | Out-File -FilePath $env:GITHUB_ENV -Encoding utf8 -Append
}
Write-Host 'Cloud signing tool and Windows signature verifier are ready. No credentials were used.'
