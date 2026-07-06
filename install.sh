#!/usr/bin/env bash
set -euo pipefail

# PilotDeck one-line installer for macOS and Linux.
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/OpenBMB/PilotDeck/main/install.sh | bash

REPO_URL="${PILOTDECK_REPO_URL:-https://github.com/OpenBMB/PilotDeck.git}"
BRANCH="${PILOTDECK_BRANCH:-main}"
INSTALL_DIR="${PILOTDECK_INSTALL_DIR:-$HOME/.pilotdeck/app}"
CONFIG_FILE="${PILOTDECK_CONFIG_PATH:-$HOME/.pilotdeck/pilotdeck.yaml}"
BIN_LINK="${PILOTDECK_BIN_LINK:-/usr/local/bin/pilotdeck}"
MAX_PORT_TRIES="${PILOTDECK_MAX_PORT_TRIES:-20}"
MIN_NODE_VERSION="22.13.0"
NODE_INSTALL_VERSION="${PILOTDECK_NODE_VERSION:-22}"
APT_UPDATED=0
# 1 = repo was (re)cloned or its HEAD changed; drives whether we reinstall/rebuild.
REPO_CHANGED=1

GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
DIM='\033[2m'
BOLD='\033[1m'
RESET='\033[0m'

ok() { printf "  ${GREEN}✓${RESET} %s\n" "$1"; }
warn() { printf "  ${YELLOW}→${RESET} %s\n" "$1"; }
fail() { printf "  ${RED}✗${RESET} %s\n" "$1"; exit 1; }

# Localized string picker: L "<english>" "<chinese>" prints one based on PD_LANG.
# Any ${vars} are expanded by the caller before L runs, so interpolation works
# in both languages.
L() {
  if [[ "${PD_LANG:-en}" == "zh" ]]; then
    printf "%s" "$2"
  else
    printf "%s" "$1"
  fi
}

# Language for user-facing guidance (en|zh). Resolution order:
#   1. PILOTDECK_LANG env var (en/zh)
#   2. Interactive prompt when a terminal is available (works with curl | bash
#      because we read from /dev/tty, not the piped stdin)
#   3. Auto-detect from the locale ($LANG / $LC_ALL); default to English.
PD_LANG="en"

select_language() {
  case "${PILOTDECK_LANG:-}" in
    zh|cn|zh_CN|zh-CN|中文) PD_LANG="zh"; return ;;
    en|en_US|en-US|english|English) PD_LANG="en"; return ;;
  esac

  # Prompt only if we can actually open the controlling terminal. This works
  # under `curl ... | bash` (stdin is the pipe, but /dev/tty is the terminal)
  # and cleanly falls back when there is no terminal at all (CI, nohup, etc.).
  if { exec 3</dev/tty; } 2>/dev/null; then
    printf "\n${BOLD}Select language / 选择语言${RESET}\n"
    printf "  1) English\n"
    printf "  2) 中文\n"
    printf "> "
    local answer=""
    read -r answer <&3 || answer=""
    exec 3<&-
    case "$answer" in
      2|zh|cn|中文|中) PD_LANG="zh" ;;
      *) PD_LANG="en" ;;
    esac
    return
  fi

  case "${LC_ALL:-}${LANG:-}" in
    *zh*|*ZH*) PD_LANG="zh" ;;
    *) PD_LANG="en" ;;
  esac
}

# Post-install onboarding guide, shown once the app is ready to start.
# Explains the single most important next step — configuring a model + API key —
# plus the manual config path, CLI commands, and where to find docs.
print_getting_started() {
  local ui_url="$1"
  if [[ "$PD_LANG" == "zh" ]]; then
    print_getting_started_zh "$ui_url"
  else
    print_getting_started_en "$ui_url"
  fi
}

print_getting_started_en() {
  local ui_url="$1"
  echo ""
  echo -e "${BOLD}Getting started${RESET}"
  echo "==============="
  echo ""
  echo -e "  ${BOLD}1. Configure your model & API key${RESET}"
  echo -e "     PilotDeck ships with a placeholder config, so your first stop is onboarding."
  echo -e "     Open ${GREEN}${ui_url}${RESET} — it redirects to the onboarding screen where you"
  echo -e "     choose a provider, paste an API key, and pick a model."
  echo -e "     ${DIM}Supported: OpenAI, Anthropic, Google Gemini, DeepSeek, Qwen, Kimi, MiniMax,${RESET}"
  echo -e "     ${DIM}and any OpenAI-compatible endpoint.${RESET}"
  echo ""
  echo -e "  ${BOLD}2. Prefer editing the config by hand?${RESET}"
  echo -e "     Edit ${DIM}${CONFIG_FILE}${RESET} and set your provider url + apiKey, e.g.:"
  echo ""
  echo -e "       ${DIM}agent:${RESET}"
  echo -e "       ${DIM}  model: deepseek/deepseek-v4-pro${RESET}"
  echo -e "       ${DIM}model:${RESET}"
  echo -e "       ${DIM}  providers:${RESET}"
  echo -e "       ${DIM}    deepseek:${RESET}"
  echo -e "       ${DIM}      protocol: openai${RESET}"
  echo -e "       ${DIM}      url: https://api.deepseek.com/v1${RESET}"
  echo -e "       ${DIM}      apiKey: sk-your-api-key${RESET}"
  echo ""
  echo -e "  ${BOLD}3. Manage PilotDeck from the CLI${RESET}"
  echo -e "     ${GREEN}pilotdeck${RESET}         start the server"
  echo -e "     ${GREEN}pilotdeck status${RESET}  show install path, config, and URL"
  echo -e "     ${GREEN}pilotdeck help${RESET}    list all commands"
  echo ""
  echo -e "  ${BOLD}Docs & community${RESET}"
  echo -e "     Tutorial:  ${DIM}https://pilotdeck.openbmb.cn/pilotdeck.github.io/docs/en/introduction${RESET}"
  echo -e "     Website:   ${DIM}https://pilotdeck.openbmb.cn${RESET}"
  echo -e "     Issues:    ${DIM}https://github.com/OpenBMB/PilotDeck/issues${RESET}"
  echo ""
}

