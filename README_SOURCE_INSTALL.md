# Source Installation Guide

This guide is for developers who want to run PilotDeck directly from source instead of using the one-line installer or Docker.

## Prerequisites

PilotDeck requires:

- Node.js v22.13.0 or newer within the Node.js 22 line, with the built-in `node:sqlite` runtime.
- Git.
- Git LFS is optional for source installs. It is only needed if you want to download large demo media assets with `git lfs pull`.
- Native build tools for npm packages such as `node-pty`, `better-sqlite3`, `bcrypt`, and `sharp`: Python 3, `make`, and a C/C++ compiler.
- `ripgrep` (`rg`) for built-in file/search tools.

## Install System Dependencies

### macOS

Xcode Command Line Tools are required if native packages fall back to source builds. Install them if `xcrun --find clang` fails, or if dependency installation reports missing compiler tools while building native packages:

```bash
xcode-select --install
```

If you use Homebrew, install Git LFS, ripgrep, and Node.js:

```bash
brew install git-lfs ripgrep node
```

Make sure Node.js is new enough:

```bash
node --version
```

If your Homebrew Node.js is older than v22.13.0, install a newer Node.js with your preferred Node version manager.

On Intel Macs, make sure your Node.js runtime is the Intel/x64 build, not an Apple Silicon arm64 build launched through Rosetta or copied from another machine. Check both the Node version and architecture before installing dependencies:

```bash
node --version          # must be v22.13.0 or newer, and below v23
node -p "process.arch" # should print x64 on Intel Macs
```

If `process.arch` does not match the Mac you are deploying on, reinstall Node.js 22 for the correct architecture, remove the old dependency folders, and rerun the pnpm install step below. Native packages such as `better-sqlite3`, `node-pty`, `bcrypt`, and `sharp` are architecture-specific, so copying `node_modules` between Apple Silicon and Intel Macs is not supported.

Some Python distributions, especially Python 3.12 installed through package managers, may not include `distutils`, which older `node-gyp` versions still need when native packages compile from source. The one-line installer tries to auto-select a Python that provides `distutils`. If you run npm commands manually and see `ModuleNotFoundError: No module named 'distutils'`, use a Python that provides it, for example:

```bash
PYTHON=/usr/bin/python3 corepack pnpm install --frozen-lockfile
```

A CLT-only installation is enough; full Xcode is not required. If the tools are installed but `xcrun --find clang` fails, run `sudo xcode-select --reset` or reinstall Xcode Command Line Tools before retrying.

If cloning from GitHub or downloading Git LFS files is slow or fails with network errors such as `fetch-pack: unexpected disconnect`, retry or use a stable network proxy. The source install flow below skips large Git LFS demo media by default.

If you install dependencies with `pnpm`, you can set the pnpm registry directly:

```bash
pnpm config set registry https://registry.npmmirror.com
```

When native dependencies such as `node-pty` or `better-sqlite3` fall back to source builds, `node-gyp` also downloads Node.js headers. If downloads from the official Node.js host time out, set a Node.js headers mirror for the current shell:

```bash
export npm_config_disturl=https://npmmirror.com/mirrors/node
```


### Debian / Ubuntu

```bash
sudo apt-get update
sudo apt-get install -y git git-lfs ripgrep build-essential python3
```

Install Node.js v22.13.0 or newer within the Node.js 22 line. One common option is `fnm`:

```bash
curl -fsSL https://fnm.vercel.app/install | bash
# Restart your shell, then:
fnm install 22
fnm use 22
node --version
```

If you do not have sudo access, or do not want to modify the system Node.js installation, install the official Node.js binary into a user directory. This example installs into `~/.local` and only affects the current user and shell:

```bash
NODE_VERSION=22.13.1
NODE_DIR="$HOME/.local/node-v${NODE_VERSION}-linux-x64"
mkdir -p "$HOME/.local"
curl -fsSLO "https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-x64.tar.xz"
tar -xf "node-v${NODE_VERSION}-linux-x64.tar.xz" -C "$HOME/.local"
rm "node-v${NODE_VERSION}-linux-x64.tar.xz"
export PATH="$NODE_DIR/bin:$PATH"
node --version
npm install -g pnpm@10.32.1
pnpm --version
```

### Fedora / RHEL

```bash
sudo dnf install -y git git-lfs ripgrep gcc gcc-c++ make python3
```

Then install Node.js v22.13.0 or newer within the Node.js 22 line using your preferred package source or Node version manager.

### Arch Linux

