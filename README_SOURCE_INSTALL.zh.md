# 源码安装指南

本文档适合希望直接从源码运行 PilotDeck 的开发者。如果只是想快速体验，建议优先使用一键安装脚本或 Docker。

## 环境要求

PilotDeck 需要：

- Node.js v22.13.0 或更新的 Node.js 22 版本，并且支持内置 `node:sqlite` 运行时。
- Git。
- Git LFS 对源码安装是可选项。只有需要下载大型演示媒体文件时，才需要通过 `git lfs pull` 获取。
- Node 原生依赖（如 `node-pty`、`better-sqlite3`、`bcrypt`、`sharp`）所需的编译工具：Python 3、`make` 和 C/C++ 编译器。
- `ripgrep` (`rg`)，内置文件/搜索工具会用到。

## 安装系统依赖

### 中国大陆网络建议

如果访问 GitHub、npm 或 Node.js 官方下载源较慢，可以先配置国内镜像。下面配置只影响当前用户的 npm 包下载：

```bash
npm config set registry https://registry.npmmirror.com
```

如果使用 `pnpm` 安装依赖，也可以直接设置 pnpm registry：

```bash
pnpm config set registry https://registry.npmmirror.com
```

当 `node-pty`、`better-sqlite3` 等原生依赖回退到源码编译时，`node-gyp` 还会下载 Node.js headers。如果访问 Node.js 官方源超时，可为当前 shell 指定 Node.js headers 镜像：

```bash
export npm_config_disturl=https://npmmirror.com/mirrors/node
```

如需恢复 npm 官方源：

```bash
npm config delete registry
```

使用 `fnm` 安装 Node.js 时，可临时指定 Node.js 下载镜像：

```bash
FNM_NODE_DIST_MIRROR=https://npmmirror.com/mirrors/node fnm install 22
```

Linux 系统包安装较慢时，建议先按发行版文档切换 apt/dnf/pacman 软件源镜像。克隆 GitHub 仓库或下载 Git LFS 文件较慢、出现 `fetch-pack: unexpected disconnect` 等网络错误时，请重试或优先使用稳定的网络代理。下面的源码安装流程默认跳过 Git LFS 管理的大型演示媒体文件。

### macOS

当原生依赖回退到源码编译时，需要可用的 Xcode Command Line Tools。如果 `xcrun --find clang` 失败，或依赖安装在编译原生包时报缺少编译工具，请安装：

```bash
xcode-select --install
```

如果使用 Homebrew，可安装 Git LFS、ripgrep 和 Node.js：

```bash
brew install git-lfs ripgrep node
```

确认 Node.js 版本足够新：

```bash
node --version
```

如果 Homebrew 安装的 Node.js 低于 v22.13.0，请使用你偏好的 Node 版本管理器安装更新版本。

在 Intel Mac 上，请确认 Node.js 是 Intel/x64 架构版本，而不是从 Apple Silicon 机器复制来的 arm64 版本，或在 Rosetta 环境里混用的版本。安装依赖前同时检查 Node 版本和架构：

```bash
node --version          # 必须为 v22.13.0 或更新版本，且低于 v23
node -p "process.arch" # Intel Mac 上应输出 x64
```

如果 `process.arch` 和当前 Mac 架构不一致，请重新安装对应架构的 Node.js 22，删除旧的依赖目录，然后重新执行下面的 pnpm 安装步骤。`better-sqlite3`、`node-pty`、`bcrypt`、`sharp` 等原生依赖都和 CPU 架构相关，不支持在 Apple Silicon 和 Intel Mac 之间直接复制 `node_modules`。

某些 Python 发行版（尤其是通过包管理器安装的 Python 3.12）可能不包含 `distutils`，而旧版 `node-gyp` 在源码编译原生包时仍会用到它。一键安装脚本会尝试自动选择带 `distutils` 的 Python。如果你手动运行 npm 命令并看到 `ModuleNotFoundError: No module named 'distutils'`，请使用带 `distutils` 的 Python，例如：

```bash
PYTHON=/usr/bin/python3 corepack pnpm install --frozen-lockfile
```

只安装 CLT 即可，不需要完整 Xcode。如果已安装但 `xcrun --find clang` 仍失败，请运行 `sudo xcode-select --reset`，或重新安装 Xcode Command Line Tools 后重试。

### Debian / Ubuntu

```bash
sudo apt-get update
sudo apt-get install -y git git-lfs ripgrep build-essential python3
```

安装 Node.js v22.13.0 或更新的 Node.js 22 版本。常见方式之一是使用 `fnm`：

```bash
curl -fsSL https://fnm.vercel.app/install | bash
# 重启 shell 后执行：
FNM_NODE_DIST_MIRROR=https://npmmirror.com/mirrors/node fnm install 22
fnm use 22
node --version
```