print_getting_started_zh() {
  local ui_url="$1"
  echo ""
  echo -e "${BOLD}快速上手${RESET}"
  echo "========"
  echo ""
  echo -e "  ${BOLD}1. 配置模型与 API Key${RESET}"
  echo -e "     PilotDeck 初始使用占位配置,因此第一步是完成引导配置。"
  echo -e "     打开 ${GREEN}${ui_url}${RESET} — 页面会自动跳转到引导界面,"
  echo -e "     在这里选择服务商、粘贴 API Key 并选择模型。"
  echo -e "     ${DIM}已支持:OpenAI、Anthropic、Google Gemini、DeepSeek、Qwen、Kimi、MiniMax,${RESET}"
  echo -e "     ${DIM}以及任意兼容 OpenAI 协议的接口。${RESET}"
  echo ""
  echo -e "  ${BOLD}2. 更喜欢手动改配置?${RESET}"
  echo -e "     编辑 ${DIM}${CONFIG_FILE}${RESET},填入服务商的 url 和 apiKey,例如:"
  echo ""
  echo -e "       ${DIM}agent:${RESET}"
  echo -e "       ${DIM}  model: deepseek/deepseek-v4-pro${RESET}"
  echo -e "       ${DIM}model:${RESET}"
  echo -e "       ${DIM}  providers:${RESET}"
  echo -e "       ${DIM}    deepseek:${RESET}"
  echo -e "       ${DIM}      protocol: openai${RESET}"
  echo -e "       ${DIM}      url: https://api.deepseek.com/v1${RESET}"
  echo -e "       ${DIM}      apiKey: sk-your-api-key${RESET}"
  echo ""
  echo -e "  ${BOLD}3. 通过命令行管理 PilotDeck${RESET}"
  echo -e "     ${GREEN}pilotdeck${RESET}         启动服务"
  echo -e "     ${GREEN}pilotdeck status${RESET}  查看安装路径、配置和访问地址"
  echo -e "     ${GREEN}pilotdeck help${RESET}    查看全部命令"
  echo ""
  echo -e "  ${BOLD}文档与社区${RESET}"
  echo -e "     教程:  ${DIM}https://pilotdeck.openbmb.cn/pilotdeck.github.io/docs/en/introduction${RESET}"
  echo -e "     官网:  ${DIM}https://pilotdeck.openbmb.cn${RESET}"
  echo -e "     反馈:  ${DIM}https://github.com/OpenBMB/PilotDeck/issues${RESET}"
  echo ""
}

# Sentinel written by scripts/bootstrap-pilotdeck-config.mjs for an unconfigured install.
ONBOARD_SENTINEL="PLACEHOLDER_RUN_ONBOARDING_TO_REPLACE"

# True when the config already holds a real provider/model (not the placeholder).
config_is_configured() {
  [[ -f "$CONFIG_FILE" ]] || return 1
  if grep -q "$ONBOARD_SENTINEL" "$CONFIG_FILE" 2>/dev/null; then return 1; fi
  if grep -q "_placeholder/_placeholder" "$CONFIG_FILE" 2>/dev/null; then return 1; fi
  return 0
}

# Write a minimal, valid pilotdeck.yaml from the collected provider details.
write_pilotdeck_config() {
  local pid="$1" protocol="$2" url="$3" api_key="$4" model="$5"
  mkdir -p "$(dirname "$CONFIG_FILE")"
  if [[ -f "$CONFIG_FILE" ]]; then
    cp "$CONFIG_FILE" "${CONFIG_FILE}.bak.$(date +%Y%m%d-%H%M%S)" 2>/dev/null || true
  fi
  cat > "$CONFIG_FILE" <<YAML
schemaVersion: 1
agent:
  model: ${pid}/${model}
model:
  providers:
    ${pid}:
      protocol: ${protocol}
      url: ${url}
      apiKey: ${api_key}
      models:
        ${model}:
          capabilities:
            maxOutputTokens: 16384
adapters:
  feishu:
    enabled: false
    appId: ""
    appSecret: ""
cron:
  enabled: true
  timezone: Asia/Shanghai
  maxConcurrentRuns: 2
  runTimeoutMinutes: 60
YAML
}

# Interactive terminal setup wizard: pick a provider, enter an API key, choose a
# model, and write the config. Skips cleanly when non-interactive, already
# configured, or PILOTDECK_SKIP_ONBOARDING=1.
run_onboarding() {
  if [[ "${PILOTDECK_SKIP_ONBOARDING:-0}" == "1" ]]; then
    return
  fi
  if config_is_configured; then
    ok "$(L "Existing model configuration detected; skipping setup wizard." "检测到已有模型配置,跳过配置向导。")"
    return
  fi
  if ! { exec 3</dev/tty; } 2>/dev/null; then
    warn "$(L "No interactive terminal; skipping setup wizard. Configure via the Web UI." "非交互式终端,跳过配置向导。可在 Web UI 中完成配置。")"
    return
  fi

  echo ""
  echo -e "${BOLD}$(L "Model setup" "模型配置")${RESET}"
  echo "$(L "Configure a provider and API key now, or skip and use the Web UI later." "现在就配置服务商和 API Key,或先跳过、稍后用 Web UI 配置。")"
  printf "%s [Y/n] " "$(L "Configure now?" "现在配置?")"
  local yn=""; read -r yn <&3 || yn=""
  case "$yn" in
    n|N|no|NO|No)
      exec 3<&-
      warn "$(L "Skipped. Open the Web UI to finish onboarding." "已跳过。请打开 Web UI 完成配置。")"
      return
      ;;
  esac

  echo ""
  echo "$(L "Choose a provider:" "请选择服务商:")"
  echo "  1) OpenAI"
  echo "  2) Anthropic (Claude)"
  echo "  3) Google Gemini"
  echo "  4) DeepSeek"
  echo "  5) $(L "Qwen (Alibaba DashScope)" "通义千问(阿里云百炼)")"
  echo "  6) $(L "Kimi (Moonshot)" "Kimi(月之暗面)")"
  echo "  7) MiniMax"
  echo "  8) $(L "Zhipu GLM" "智谱 GLM")"
  echo "  9) $(L "Custom OpenAI-compatible endpoint" "自定义 OpenAI 兼容接口")"
  printf "> "
  local choice=""; read -r choice <&3 || choice=""

  local pid="" protocol="" url="" model=""
  case "$choice" in
    1) pid=openai;    protocol=openai;    url=https://api.openai.com/v1;                          model=gpt-4o ;;
    2) pid=anthropic; protocol=anthropic; url=https://api.anthropic.com;                          model=claude-sonnet-4.6 ;;
    3) pid=google;    protocol=google;    url=https://generativelanguage.googleapis.com;          model=gemini-2.5-pro ;;
    4) pid=deepseek;  protocol=openai;    url=https://api.deepseek.com/v1;                         model=deepseek-chat ;;
    5) pid=dashscope; protocol=openai;    url=https://dashscope.aliyuncs.com/compatible-mode/v1;   model=qwen-max ;;
    6) pid=moonshot;  protocol=openai;    url=https://api.moonshot.cn/v1;                          model=kimi-k2 ;;
    7) pid=minimax;   protocol=openai;    url=https://api.minimaxi.com/v1;                         model=MiniMax-M2.5 ;;
    8) pid=zhipu;     protocol=openai;    url=https://api.z.ai/api/paas/v4;                        model=glm-4.6 ;;
    9)
      protocol=openai
      printf "%s " "$(L "Provider id (e.g. myprovider):" "服务商 id(如 myprovider):")"
      read -r pid <&3 || pid=""
      [[ -n "$pid" ]] || pid=custom
      printf "%s " "$(L "Base URL (OpenAI-compatible):" "接口地址(OpenAI 兼容):")"
      read -r url <&3 || url=""
      ;;
    *)
      exec 3<&-
      warn "$(L "Invalid choice; skipping setup." "无效选项,已跳过配置。")"
      return
      ;;
  esac

  if [[ -n "$model" ]]; then
    printf "%s [%s] " "$(L "Model" "模型")" "$model"
    local model_in=""; read -r model_in <&3 || model_in=""
    model="${model_in:-$model}"
  else
    printf "%s " "$(L "Model name:" "模型名称:")"
    read -r model <&3 || model=""
  fi

  printf "%s " "$(L "API key:" "API Key:")"
  local api_key=""; read -rs api_key <&3 || api_key=""
  echo ""

  exec 3<&-

  if [[ -z "$api_key" || -z "$url" || -z "$model" ]]; then
    warn "$(L "Missing a required value; skipping. Configure later in the Web UI." "缺少必填项,已跳过。可稍后在 Web UI 中配置。")"
    return
  fi

  write_pilotdeck_config "$pid" "$protocol" "$url" "$api_key" "$model"
  ok "$(L "Saved config for ${pid}/${model} to" "已保存 ${pid}/${model} 的配置到") ${DIM}${CONFIG_FILE}${RESET}"
}