```bash
sudo pacman -Sy --needed git git-lfs ripgrep base-devel python nodejs npm
```

Make sure `node --version` reports v22.13.0 or newer, and below v23.

### Windows

Windows supports several source-deployment paths. You do **not** need to install every tool for every path.

| Path | Install on Windows | Best for |
|---|---|---|
| WSL2 Ubuntu | WSL2, Ubuntu, then Linux build tools inside Ubuntu | Source deployment and development |
| Docker Desktop | Docker Desktop with WSL2 backend, Git for Windows | Running PilotDeck without local Node/native build setup |
| Native Windows | Node.js, Git LFS, Python, Visual Studio C++ Build Tools, ripgrep | PowerShell-only development |
| Portable Node | Official Node.js zip, Git for Windows, Git LFS, ripgrep | Verifying deployment without changing system Node settings |

Quick prerequisite check in PowerShell:

```powershell
node --version
npm --version
git --version
git lfs version
python --version
rg --version
docker --version
docker compose version
wsl --status
```

Missing commands mean the corresponding tool still needs to be installed or added to `PATH`. After installing tools, close and reopen PowerShell before checking again. Git for Windows includes Git Bash; PilotDeck uses Git Bash as the default Windows terminal shell when it is available, and falls back to PowerShell only when Git Bash cannot be found.

#### WSL2 Ubuntu (recommended)

Install WSL2 and Ubuntu from an elevated PowerShell window:

```powershell
wsl --install -d Ubuntu
```

Restart Windows if prompted, finish Ubuntu first-run setup, then follow the Debian / Ubuntu instructions inside the Ubuntu shell.

#### Docker Desktop

Install Docker Desktop and enable the WSL2 backend:

```powershell
winget install Docker.DockerDesktop
```

Start Docker Desktop once after installation, wait until the engine is running, then verify:

```powershell
docker --version
docker compose version
```

Use the Docker instructions in `README_DOCKER.md` if you choose this path. Docker builds use Node.js 22 and the committed pnpm lockfile inside the container, so they do not depend on the host Node.js architecture.

#### Native Windows PowerShell

Native Windows is useful if you want to develop directly from PowerShell. It is more sensitive to native npm dependency compilation than WSL2.

Install prerequisites with `winget`:

```powershell
winget install OpenJS.NodeJS.LTS
winget install Git.Git
winget install GitHub.GitLFS
winget install Python.Python.3.12
winget install BurntSushi.ripgrep.MSVC
winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

Then open a new PowerShell window and run:

```powershell
git lfs install
node --version   # must be v22.13.0 or newer, and below v23
node -p "process.arch" # native Windows source installs should print x64
npm --version
python --version
rg --version
```

`OpenJS.NodeJS.LTS` may move to a newer major Node.js release over time. If `node --version` is not `v22.x`, switch to Portable Node or a Node version manager before installing dependencies.

Native Windows source installs are tested on x64 Node.js. If `node -p "process.arch"` does not print `x64`, switch to the official x64 Node.js 22 zip or another x64 Node.js runtime before installing dependencies.

Use separate PowerShell lines instead of Bash-style chained commands when following the prerequisite commands above. For PilotDeck's in-app terminal, Git Bash is preferred automatically after Git for Windows is installed. If PowerShell blocks `npm.ps1`, call `npm.cmd` instead of `npm`.

#### Portable Node for verification

If you want to test PilotDeck before installing Node.js globally, use the official Windows Node.js zip for the current terminal session only:

```powershell
$NodeVersion = '22.23.1'
$WorkDir = Join-Path $PWD '.pilotdeck-node'
$ZipPath = Join-Path $WorkDir "node-v$NodeVersion-win-x64.zip"
$NodeUrl = "https://nodejs.org/dist/v$NodeVersion/node-v$NodeVersion-win-x64.zip"

New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
Invoke-WebRequest -Uri $NodeUrl -OutFile $ZipPath

$ExtractDir = Join-Path $WorkDir 'node'
New-Item -ItemType Directory -Force -Path $ExtractDir | Out-Null
tar -xf $ZipPath -C $ExtractDir
$NodeDir = Join-Path $ExtractDir "node-v$NodeVersion-win-x64"
$env:PATH = "$NodeDir;$env:PATH"