如果没有 sudo 权限，或不希望修改系统 Node.js，也可以把官方 Node.js 二进制包安装到用户目录。下面示例安装到 `~/.local`，只影响当前用户和当前 shell：

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

然后通过你偏好的软件源或 Node 版本管理器安装 Node.js v22.13.0 或更新的 Node.js 22 版本。

### Arch Linux

```bash
sudo pacman -Sy --needed git git-lfs ripgrep base-devel python nodejs npm
```

确认 `node --version` 显示 v22.13.0 或更新版本，且低于 v23。

### Windows

Windows 支持多种源码部署路径。你不需要为每条路径安装所有工具。

| 路径 | 需要在 Windows 安装 | 适合场景 |
|---|---|---|
| WSL2 Ubuntu | WSL2、Ubuntu，然后在 Ubuntu 内安装 Linux 编译工具 | 源码部署和开发 |
| Docker Desktop | 启用 WSL2 backend 的 Docker Desktop、Git for Windows | 不想在本机管理 Node/native build 环境，只想运行 PilotDeck |
| 原生 Windows | Node.js、Git LFS、Python、Visual Studio C++ Build Tools、ripgrep | 只用 PowerShell 进行开发 |
| Portable Node | 官方 Node.js zip、Git for Windows、Git LFS、ripgrep | 不修改系统 Node 设置，先验证部署流程 |

先在 PowerShell 中快速检查依赖：

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

缺少命令说明对应工具还没有安装，或还没有加入 `PATH`。安装工具后，请关闭并重新打开 PowerShell 再检查。Git for Windows 会包含 Git Bash；PilotDeck 在 Windows 上会优先使用 Git Bash 作为默认终端 shell，只有找不到 Git Bash 时才回退到 PowerShell。

#### WSL2 Ubuntu（推荐）

在管理员 PowerShell 中安装 WSL2 和 Ubuntu：

```powershell
wsl --install -d Ubuntu
```

如果系统提示重启，请重启 Windows；完成 Ubuntu 首次用户设置后，在 Ubuntu shell 中按 Debian / Ubuntu 小节安装依赖。

#### Docker Desktop

安装 Docker Desktop 并启用 WSL2 backend：

```powershell
winget install Docker.DockerDesktop
```

安装后启动一次 Docker Desktop，等待 engine 运行，然后检查：

```powershell
docker --version
docker compose version
```

如果选择 Docker 路径，请按 `README_DOCKER.md` 中的 Docker 说明操作。Docker 构建会在容器内使用 Node.js 22 和仓库提交的 pnpm lockfile，因此不依赖宿主机 Node.js 架构。

#### 原生 Windows PowerShell

原生 Windows 适合希望直接在 PowerShell 中开发的用户，但它比 WSL2 更容易受到 native npm 依赖编译环境影响。

使用 `winget` 安装依赖：