version_at_least() {
  local version="${1#v}"
  local minimum="${2#v}"
  local v_major v_minor v_patch min_major min_minor min_patch
  IFS=. read -r v_major v_minor v_patch _ <<< "$version"
  IFS=. read -r min_major min_minor min_patch _ <<< "$minimum"
  v_major="${v_major:-0}"
  v_minor="${v_minor:-0}"
  v_patch="${v_patch:-0}"
  min_major="${min_major:-0}"
  min_minor="${min_minor:-0}"
  min_patch="${min_patch:-0}"
  v_patch="${v_patch%%[^0-9]*}"
  min_patch="${min_patch%%[^0-9]*}"

  if (( v_major > min_major )); then return 0; fi
  if (( v_major < min_major )); then return 1; fi
  if (( v_minor > min_minor )); then return 0; fi
  if (( v_minor < min_minor )); then return 1; fi
  (( v_patch >= min_patch ))
}

node_supports_sqlite() {
  node -e "import('node:sqlite').then(() => {}, () => process.exit(1))" >/dev/null 2>&1
}

install_node_runtime() {
  if command -v fnm >/dev/null 2>&1; then
    fnm install "$NODE_INSTALL_VERSION" </dev/null
    fnm use "$NODE_INSTALL_VERSION"
  elif command -v nvm >/dev/null 2>&1; then
    nvm install "$NODE_INSTALL_VERSION" </dev/null
    nvm use "$NODE_INSTALL_VERSION"
  else
    warn "$(L "Installing fnm (Fast Node Manager)..." "正在安装 fnm(Fast Node Manager)...")"
    curl -fsSL https://fnm.vercel.app/install | bash
    export PATH="$HOME/.local/share/fnm:$PATH"
    eval "$(fnm env)"
    fnm install "$NODE_INSTALL_VERSION" </dev/null
    fnm use "$NODE_INSTALL_VERSION"
  fi
}

ensure_node_runtime() {
  local node_version

  if command -v node >/dev/null 2>&1; then
    node_version="$(node --version)"
    if version_at_least "$node_version" "$MIN_NODE_VERSION" && node_supports_sqlite; then
      ok "$(L "Node.js ${node_version} found" "已找到 Node.js ${node_version}")"
      return
    fi
    warn "$(L "Node.js ${node_version} is too old or lacks node:sqlite (need >=${MIN_NODE_VERSION}). Installing Node.js ${NODE_INSTALL_VERSION}..." "Node.js ${node_version} 版本过低或缺少 node:sqlite(需要 >=${MIN_NODE_VERSION})。正在安装 Node.js ${NODE_INSTALL_VERSION}...")"
  else
    warn "$(L "Node.js not found. Installing via fnm..." "未找到 Node.js,正在通过 fnm 安装...")"
  fi

  install_node_runtime
  node_version="$(node --version 2>/dev/null || true)"
  if [[ -z "$node_version" ]] || ! version_at_least "$node_version" "$MIN_NODE_VERSION" || ! node_supports_sqlite; then
    fail "$(L "Node.js >=${MIN_NODE_VERSION} with node:sqlite is required. Current: ${node_version:-not found}." "需要带 node:sqlite 的 Node.js >=${MIN_NODE_VERSION}。当前:${node_version:-未找到}。")"
  fi
  ok "$(L "Node.js ${node_version} installed" "已安装 Node.js ${node_version}")"
}

# Portable timeout: use GNU timeout if available, else fall back to a bg+kill approach.
# Returns 124 on timeout (same convention as GNU timeout).
run_with_timeout() {
  local secs="$1"; shift
  if command -v timeout >/dev/null 2>&1; then
    timeout "$secs" "$@"
  else
    "$@" &
    local pid=$!
    ( sleep "$secs" && kill "$pid" 2>/dev/null ) &
    local watchdog=$!
    if wait "$pid" 2>/dev/null; then
      kill "$watchdog" 2>/dev/null; wait "$watchdog" 2>/dev/null
      return 0
    else
      local rc=$?
      kill "$watchdog" 2>/dev/null; wait "$watchdog" 2>/dev/null
      # 143 = SIGTERM (128+15), treat as timeout
      if [[ $rc -eq 143 ]]; then return 124; fi
      return $rc
    fi
  fi
}

run_as_root() {
  if [[ "${EUID:-$(id -u)}" -eq 0 ]]; then
    "$@"
  elif command -v sudo >/dev/null 2>&1; then
    sudo "$@"
  else
    fail "$(L "Need root privileges to install system packages. Please install sudo or run as root." "安装系统软件包需要 root 权限。请安装 sudo 或以 root 身份运行。")"
  fi
}

install_linux_packages() {
  local requested=("$@")
  local apt_packages=()
  local dnf_packages=()
  local pacman_packages=()
  local zypper_packages=()
  local package

  for package in "${requested[@]}"; do
    case "$package" in
      build-tools)
        apt_packages+=(build-essential python3)
        dnf_packages+=(gcc gcc-c++ make python3)
        pacman_packages+=(base-devel python)
        zypper_packages+=(gcc gcc-c++ make python3)
        ;;
      *)
        apt_packages+=("$package")
        dnf_packages+=("$package")
        pacman_packages+=("$package")
        zypper_packages+=("$package")
        ;;
    esac
  done

  if command -v apt-get >/dev/null 2>&1; then
    if [[ "$APT_UPDATED" -eq 0 ]]; then
      run_as_root apt-get update
      APT_UPDATED=1
    fi
    run_as_root apt-get install -y "${apt_packages[@]}"
  elif command -v dnf >/dev/null 2>&1; then
    run_as_root dnf install -y "${dnf_packages[@]}"
  elif command -v yum >/dev/null 2>&1; then
    run_as_root yum install -y "${dnf_packages[@]}"
  elif command -v pacman >/dev/null 2>&1; then
    run_as_root pacman -Sy --needed --noconfirm "${pacman_packages[@]}"
  elif command -v zypper >/dev/null 2>&1; then
    run_as_root zypper --non-interactive install "${zypper_packages[@]}"
  else
    fail "$(L "Unsupported Linux package manager. Please install manually: ${requested[*]}" "不支持的 Linux 包管理器。请手动安装:${requested[*]}")"
  fi
}

install_git() {
  if [[ "$PLATFORM" == "linux" ]]; then
    install_linux_packages git
  else
    fail "$(L "git is not installed. Please install Xcode Command Line Tools: xcode-select --install" "未安装 git。请先安装 Xcode 命令行工具:xcode-select --install")"
  fi
}

