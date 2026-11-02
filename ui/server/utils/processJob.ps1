param([int]$GuardianPid, [string]$ReadyFile, [string]$StoppedFile, [string]$StopFile, [string]$GuardianBirth)
$ErrorActionPreference = 'Stop'
Add-Type -Path (Join-Path $PSScriptRoot 'processHost.cs')
[PilotDeckJob]::Run($GuardianPid, $ReadyFile, $StoppedFile, $StopFile, $GuardianBirth)