node --version
npm.cmd --version
```

With portable Node, keep using the source install commands below: `corepack pnpm install --frozen-lockfile`, `corepack pnpm run build`, and `corepack pnpm --prefix ui run build`. Use `npm.cmd` only when you need to invoke npm directly and PowerShell blocks `npm.ps1`.

## Clone the Repository

Clone the source code without downloading large Git LFS demo media:

```bash
GIT_LFS_SKIP_SMUDGE=1 git clone https://github.com/OpenBMB/PilotDeck.git
cd PilotDeck
```

If you need the demo videos/GIFs later, download them after cloning:

```bash
git lfs pull
```

## Install Node Dependencies

```bash
node --version          # must be v22.13.0 or newer, and below v23
corepack enable         # enables the pinned pnpm version from package.json
corepack pnpm install --frozen-lockfile
```

If Corepack is unavailable, or if you are using a user-directory Portable Node installation, install the pinned pnpm version globally instead:

```bash
npm install -g pnpm@10.32.1
pnpm install --frozen-lockfile
```

Use the committed `pnpm-lock.yaml` for source installs. Do not replace this step with `npm install`; the lockfile and workspace build settings are maintained for pnpm, and pnpm is the path tested by the one-line installer.

The app uses `better-sqlite3` and Node.js 22's built-in `node:sqlite`. It does not require the legacy `sqlite` or `sqlite3` npm packages.

ClawHub CLI is optional, but recommended for skill marketplace features:

```bash
npm install -g clawhub
clawhub --version
```

On Windows, use `npm.cmd install -g clawhub` if PowerShell blocks `npm.ps1`. With Portable Node, this installs `clawhub` into the portable Node prefix, so keep that Node directory on `PATH` when running PilotDeck.

## First-Run Onboarding

PilotDeck reads `~/.pilotdeck/pilotdeck.yaml`. If you do not already have a config file, prepare the Web UI onboarding flow before starting in production mode:

```bash
node scripts/bootstrap-pilotdeck-config.mjs
```

This initializes `~/.pilotdeck/pilotdeck.yaml` for first-run onboarding so the Gateway can boot. Then open the Web UI and finish provider/API key setup in the onboarding/settings panel.

Note: the generated first-run config is a placeholder. It contains `_placeholder/_placeholder`, `https://placeholder.invalid`, and `PLACEHOLDER_RUN_ONBOARDING_TO_REPLACE`. Its purpose is to let the Gateway and Web UI boot; the UI still routes to onboarding until you provide a real provider, API key, and model.

## Start PilotDeck

Development mode with HMR:

```bash
cd ui
npm run dev
```

Open <http://localhost:5173>.

Production mode:

```bash
cd ui
npm run start
```

Open <http://localhost:3001>.

If the default ports are already in use, change them with environment variables, for example:

```bash
SERVER_PORT=3002 PILOTDECK_GATEWAY_PORT=18790 PILOTDECK_GATEWAY_URL=ws://127.0.0.1:18790/ws npm run start
```

## Troubleshooting

- `Node.js >=22.13.0 and <23 is required`: switch to Node.js 22.13.0 or newer within the Node.js 22 line, then reinstall dependencies.
- Native package build errors: make sure Python 3, `make`, and a C/C++ compiler are installed, then rerun `corepack pnpm install --frozen-lockfile`.
- Linux `node-pty` or `better-sqlite3` builds time out while downloading `node-v*-headers.tar.gz`: run `export npm_config_disturl=https://npmmirror.com/mirrors/node`, then reinstall dependencies.
- `pnpm install --frozen-lockfile` times out while downloading npm packages: run `pnpm config set registry https://registry.npmmirror.com`, then retry.
- `ModuleNotFoundError: No module named 'distutils'` on macOS: the one-line installer tries to auto-select a compatible Python; for manual npm commands, retry with `PYTHON=/usr/bin/python3 corepack pnpm install --frozen-lockfile`, or use another Python that includes `distutils`.
- Missing compiler tools on macOS: full Xcode is not required, but `xcrun --find clang` must work. Reinstall Xcode Command Line Tools with `xcode-select --install`, or run `sudo xcode-select --reset` if CLT is already installed.
- `EADDRINUSE` on startup: the default `3001` or `18789` port is already in use. Set `SERVER_PORT`, `PILOTDECK_GATEWAY_PORT`, and `PILOTDECK_GATEWAY_URL`, then retry.
- `~/.pilotdeck/pilotdeck.yaml` exists but the UI still opens onboarding: check whether the config still contains `PLACEHOLDER_RUN_ONBOARDING_TO_REPLACE` or `_placeholder/_placeholder`; replace them with a real provider, API key, and model.
- Missing demo images/videos: install Git LFS and run `git lfs pull` from the repo root.
- `rg` not found: install ripgrep for full file/search tool support.