install_ripgrep() {
  if [[ "$PLATFORM" == "macos" ]] && command -v brew >/dev/null 2>&1; then
    brew install ripgrep </dev/null
  elif [[ "$PLATFORM" == "linux" ]]; then
    install_linux_packages ripgrep
  else
    fail "$(L "ripgrep (rg) is required. On macOS, install Homebrew and run: brew install ripgrep" "需要 ripgrep(rg)。在 macOS 上请安装 Homebrew 后运行:brew install ripgrep")"
  fi
}

install_git_lfs() {
  if [[ "$PLATFORM" == "macos" ]] && command -v brew >/dev/null 2>&1; then
    brew install git-lfs </dev/null
  elif [[ "$PLATFORM" == "linux" ]]; then
    install_linux_packages git-lfs
  else
    fail "$(L "git-lfs is required for PilotDeck assets. On macOS, install Homebrew and run: brew install git-lfs" "PilotDeck 素材需要 git-lfs。在 macOS 上请安装 Homebrew 后运行:brew install git-lfs")"
  fi
}

install_lsof() {
  if [[ "$PLATFORM" == "linux" ]]; then
    install_linux_packages lsof
  else
    fail "$(L "lsof is required but missing. Please install Xcode Command Line Tools: xcode-select --install" "缺少必需的 lsof。请先安装 Xcode 命令行工具:xcode-select --install")"
  fi
}

has_cxx_compiler() {
  command -v g++ >/dev/null 2>&1 || command -v c++ >/dev/null 2>&1 || command -v clang++ >/dev/null 2>&1
}

ensure_native_build_tools() {
  if command -v python3 >/dev/null 2>&1 && command -v make >/dev/null 2>&1 && has_cxx_compiler; then
    ok "$(L "native build tools found" "已找到原生编译工具")"
    return
  fi

  if [[ "$PLATFORM" == "linux" ]]; then
    warn "$(L "native build tools not found. Installing build tools for node-pty/better-sqlite3..." "未找到原生编译工具。正在为 node-pty/better-sqlite3 安装编译工具...")"
    install_linux_packages build-tools
    ok "$(L "native build tools installed" "已安装原生编译工具")"
  else
    fail "$(L "native build tools are missing. Please install Xcode Command Line Tools: xcode-select --install" "缺少原生编译工具。请先安装 Xcode 命令行工具:xcode-select --install")"
  fi
}

is_port_free() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    ! lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
  elif command -v ss >/dev/null 2>&1; then
    ! ss -tlnH "sport = :$port" 2>/dev/null | grep -q .
  else
    ! (echo >/dev/tcp/127.0.0.1/"$port") 2>/dev/null
  fi
}

find_free_port() {
  local base="$1"
  local offset candidate
  for ((offset = 0; offset < MAX_PORT_TRIES; offset++)); do
    candidate=$((base + offset))
    if is_port_free "$candidate"; then
      printf "%s" "$candidate"
      return 0
    fi
  done
  return 1
}

resolve_runtime_ports() {
  local server_base="${SERVER_PORT:-3001}"
  local gateway_base="${PILOTDECK_GATEWAY_PORT:-18789}"

  SERVER_PORT="$(find_free_port "$server_base")" || \
    fail "$(L "Could not find a free UI port within ${MAX_PORT_TRIES} ports from ${server_base}." "从 ${server_base} 起 ${MAX_PORT_TRIES} 个端口内未找到空闲的 UI 端口。")"
  PILOTDECK_GATEWAY_PORT="$(find_free_port "$gateway_base")" || \
    fail "$(L "Could not find a free gateway port within ${MAX_PORT_TRIES} ports from ${gateway_base}." "从 ${gateway_base} 起 ${MAX_PORT_TRIES} 个端口内未找到空闲的网关端口。")"
  PILOTDECK_GATEWAY_URL="ws://127.0.0.1:${PILOTDECK_GATEWAY_PORT}/ws"

  export SERVER_PORT PILOTDECK_GATEWAY_PORT PILOTDECK_GATEWAY_URL

  if [[ "$SERVER_PORT" != "$server_base" ]]; then
    warn "$(L "UI port ${server_base} is busy; using ${SERVER_PORT} instead." "UI 端口 ${server_base} 被占用,改用 ${SERVER_PORT}。")"
  fi
  if [[ "$PILOTDECK_GATEWAY_PORT" != "$gateway_base" ]]; then
    warn "$(L "Gateway port ${gateway_base} is busy; using ${PILOTDECK_GATEWAY_PORT} instead." "网关端口 ${gateway_base} 被占用,改用 ${PILOTDECK_GATEWAY_PORT}。")"
  fi
}

github_repo_slug() {
  case "$REPO_URL" in
    https://github.com/*.git)
      local slug="${REPO_URL#https://github.com/}"
      printf "%s" "${slug%.git}"
      ;;
    git@github.com:*.git)
      local slug="${REPO_URL#git@github.com:}"
      printf "%s" "${slug%.git}"
      ;;
    *)
      return 1
      ;;
  esac
}

normalize_github_remote() {
  local url="$1"
  case "$url" in
    https://github.com/*)
      local slug="${url#https://github.com/}"
      slug="${slug%.git}"
      printf "%s" "$slug"
      ;;
    git@github.com:*)
      local slug="${url#git@github.com:}"
      slug="${slug%.git}"
      printf "%s" "$slug"
      ;;
    ssh://git@github.com/*)
      local slug="${url#ssh://git@github.com/}"
      slug="${slug%.git}"
      printf "%s" "$slug"
      ;;
    *)
      printf "%s" "$url"
      ;;
  esac
}

clone_without_lfs_smudge() {
  if [[ "${PILOTDECK_INSTALL_LFS:-0}" == "1" ]]; then
    "$@"
  else
    GIT_LFS_SKIP_SMUDGE=1 "$@"
  fi
}

clone_repo() {
  local slug
  if slug="$(github_repo_slug)" && command -v gh >/dev/null 2>&1 && gh auth status >/dev/null 2>&1; then
    clone_without_lfs_smudge gh repo clone "$slug" "$INSTALL_DIR" -- --branch "$BRANCH" --depth 1 || \
      fail "$(L "Could not clone ${REPO_URL}. Check repository access and network connectivity." "无法克隆 ${REPO_URL}。请检查仓库访问权限和网络连接。")"
  else
    clone_without_lfs_smudge git clone --branch "$BRANCH" --depth 1 "$REPO_URL" "$INSTALL_DIR" || \
      fail "$(L "Could not clone ${REPO_URL}. If this repository is private, authenticate with GitHub first." "无法克隆 ${REPO_URL}。若为私有仓库,请先完成 GitHub 认证。")"
  fi
}

repo_remote_url() {
  git -C "$1" remote get-url origin 2>/dev/null || true
}

repo_has_changes() {
  [[ -n "$(git -C "$1" status --porcelain 2>/dev/null)" ]]
}

backup_existing_installation() {
  local source_dir="$1"
  local backup_dir timestamp
  timestamp="$(date +%Y%m%d-%H%M%S)"
  backup_dir="${source_dir}.backup.${timestamp}"
  while [[ -e "$backup_dir" ]]; do
    timestamp="$(date +%Y%m%d-%H%M%S)-$RANDOM"
    backup_dir="${source_dir}.backup.${timestamp}"
  done
  mv "$source_dir" "$backup_dir"
  warn "$(L "Existing installation moved to ${backup_dir}" "已将现有安装移动到 ${backup_dir}")"
}

