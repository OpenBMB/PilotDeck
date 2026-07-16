---
name: powershell
description: "Run safe PowerShell commands on Windows, translate Bash snippets, and troubleshoot native Windows setup."
---

# PowerShell

Use this skill when the user is on Windows, asks for PowerShell commands, or needs native Windows setup/troubleshooting instead of Bash or WSL.

## Shell Choice

- Prefer `pwsh` when PowerShell 7 is installed.
- Use `powershell.exe` for built-in Windows PowerShell compatibility.
- In documentation, use fenced code blocks with `powershell` and avoid Bash-only operators such as `&&` unless explicitly running inside WSL/Git Bash.

## Safe Command Patterns

Read-only checks:

```powershell
$PSVersionTable.PSVersion
Get-Command node, npm, git, python, rg -ErrorAction SilentlyContinue
node --version
npm --version
git --version
python --version
rg --version
```

Path inspection:

```powershell
Get-Location
Get-ChildItem
Resolve-Path .
$env:PATH -split ';'
```

Run commands in sequence with explicit lines:

```powershell
Set-Location C:\path\to\PilotDeck
node --version
corepack enable
corepack pnpm install --frozen-lockfile
```

Use `npm.cmd` or `pnpm.cmd` when PowerShell execution policy blocks `.ps1` shims:

```powershell
npm.cmd --version
pnpm.cmd --version
```

## PilotDeck Native Windows Notes

Native Windows source installs need Node.js 22, Git/Git LFS, Python, Visual Studio C++ Build Tools, and ripgrep. WSL2 is usually simpler for development, but native PowerShell is supported for users who want a Windows-only workflow.

Install common prerequisites with `winget`:

```powershell
winget install OpenJS.NodeJS.LTS
winget install Git.Git
winget install GitHub.GitLFS
winget install Python.Python.3.12
winget install BurntSushi.ripgrep.MSVC
winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

After installing tools, close and reopen PowerShell so `PATH` changes take effect.

## Safety

- Be careful with destructive commands such as `Remove-Item -Recurse -Force`; confirm the target path first.
- Avoid changing execution policy globally unless the user explicitly asks and understands the risk.
- Prefer project-local or session-local changes over machine-wide changes.