```powershell
winget install OpenJS.NodeJS.LTS
winget install Git.Git
winget install GitHub.GitLFS
winget install Python.Python.3.12
winget install BurntSushi.ripgrep.MSVC
winget install Microsoft.VisualStudio.2022.BuildTools --override "--wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

然后打开新的 PowerShell 窗口并运行：

```powershell
git lfs install
node --version   # 必须为 v22.13.0 或更新版本，且低于 v23
node -p "process.arch" # 原生 Windows 源码安装应输出 x64
npm --version
python --version
rg --version
```

`OpenJS.NodeJS.LTS` 可能会随时间切换到更新的 Node.js 大版本。如果 `node --version` 不是 `v22.x`，请先切换到 Portable Node 或 Node 版本管理器，再安装依赖。

原生 Windows 源码安装按 x64 Node.js 验证。如果 `node -p "process.arch"` 不是 `x64`，请先切换到官方 x64 Node.js 22 zip，或其他 x64 Node.js 运行时，再安装依赖。

执行上面的前置依赖检查命令时，请使用分开的 PowerShell 命令行，不要使用 Bash 风格的链式命令。安装 Git for Windows 后，PilotDeck 内置终端会自动优先使用 Git Bash。如果 PowerShell 拦截 `npm.ps1`，请改用 `npm.cmd`。

#### Portable Node 验证路径

如果想在全局安装 Node.js 前先验证 PilotDeck，可只在当前 PowerShell 会话中使用官方 Windows Node.js zip：

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

使用 Portable Node 时，仍然请按下面的源码安装命令执行：`corepack pnpm install --frozen-lockfile`、`corepack pnpm run build` 和 `corepack pnpm --prefix ui run build`。只有在确实需要直接调用 npm 且 PowerShell 拦截 `npm.ps1` 时，才改用 `npm.cmd`。

## 克隆仓库

克隆源码，默认不下载 Git LFS 管理的大型演示媒体文件：

```bash
GIT_LFS_SKIP_SMUDGE=1 git clone https://github.com/OpenBMB/PilotDeck.git
cd PilotDeck
```

如果之后需要演示视频/GIF，可在克隆后下载：

```bash
git lfs pull
```

## 安装 Node 依赖

```bash
node --version          # 必须为 v22.13.0 或更新版本，且低于 v23
corepack enable         # 启用 package.json 中固定的 pnpm 版本
corepack pnpm install --frozen-lockfile
```

如果当前环境没有 Corepack，或正在使用用户目录安装的 Portable Node，可改用固定版本的全局 pnpm：

```bash
npm install -g pnpm@10.32.1
pnpm install --frozen-lockfile
```

源码安装请使用仓库提交的 `pnpm-lock.yaml`。不要把这一步替换成 `npm install`；当前 lockfile 和 workspace 构建配置按 pnpm 维护，一键安装脚本验证的也是这条路径。

当前应用使用 `better-sqlite3` 和 Node.js 22 内置的 `node:sqlite`，不需要旧的 `sqlite` 或 `sqlite3` npm 包。

ClawHub CLI 是可选项，但如果需要使用技能市场功能，建议安装：

```bash
npm install -g clawhub
clawhub --version
```

在 Windows 上，如果 PowerShell 拦截 `npm.ps1`，请使用 `npm.cmd install -g clawhub`。如果使用 Portable Node，`clawhub` 会安装到当前 portable Node 前缀下；运行 PilotDeck 时需要继续保留该 Node 目录在 `PATH` 中。

## 首次 Onboarding

PilotDeck 读取 `~/.pilotdeck/pilotdeck.yaml`。如果本机还没有配置文件，生产模式启动前请先准备 Web UI 的首次 onboarding 流程：

```bash
node scripts/bootstrap-pilotdeck-config.mjs
```

该命令会初始化 `~/.pilotdeck/pilotdeck.yaml`，让 Gateway 可以启动并进入首次 onboarding。随后打开 Web UI，在 onboarding/设置面板中完成 Provider 和 API Key 配置。

注意：首次生成的配置只是占位配置，包含 `_placeholder/_placeholder`、`https://placeholder.invalid` 和 `PLACEHOLDER_RUN_ONBOARDING_TO_REPLACE`。它的作用是让 Gateway 和 Web UI 可以启动；在填写真实 Provider、API Key 和模型前，UI 仍会进入 onboarding，这是预期行为。

## 启动 PilotDeck

开发模式，支持 HMR：

```bash
cd ui
npm run dev
```

打开 <http://localhost:5173>。

生产模式：

```bash
cd ui
npm run start
```

打开 <http://localhost:3001>。

如果默认端口已被占用，可以通过环境变量换端口，例如：

```bash
SERVER_PORT=3002 PILOTDECK_GATEWAY_PORT=18790 PILOTDECK_GATEWAY_URL=ws://127.0.0.1:18790/ws npm run start
```

## 常见问题

- 出现 `Node.js >=22.13.0 and <23 is required`：切换到 Node.js 22.13.0 或更新的 Node.js 22 版本，并重新安装依赖。
- 原生包编译失败：确认已安装 Python 3、`make` 和 C/C++ 编译器，然后重新运行 `corepack pnpm install --frozen-lockfile`。
- Linux 上 `node-pty`、`better-sqlite3` 编译时下载 `node-v*-headers.tar.gz` 超时：先运行 `export npm_config_disturl=https://npmmirror.com/mirrors/node`，再重新安装依赖。
- `pnpm install --frozen-lockfile` 下载 npm 包超时：运行 `pnpm config set registry https://registry.npmmirror.com` 后重试。
- macOS 出现 `ModuleNotFoundError: No module named 'distutils'`：一键安装脚本会尝试自动选择兼容 Python；手动运行 npm 命令时，可用 `PYTHON=/usr/bin/python3 corepack pnpm install --frozen-lockfile` 重试，或切换到其他带 `distutils` 的 Python。
- macOS 缺少编译工具：不需要完整 Xcode，但 `xcrun --find clang` 必须可用。可运行 `xcode-select --install` 重新安装 Xcode Command Line Tools；如果已安装但状态异常，可运行 `sudo xcode-select --reset` 后重试。
- 启动时报 `EADDRINUSE`：默认 `3001` 或 `18789` 已被占用，设置 `SERVER_PORT`、`PILOTDECK_GATEWAY_PORT` 和 `PILOTDECK_GATEWAY_URL` 后重试。
- 已有 `~/.pilotdeck/pilotdeck.yaml` 但仍进入 onboarding：检查配置里是否仍是 `PLACEHOLDER_RUN_ONBOARDING_TO_REPLACE` 或 `_placeholder/_placeholder`，需要替换为真实 Provider、API Key 和模型。
- 缺少演示图片/视频：安装 Git LFS 后，在仓库根目录运行 `git lfs pull`。
- 提示找不到 `rg`：安装 ripgrep 以启用完整的文件/搜索工具能力。