checkout_existing_installation() {
  cd "$INSTALL_DIR"
  local before after
  before="$(git rev-parse HEAD 2>/dev/null || echo none)"

  # Fetch from the configured (HTTPS) URL rather than the existing "origin"
  # remote, which may be an SSH URL (git@github.com) that hangs when port 22
  # is blocked. Cap the fetch so a dead network can't stall the installer.
  if run_with_timeout "${PILOTDECK_FETCH_TIMEOUT:-45}" env GIT_LFS_SKIP_SMUDGE=1 git fetch "$REPO_URL" "$BRANCH"; then
    GIT_LFS_SKIP_SMUDGE=1 git checkout -B "$BRANCH" FETCH_HEAD || return 1
  else
    warn "$(L "Could not fetch updates (network/SSH issue); keeping the current checkout." "无法拉取更新(网络/SSH 问题),沿用当前已安装的代码。")"
  fi

  after="$(git rev-parse HEAD 2>/dev/null || echo none)"
  if [[ "$before" == "$after" ]]; then
    REPO_CHANGED=0
  else
    REPO_CHANGED=1
  fi
  return 0
}

install_or_update_repo() {
  mkdir -p "$(dirname "$INSTALL_DIR")"

  if [[ -d "$INSTALL_DIR/.git" ]]; then
    local current_remote current_remote_normalized expected_remote_normalized
    current_remote="$(repo_remote_url "$INSTALL_DIR")"
    current_remote_normalized="$(normalize_github_remote "$current_remote")"
    expected_remote_normalized="$(normalize_github_remote "$REPO_URL")"
    if [[ "$current_remote_normalized" != "$expected_remote_normalized" ]]; then
      warn "$(L "Existing installation uses ${current_remote:-unknown remote}; expected ${REPO_URL}." "现有安装使用的是 ${current_remote:-未知远程};预期为 ${REPO_URL}。")"
      backup_existing_installation "$INSTALL_DIR"
      clone_repo
      ok "$(L "Repository cloned" "仓库已克隆")"
      return
    fi

    if repo_has_changes "$INSTALL_DIR"; then
      warn "$(L "Existing installation has local changes; preserving it before reinstalling." "现有安装存在本地改动;重新安装前先予以保留。")"
      backup_existing_installation "$INSTALL_DIR"
      clone_repo
      ok "$(L "Repository cloned" "仓库已克隆")"
      return
    fi

    warn "$(L "Existing installation found. Updating..." "检测到现有安装,正在更新...")"
    if checkout_existing_installation; then
      ok "$(L "Updated to latest ${BRANCH}" "已更新到最新的 ${BRANCH}")"
    else
      warn "$(L "Fast update failed; preserving existing checkout before reinstalling." "快速更新失败;重新安装前先保留现有代码。")"
      cd "$(dirname "$INSTALL_DIR")"
      backup_existing_installation "$INSTALL_DIR"
      clone_repo
      ok "$(L "Repository cloned" "仓库已克隆")"
    fi
    return
  fi

  if [[ -d "$INSTALL_DIR" ]]; then
    warn "$(L "Cleaning incomplete installation at $INSTALL_DIR" "正在清理位于 $INSTALL_DIR 的不完整安装")"
    rm -rf "$INSTALL_DIR"
  fi
  clone_repo
  ok "$(L "Repository cloned" "仓库已克隆")"
}

ensure_lfs_assets() {
  if [[ "${PILOTDECK_INSTALL_LFS:-0}" != "1" ]]; then
    warn "$(L "Skipping Git LFS media download. Set PILOTDECK_INSTALL_LFS=1 to fetch demo images/videos." "跳过 Git LFS 媒体下载。设置 PILOTDECK_INSTALL_LFS=1 可下载演示图片/视频。")"
    return
  fi

  if [[ "${GIT_LFS_SKIP_SMUDGE:-}" == "1" ]]; then
    warn "$(L "GIT_LFS_SKIP_SMUDGE=1 is set; large media assets were intentionally skipped." "已设置 GIT_LFS_SKIP_SMUDGE=1;大型媒体素材已被有意跳过。")"
    return
  fi

  if ! command -v git-lfs >/dev/null 2>&1 && ! git lfs version >/dev/null 2>&1; then
    fail "$(L "git-lfs command not found after installation." "安装后仍未找到 git-lfs 命令。")"
  fi

  cd "$INSTALL_DIR"
  git lfs install --local >/dev/null
  git lfs pull

  local pointer_file=""
  for pointer_file in assets/banner.png ui/public/favicon.png ui/src/assets/pilotdeck-logo.png; do
    if [[ -f "$pointer_file" ]] && grep -q "version https://git-lfs.github.com/spec/v1" "$pointer_file"; then
      fail "$(L "Git LFS asset was not downloaded correctly: ${pointer_file}" "Git LFS 素材未正确下载:${pointer_file}")"
    fi
  done
  ok "$(L "Git LFS assets downloaded" "Git LFS 素材已下载")"
}

# Skip the (slow) npm install + frontend build when nothing changed: repo HEAD
# unchanged and all build artifacts already present. Force with PILOTDECK_FORCE_DEPS=1.
deps_up_to_date() {
  [[ "${PILOTDECK_FORCE_DEPS:-0}" != "1" ]] || return 1
  [[ "${REPO_CHANGED:-1}" == "0" ]] || return 1
  [[ -d "$INSTALL_DIR/node_modules" ]] || return 1
  [[ -f "$INSTALL_DIR/dist/src/cli/pilotdeck.js" ]] || return 1
  [[ -f "$INSTALL_DIR/src/context/memory/edgeclaw-memory-core/lib/index.js" ]] || return 1
  [[ -d "$INSTALL_DIR/ui/node_modules" ]] || return 1
  [[ -d "$INSTALL_DIR/ui/dist" ]] || return 1
  return 0
}

has_playwright_chrome_for_testing() {
  local candidate
  for candidate in \
    "$HOME/Library/Caches/ms-playwright"/mcp-chrome-for-testing-* \
    "$HOME/.cache/ms-playwright"/mcp-chrome-for-testing-*; do
    if [[ -d "$candidate" ]]; then
      return 0
    fi
  done
  return 1
}

echo ""
echo -e "${BOLD}PilotDeck Installer${RESET}"
echo "====================="

select_language

# Dry run for testing the "back half" (language + onboarding wizard + guide)
# without cloning, installing deps, building, or starting the server.
#   PILOTDECK_DRY_RUN=1 PILOTDECK_CONFIG_PATH=/tmp/pd.yaml bash install.sh
if [[ "${PILOTDECK_DRY_RUN:-0}" == "1" ]]; then
  echo ""
  warn "$(L "Dry run: skipping install; testing onboarding + guide only." "试运行:跳过安装,仅测试配置向导与引导。")"
  run_onboarding
  print_getting_started "http://localhost:${SERVER_PORT:-3001}"
  exit 0
fi

echo ""
echo "$(L "Checking system requirements..." "正在检查系统环境...")"
case "$(uname -s)" in
  Darwin)
    PLATFORM="macos"
    ok "$(L "macOS detected" "检测到 macOS")"
    ;;
  Linux)
    PLATFORM="linux"
    ok "$(L "Linux detected" "检测到 Linux")"
    ;;
  *)
    fail "$(L "Unsupported OS: $(uname -s). This installer supports macOS and Linux." "不支持的操作系统:$(uname -s)。该安装器仅支持 macOS 和 Linux。")"
    ;;
esac
echo ""

echo "$(L "Checking Node.js..." "正在检查 Node.js...")"
ensure_node_runtime
echo ""

echo "$(L "Checking git..." "正在检查 git...")"
if ! command -v git >/dev/null 2>&1; then
  warn "$(L "git not found. Installing..." "未找到 git,正在安装...")"
  install_git
fi
ok "$(L "git found" "已找到 git")"
echo ""

if [[ "${PILOTDECK_INSTALL_LFS:-0}" == "1" ]]; then
  echo "$(L "Checking Git LFS..." "正在检查 Git LFS...")"
  if [[ "${GIT_LFS_SKIP_SMUDGE:-}" == "1" ]]; then
    warn "$(L "GIT_LFS_SKIP_SMUDGE=1 is set; large media assets will be skipped." "已设置 GIT_LFS_SKIP_SMUDGE=1;将跳过大型媒体素材。")"
  elif command -v git-lfs >/dev/null 2>&1 || git lfs version >/dev/null 2>&1; then
    ok "$(L "Git LFS $(git lfs version | awk '{print $1}') found" "已找到 Git LFS $(git lfs version | awk '{print $1}')")"
  else
    warn "$(L "Git LFS not found. Installing..." "未找到 Git LFS,正在安装...")"
    install_git_lfs
    ok "$(L "Git LFS installed" "已安装 Git LFS")"
  fi
  echo ""
fi

echo "$(L "Checking ripgrep..." "正在检查 ripgrep...")"
if command -v rg >/dev/null 2>&1; then
  ok "$(L "ripgrep $(rg --version | head -1) found" "已找到 ripgrep $(rg --version | head -1)")"
else
  warn "$(L "ripgrep not found. Installing..." "未找到 ripgrep,正在安装...")"
  install_ripgrep
  ok "$(L "ripgrep installed" "已安装 ripgrep")"
fi
echo ""

echo "$(L "Checking lsof..." "正在检查 lsof...")"
if ! command -v lsof >/dev/null 2>&1; then
  warn "$(L "lsof not found. Installing..." "未找到 lsof,正在安装...")"
  install_lsof
fi
ok "$(L "lsof found" "已找到 lsof")"
echo ""

echo "$(L "Checking native build tools..." "正在检查原生编译工具...")"
ensure_native_build_tools
echo ""

echo -e "$(L "Installing PilotDeck to" "正在安装 PilotDeck 到") ${DIM}${INSTALL_DIR}${RESET} ..."
install_or_update_repo
ensure_lfs_assets
echo ""

if deps_up_to_date; then
  ok "$(L "Dependencies and frontend already up to date; skipping install & build." "依赖与前端已是最新,跳过安装与构建。")"
  warn "$(L "Set PILOTDECK_FORCE_DEPS=1 to force a full reinstall & rebuild." "如需强制重装并重新构建,请设置 PILOTDECK_FORCE_DEPS=1。")"
  echo ""
else
  echo "$(L "Installing root dependencies..." "正在安装根依赖...")"
  echo -e "  ${DIM}$(L "This can take several minutes — native modules (node-pty, better-sqlite3) compile from source and npm output is quiet." "这一步可能需要数分钟 —— 原生模块(node-pty、better-sqlite3)需从源码编译,且 npm 输出为静默模式。")${RESET}"
  cd "$INSTALL_DIR"
  HUSKY=0 npm install --no-audit --no-fund --loglevel=error </dev/null
  ok "$(L "Root dependencies installed" "根依赖已安装")"
  warn "$(L "Keeping root dev dependencies because runtime uses tsx from source." "保留根 dev 依赖,因为运行时需从源码使用 tsx。")"
  echo ""

  echo "$(L "Installing UI dependencies & building frontend..." "正在安装 UI 依赖并构建前端...")"
  cd "$INSTALL_DIR/ui"
  HUSKY=0 npm install --no-audit --no-fund --loglevel=error </dev/null
  ok "$(L "UI dependencies installed" "UI 依赖已安装")"
  npm run build
  ok "$(L "Frontend built" "前端已构建")"
  warn "$(L "Keeping UI dev dependencies because production start uses concurrently/vite build tooling." "保留 UI dev 依赖,因为生产启动会用到 concurrently/vite 构建工具。")"
  echo ""
fi

echo "$(L "Checking Playwright browser for browser-use plugin..." "正在检查 browser-use 插件所需的 Playwright 浏览器...")"
cd "$INSTALL_DIR"
BROWSER_INSTALL_TIMEOUT="${PILOTDECK_BROWSER_INSTALL_TIMEOUT:-300}"
if has_playwright_chrome_for_testing; then
  ok "$(L "Chrome for Testing already installed" "Chrome for Testing 已安装")"
elif [[ "${PILOTDECK_SKIP_BROWSER_INSTALL:-1}" == "1" ]]; then
  warn "$(L "Skipping Chrome for Testing download (default) to keep install fast." "默认跳过 Chrome for Testing 下载,以加快安装速度。")"
  warn "$(L "To enable browser-use, run: cd \"$INSTALL_DIR\" && npm run install:browser" "如需启用 browser-use,请运行:cd \"$INSTALL_DIR\" && npm run install:browser")"
  warn "$(L "Or re-run the installer with PILOTDECK_SKIP_BROWSER_INSTALL=0." "或以 PILOTDECK_SKIP_BROWSER_INSTALL=0 重新运行安装器。")"
else
  echo "  $(L "Downloading and extracting Chrome for Testing (timeout: ${BROWSER_INSTALL_TIMEOUT}s)..." "正在下载并解压 Chrome for Testing(超时:${BROWSER_INSTALL_TIMEOUT}s)...")"
  echo "  $(L "This may take a few minutes — the extraction step can appear to stall." "这可能需要几分钟 —— 解压阶段看起来可能像卡住。")"
  if run_with_timeout "${BROWSER_INSTALL_TIMEOUT}" npx @playwright/mcp install-browser chrome-for-testing </dev/null; then
    ok "$(L "Chrome for Testing installed" "Chrome for Testing 已安装")"
  else
    exit_code=$?
    if [[ $exit_code -eq 124 ]]; then
      warn "$(L "Chrome for Testing install timed out after ${BROWSER_INSTALL_TIMEOUT}s." "Chrome for Testing 安装在 ${BROWSER_INSTALL_TIMEOUT}s 后超时。")"
    else
      warn "$(L "Chrome for Testing install failed (exit code $exit_code)." "Chrome for Testing 安装失败(退出码 $exit_code)。")"
    fi
    warn "$(L "PilotDeck core features are still available." "PilotDeck 核心功能仍可正常使用。")"
    warn "$(L "To enable browser-use later, run: cd \"$INSTALL_DIR\" && npm run install:browser" "如需稍后启用 browser-use,请运行:cd \"$INSTALL_DIR\" && npm run install:browser")"
    warn "$(L "To increase timeout, set PILOTDECK_BROWSER_INSTALL_TIMEOUT=600 and re-run." "如需延长超时,请设置 PILOTDECK_BROWSER_INSTALL_TIMEOUT=600 后重新运行。")"
  fi
fi
echo ""

echo "$(L "Installing ClawHub CLI..." "正在安装 ClawHub CLI...")"
if command -v clawhub >/dev/null 2>&1; then
  ok "$(L "ClawHub CLI already installed ($(clawhub --version 2>/dev/null || echo 'unknown version'))" "ClawHub CLI 已安装($(clawhub --version 2>/dev/null || echo '未知版本'))")"
else
  npm install -g clawhub --loglevel=error </dev/null && \
    ok "$(L "ClawHub CLI installed" "ClawHub CLI 已安装")" || \
    warn "$(L "ClawHub CLI install failed (skill marketplace features may not work)" "ClawHub CLI 安装失败(技能市场功能可能不可用)")"
fi
echo ""

echo "$(L "Setting up CLI command..." "正在设置 CLI 命令...")"
WRAPPER_DIR="$INSTALL_DIR/bin"
CLI_TARGET="$WRAPPER_DIR/pilotdeck"
mkdir -p "$WRAPPER_DIR"
cat > "$CLI_TARGET" <<'EOF'
#!/usr/bin/env bash
set -euo pipefail

SOURCE="${BASH_SOURCE[0]}"
while [[ -L "$SOURCE" ]]; do
  SOURCE_DIR="$(cd "$(dirname "$SOURCE")" && pwd)"
  LINK_TARGET="$(readlink "$SOURCE")"
  if [[ "$LINK_TARGET" == /* ]]; then
    SOURCE="$LINK_TARGET"
  else
    SOURCE="$SOURCE_DIR/$LINK_TARGET"
  fi
done
INSTALL_DIR="$(cd "$(dirname "$SOURCE")/.." && pwd)"
CONFIG_FILE="${PILOTDECK_CONFIG_PATH:-$HOME/.pilotdeck/pilotdeck.yaml}"
MAX_PORT_TRIES="${PILOTDECK_MAX_PORT_TRIES:-20}"
MIN_NODE_VERSION="22.13.0"

fail() { printf "pilotdeck: %s\n" "$1" >&2; exit 1; }
warn() { printf "pilotdeck: %s\n" "$1" >&2; }

version_at_least() {
  local version="${1#v}"
  local minimum="${2#v}"
  local v_major v_minor v_patch min_major min_minor min_patch
  IFS=. read -r v_major v_minor v_patch _ <<< "$version"
  IFS=. read -r min_major min_minor min_patch _ <<< "$minimum"
  v_major="${v_major:-0}"
  v_minor="${v_minor:-0}"
  v_patch="${v_patch:-0}"
  min_major="${min_major:-0}"
  min_minor="${min_minor:-0}"
  min_patch="${min_patch:-0}"
  v_patch="${v_patch%%[^0-9]*}"
  min_patch="${min_patch%%[^0-9]*}"

  if (( v_major > min_major )); then return 0; fi
  if (( v_major < min_major )); then return 1; fi
  if (( v_minor > min_minor )); then return 0; fi
  if (( v_minor < min_minor )); then return 1; fi
  (( v_patch >= min_patch ))
}

ensure_node_runtime() {
  command -v node >/dev/null 2>&1 || fail "Node.js >=${MIN_NODE_VERSION} is required; re-run install.sh to install it."
  local node_version
  node_version="$(node --version)"
  if ! version_at_least "$node_version" "$MIN_NODE_VERSION"; then
    fail "Node.js >=${MIN_NODE_VERSION} is required because PilotDeck uses node:sqlite. Current: ${node_version}. Re-run install.sh or switch Node with fnm/nvm."
  fi
  if ! node -e "import('node:sqlite').then(() => {}, () => process.exit(1))" >/dev/null 2>&1; then
    fail "Current Node.js (${node_version}) does not provide node:sqlite. Re-run install.sh or switch to Node.js 22.13+."
  fi
}

is_port_free() {
  local port="$1"
  if command -v lsof >/dev/null 2>&1; then
    ! lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1
  elif command -v ss >/dev/null 2>&1; then
    ! ss -tlnH "sport = :$port" 2>/dev/null | grep -q .
  else
    ! (echo >/dev/tcp/127.0.0.1/"$port") 2>/dev/null
  fi
}

find_free_port() {
  local base="$1"
  local offset candidate
  for ((offset = 0; offset < MAX_PORT_TRIES; offset++)); do
    candidate=$((base + offset))
    if is_port_free "$candidate"; then
      printf "%s" "$candidate"
      return 0
    fi
  done
  return 1
}

git_remote_url() {
  git -C "$INSTALL_DIR" remote get-url origin 2>/dev/null || printf "unknown"
}

git_branch_name() {
  git -C "$INSTALL_DIR" branch --show-current 2>/dev/null || printf "unknown"
}

COMMAND="start"
while [[ $# -gt 0 ]]; do
  case "$1" in
    start)
      COMMAND="start"
      shift
      ;;
    status|info)
      COMMAND="status"
      shift
      ;;
    help|-h|--help)
      COMMAND="help"
      shift
      ;;
    --port|-p)
      [[ $# -ge 2 ]] || fail "--port requires a value"
      SERVER_PORT="$2"
      shift 2
      ;;
    --port=*)
      SERVER_PORT="${1#--port=}"
      shift
      ;;
    --config)
      [[ $# -ge 2 ]] || fail "--config requires a value"
      CONFIG_FILE="$2"
      shift 2
      ;;
    --config=*)
      CONFIG_FILE="${1#--config=}"
      shift
      ;;
    *)
      fail "unknown argument: $1"
      ;;
  esac
done

if [[ "$COMMAND" == "help" ]]; then
  cat <<HELP
pilotdeck - start the PilotDeck web UI

Usage:
  pilotdeck [start] [--port <port>] [--config <path>]
  pilotdeck status
  pilotdeck help

First run? Start PilotDeck, open the printed URL, and complete onboarding
(choose a provider, paste an API key, pick a model). You can also edit the
config directly at: ${CONFIG_FILE}

HELP
  exit 0
fi

if [[ "$COMMAND" == "status" ]]; then
  SERVER_BASE="${SERVER_PORT:-3001}"
  NEXT_SERVER_PORT="$(find_free_port "$SERVER_BASE" || printf "%s" "$SERVER_BASE")"
  printf "Installation: %s\n" "$INSTALL_DIR"
  printf "Remote:       %s\n" "$(git_remote_url)"
  printf "Branch:       %s\n" "$(git_branch_name)"
  printf "Config:       %s\n" "$CONFIG_FILE"
  printf "Default URL:  http://localhost:%s\n" "$SERVER_BASE"
  printf "Next start:   http://localhost:%s\n" "$NEXT_SERVER_PORT"
  exit 0
fi

ensure_node_runtime

SERVER_BASE="${SERVER_PORT:-3001}"
GATEWAY_BASE="${PILOTDECK_GATEWAY_PORT:-18789}"
SERVER_PORT="$(find_free_port "$SERVER_BASE")" || fail "could not find a free UI port from ${SERVER_BASE}"
PILOTDECK_GATEWAY_PORT="$(find_free_port "$GATEWAY_BASE")" || fail "could not find a free gateway port from ${GATEWAY_BASE}"
PILOTDECK_GATEWAY_URL="ws://127.0.0.1:${PILOTDECK_GATEWAY_PORT}/ws"

export PILOTDECK_CONFIG_PATH="$CONFIG_FILE"
export SERVER_PORT PILOTDECK_GATEWAY_PORT PILOTDECK_GATEWAY_URL

if [[ "$SERVER_PORT" != "$SERVER_BASE" ]]; then
  warn "UI port ${SERVER_BASE} is busy; using ${SERVER_PORT} instead."
fi
if [[ "$PILOTDECK_GATEWAY_PORT" != "$GATEWAY_BASE" ]]; then
  warn "Gateway port ${GATEWAY_BASE} is busy; using ${PILOTDECK_GATEWAY_PORT} instead."
fi

node "$INSTALL_DIR/scripts/bootstrap-pilotdeck-config.mjs"

printf "pilotdeck: starting at http://localhost:%s\n" "$SERVER_PORT"
export PILOTDECK_SKIP_DEFAULT_PROJECT=1
cd "$INSTALL_DIR/ui"
exec npm run start:built
EOF
chmod +x "$CLI_TARGET"
TARGET_BIN="$BIN_LINK"

if [[ -e "$BIN_LINK" || -L "$BIN_LINK" ]]; then
  if rm -f "$BIN_LINK" 2>/dev/null; then
    :
  elif sudo -n rm -f "$BIN_LINK" 2>/dev/null; then
    :
  else
    warn "$(L "Cannot update ${BIN_LINK} without sudo; falling back to user-local bin." "无 sudo 权限,无法更新 ${BIN_LINK};改用用户本地 bin 目录。")"
    TARGET_BIN="$HOME/.local/bin/pilotdeck"
  fi
fi

TARGET_BIN_DIR="$(dirname "$TARGET_BIN")"
if [[ "$TARGET_BIN" != "$BIN_LINK" ]]; then
  :
elif [[ ! -d "$TARGET_BIN_DIR" ]] && mkdir -p "$TARGET_BIN_DIR" 2>/dev/null; then
  :
fi

if [[ "$TARGET_BIN" == "$BIN_LINK" && -d "$TARGET_BIN_DIR" && -w "$TARGET_BIN_DIR" ]]; then
  ln -sf "$CLI_TARGET" "$TARGET_BIN"
  ok "$(L "pilotdeck command linked to" "pilotdeck 命令已链接到") ${DIM}${TARGET_BIN}${RESET}"
elif sudo -n true 2>/dev/null; then
  sudo mkdir -p "$TARGET_BIN_DIR"
  sudo ln -sf "$CLI_TARGET" "$TARGET_BIN"
  ok "$(L "pilotdeck command linked to" "pilotdeck 命令已链接到") ${DIM}${TARGET_BIN}${RESET}"
else
  LOCAL_BIN="$HOME/.local/bin"
  mkdir -p "$LOCAL_BIN"
  ln -sf "$CLI_TARGET" "$LOCAL_BIN/pilotdeck"
  ok "$(L "pilotdeck command linked to" "pilotdeck 命令已链接到") ${DIM}${LOCAL_BIN}/pilotdeck${RESET}"
  if [[ ":$PATH:" != *":$LOCAL_BIN:"* ]]; then
    PATH_LINE='export PATH="$HOME/.local/bin:$PATH"'
    SHELL_RC=""
    case "$(basename "${SHELL:-/bin/sh}")" in
      zsh)  SHELL_RC="$HOME/.zshrc" ;;
      bash)
        if [[ -f "$HOME/.bash_profile" ]]; then
          SHELL_RC="$HOME/.bash_profile"
        else
          SHELL_RC="$HOME/.bashrc"
        fi
        ;;
      fish) SHELL_RC="$HOME/.config/fish/config.fish"; PATH_LINE='set -gx PATH $HOME/.local/bin $PATH' ;;
      *)    SHELL_RC="$HOME/.profile" ;;
    esac

    if [[ -n "$SHELL_RC" ]]; then
      if [[ ! -f "$SHELL_RC" ]] || ! grep -qF '.local/bin' "$SHELL_RC" 2>/dev/null; then
        printf '\n# Added by PilotDeck installer\n%s\n' "$PATH_LINE" >> "$SHELL_RC"
        ok "$(L "PATH updated in" "已在以下文件更新 PATH:") ${DIM}${SHELL_RC}${RESET}"
        warn "$(L "Run ${BOLD}source ${SHELL_RC}${RESET} or open a new terminal to use the ${BOLD}pilotdeck${RESET} command" "运行 ${BOLD}source ${SHELL_RC}${RESET} 或新开一个终端即可使用 ${BOLD}pilotdeck${RESET} 命令")"
      else
        ok "$(L "${DIM}${SHELL_RC}${RESET} already contains .local/bin PATH entry" "${DIM}${SHELL_RC}${RESET} 已包含 .local/bin 的 PATH 配置")"
      fi
      export PATH="$LOCAL_BIN:$PATH"
    fi
  fi
fi
echo ""

run_onboarding
echo ""

if [[ "$PD_LANG" == "zh" ]]; then
  echo -e "${BOLD}安装完成!${RESET}"
  echo ""
  echo -e "  安装目录:   ${DIM}${INSTALL_DIR}${RESET}"
  echo -e "  配置文件:   ${DIM}${CONFIG_FILE}${RESET}"
  echo -e "  CLI 命令:   ${DIM}${TARGET_BIN}${RESET}"
  echo ""
  echo "正在启动 PilotDeck..."
else
  echo -e "${BOLD}Installation complete!${RESET}"
  echo ""
  echo -e "  App location:   ${DIM}${INSTALL_DIR}${RESET}"
  echo -e "  Config file:    ${DIM}${CONFIG_FILE}${RESET}"
  echo -e "  CLI command:    ${DIM}${TARGET_BIN}${RESET}"
  echo ""
  echo "Starting PilotDeck..."
fi
echo ""
export PILOTDECK_CONFIG_PATH="$CONFIG_FILE"
resolve_runtime_ports
node "$INSTALL_DIR/scripts/bootstrap-pilotdeck-config.mjs"
echo -e "  UI:             ${DIM}http://localhost:${SERVER_PORT}${RESET}"
echo -e "  Gateway:        ${DIM}${PILOTDECK_GATEWAY_URL}${RESET}"

print_getting_started "http://localhost:${SERVER_PORT}"

if [[ "$PD_LANG" == "zh" ]]; then
  echo -e "${BOLD}正在启动服务${RESET} — 打开 ${GREEN}http://localhost:${SERVER_PORT}${RESET} 完成引导配置。"
else
  echo -e "${BOLD}Starting server${RESET} — open ${GREEN}http://localhost:${SERVER_PORT}${RESET} to finish onboarding."
fi
echo ""
export PILOTDECK_SKIP_DEFAULT_PROJECT=1
cd "$INSTALL_DIR/ui"
exec npm run start:built
