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
APT_UPDATED=0

GREEN='\033[0;32m'
YELLOW='\033[0;33m'
RED='\033[0;31m'
DIM='\033[2m'
BOLD='\033[1m'
RESET='\033[0m'

ok() { printf "  ${GREEN}✓${RESET} %s\n" "$1"; }
warn() { printf "  ${YELLOW}→${RESET} %s\n" "$1"; }
fail() { printf "  ${RED}✗${RESET} %s\n" "$1"; exit 1; }

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
    fail "Need root privileges to install system packages. Please install sudo or run as root."
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
    fail "Unsupported Linux package manager. Please install manually: ${requested[*]}"
  fi
}

install_git() {
  if [[ "$PLATFORM" == "linux" ]]; then
    install_linux_packages git
  else
    fail "git is not installed. Please install Xcode Command Line Tools: xcode-select --install"
  fi
}

install_ripgrep() {
  if [[ "$PLATFORM" == "macos" ]] && command -v brew >/dev/null 2>&1; then
    brew install ripgrep </dev/null
  elif [[ "$PLATFORM" == "linux" ]]; then
    install_linux_packages ripgrep
  else
    fail "ripgrep (rg) is required. On macOS, install Homebrew and run: brew install ripgrep"
  fi
}

install_git_lfs() {
  if [[ "$PLATFORM" == "macos" ]] && command -v brew >/dev/null 2>&1; then
    brew install git-lfs </dev/null
  elif [[ "$PLATFORM" == "linux" ]]; then
    install_linux_packages git-lfs
  else
    fail "git-lfs is required for PilotDeck assets. On macOS, install Homebrew and run: brew install git-lfs"
  fi
}

install_lsof() {
  if [[ "$PLATFORM" == "linux" ]]; then
    install_linux_packages lsof
  else
    fail "lsof is required but missing. Please install Xcode Command Line Tools: xcode-select --install"
  fi
}

has_cxx_compiler() {
  command -v g++ >/dev/null 2>&1 || command -v c++ >/dev/null 2>&1 || command -v clang++ >/dev/null 2>&1
}

ensure_native_build_tools() {
  if command -v python3 >/dev/null 2>&1 && command -v make >/dev/null 2>&1 && has_cxx_compiler; then
    ok "native build tools found"
    return
  fi

  if [[ "$PLATFORM" == "linux" ]]; then
    warn "native build tools not found. Installing build tools for node-pty/better-sqlite3..."
    install_linux_packages build-tools
    ok "native build tools installed"
  else
    fail "native build tools are missing. Please install Xcode Command Line Tools: xcode-select --install"
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
    fail "Could not find a free UI port within ${MAX_PORT_TRIES} ports from ${server_base}."
  PILOTDECK_GATEWAY_PORT="$(find_free_port "$gateway_base")" || \
    fail "Could not find a free gateway port within ${MAX_PORT_TRIES} ports from ${gateway_base}."
  PILOTDECK_GATEWAY_URL="ws://127.0.0.1:${PILOTDECK_GATEWAY_PORT}/ws"

  export SERVER_PORT PILOTDECK_GATEWAY_PORT PILOTDECK_GATEWAY_URL

  if [[ "$SERVER_PORT" != "$server_base" ]]; then
    warn "UI port ${server_base} is busy; using ${SERVER_PORT} instead."
  fi
  if [[ "$PILOTDECK_GATEWAY_PORT" != "$gateway_base" ]]; then
    warn "Gateway port ${gateway_base} is busy; using ${PILOTDECK_GATEWAY_PORT} instead."
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
      fail "Could not clone ${REPO_URL}. Check repository access and network connectivity."
  else
    clone_without_lfs_smudge git clone --branch "$BRANCH" --depth 1 "$REPO_URL" "$INSTALL_DIR" || \
      fail "Could not clone ${REPO_URL}. If this repository is private, authenticate with GitHub first."
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
  warn "Existing installation moved to ${backup_dir}"
}

checkout_existing_installation() {
  cd "$INSTALL_DIR"
  GIT_LFS_SKIP_SMUDGE=1 git fetch origin "$BRANCH"
  GIT_LFS_SKIP_SMUDGE=1 git checkout -B "$BRANCH" "origin/$BRANCH"
}

install_or_update_repo() {
  mkdir -p "$(dirname "$INSTALL_DIR")"

  if [[ -d "$INSTALL_DIR/.git" ]]; then
    local current_remote current_remote_normalized expected_remote_normalized
    current_remote="$(repo_remote_url "$INSTALL_DIR")"
    current_remote_normalized="$(normalize_github_remote "$current_remote")"
    expected_remote_normalized="$(normalize_github_remote "$REPO_URL")"
    if [[ "$current_remote_normalized" != "$expected_remote_normalized" ]]; then
      warn "Existing installation uses ${current_remote:-unknown remote}; expected ${REPO_URL}."
      backup_existing_installation "$INSTALL_DIR"
      clone_repo
      ok "Repository cloned"
      return
    fi

    if repo_has_changes "$INSTALL_DIR"; then
      warn "Existing installation has local changes; preserving it before reinstalling."
      backup_existing_installation "$INSTALL_DIR"
      clone_repo
      ok "Repository cloned"
      return
    fi

    warn "Existing installation found. Updating..."
    if checkout_existing_installation; then
      ok "Updated to latest ${BRANCH}"
    else
      warn "Fast update failed; preserving existing checkout before reinstalling."
      cd "$(dirname "$INSTALL_DIR")"
      backup_existing_installation "$INSTALL_DIR"
      clone_repo
      ok "Repository cloned"
    fi
    return
  fi

  if [[ -d "$INSTALL_DIR" ]]; then
    warn "Cleaning incomplete installation at $INSTALL_DIR"
    rm -rf "$INSTALL_DIR"
  fi
  clone_repo
  ok "Repository cloned"
}

ensure_lfs_assets() {
  if [[ "${PILOTDECK_INSTALL_LFS:-0}" != "1" ]]; then
    warn "Skipping Git LFS media download. Set PILOTDECK_INSTALL_LFS=1 to fetch demo images/videos."
    return
  fi

  if [[ "${GIT_LFS_SKIP_SMUDGE:-}" == "1" ]]; then
    warn "GIT_LFS_SKIP_SMUDGE=1 is set; large media assets were intentionally skipped."
    return
  fi

  if ! command -v git-lfs >/dev/null 2>&1 && ! git lfs version >/dev/null 2>&1; then
    fail "git-lfs command not found after installation."
  fi

  cd "$INSTALL_DIR"
  git lfs install --local >/dev/null
  git lfs pull

  local pointer_file=""
  for pointer_file in assets/banner.png ui/public/favicon.png ui/src/assets/pilotdeck-logo.png; do
    if [[ -f "$pointer_file" ]] && grep -q "version https://git-lfs.github.com/spec/v1" "$pointer_file"; then
      fail "Git LFS asset was not downloaded correctly: ${pointer_file}"
    fi
  done
  ok "Git LFS assets downloaded"
}

has_playwright_chrome_for_testing() {
  local base
  for base in \
    "$HOME/Library/Caches/ms-playwright" \
    "$HOME/.cache/ms-playwright"; do
    if find "$base" -maxdepth 1 -name "mcp-chrome-for-testing-*" -type d 2>/dev/null | grep -q .; then
      return 0
    fi
  done
  return 1
}

echo ""
echo -e "${BOLD}PilotDeck Installer${RESET}"
echo "====================="
echo ""

echo "Checking system requirements..."
case "$(uname -s)" in
  Darwin)
    PLATFORM="macos"
    ok "macOS detected"
    ;;
  Linux)
    PLATFORM="linux"
    ok "Linux detected"
    ;;
  *)
    fail "Unsupported OS: $(uname -s). This installer supports macOS and Linux."
    ;;
esac
echo ""

echo "Checking Node.js..."
if command -v node >/dev/null 2>&1; then
  NODE_VERSION="$(node --version)"
  NODE_MAJOR="$(echo "$NODE_VERSION" | sed 's/v//' | cut -d. -f1)"
  if [[ "$NODE_MAJOR" -ge 22 ]]; then
    ok "Node.js ${NODE_VERSION} found"
  else
    warn "Node.js ${NODE_VERSION} is too old (need >=22). Installing Node.js 22..."
    if command -v fnm >/dev/null 2>&1; then
      fnm install 22
      fnm use 22
    elif command -v nvm >/dev/null 2>&1; then
      nvm install 22 </dev/null
      nvm use 22
    else
      warn "Installing fnm (Fast Node Manager)..."
      curl -fsSL https://fnm.vercel.app/install | bash
      export PATH="$HOME/.local/share/fnm:$PATH"
      eval "$(fnm env)"
      fnm install 22 </dev/null
      fnm use 22
    fi
    ok "Node.js $(node --version) installed"
  fi
else
  warn "Node.js not found. Installing via fnm..."
  curl -fsSL https://fnm.vercel.app/install | bash
  export PATH="$HOME/.local/share/fnm:$PATH"
  eval "$(fnm env)"
  fnm install 22 </dev/null
  fnm use 22
  ok "Node.js $(node --version) installed"
fi
echo ""

echo "Checking git..."
if ! command -v git >/dev/null 2>&1; then
  warn "git not found. Installing..."
  install_git
fi
ok "git found"
echo ""

if [[ "${PILOTDECK_INSTALL_LFS:-0}" == "1" ]]; then
  echo "Checking Git LFS..."
  if [[ "${GIT_LFS_SKIP_SMUDGE:-}" == "1" ]]; then
    warn "GIT_LFS_SKIP_SMUDGE=1 is set; large media assets will be skipped."
  elif command -v git-lfs >/dev/null 2>&1 || git lfs version >/dev/null 2>&1; then
    ok "Git LFS $(git lfs version | awk '{print $1}') found"
  else
    warn "Git LFS not found. Installing..."
    install_git_lfs
    ok "Git LFS installed"
  fi
  echo ""
fi

echo "Checking ripgrep..."
if command -v rg >/dev/null 2>&1; then
  ok "ripgrep $(rg --version | head -1) found"
else
  warn "ripgrep not found. Installing..."
  install_ripgrep
  ok "ripgrep installed"
fi
echo ""

echo "Checking lsof..."
if ! command -v lsof >/dev/null 2>&1; then
  warn "lsof not found. Installing..."
  install_lsof
fi
ok "lsof found"
echo ""

echo "Checking native build tools..."
ensure_native_build_tools
echo ""

echo -e "Installing PilotDeck to ${DIM}${INSTALL_DIR}${RESET} ..."
install_or_update_repo
ensure_lfs_assets
echo ""

echo "Installing root dependencies..."
cd "$INSTALL_DIR"
HUSKY=0 npm install --no-audit --no-fund --loglevel=error </dev/null
ok "Root dependencies installed"
warn "Keeping root dev dependencies because runtime uses tsx from source."
echo ""

echo "Installing UI dependencies & building frontend..."
cd "$INSTALL_DIR/ui"
HUSKY=0 npm install --no-audit --no-fund --loglevel=error </dev/null
ok "UI dependencies installed"
npm run build
ok "Frontend built"
warn "Keeping UI dev dependencies because production start uses concurrently/vite build tooling."
echo ""

echo "Checking Playwright browser for browser-use plugin..."
cd "$INSTALL_DIR"
BROWSER_INSTALL_TIMEOUT="${PILOTDECK_BROWSER_INSTALL_TIMEOUT:-300}"
if has_playwright_chrome_for_testing; then
  ok "Chrome for Testing already installed"
elif [[ "${PILOTDECK_SKIP_BROWSER_INSTALL:-0}" == "1" ]]; then
  warn "Skipping Chrome for Testing install because PILOTDECK_SKIP_BROWSER_INSTALL=1"
else
  echo "  Downloading and extracting Chrome for Testing (timeout: ${BROWSER_INSTALL_TIMEOUT}s)..."
  echo "  This may take a few minutes — the extraction step can appear to stall."
  if run_with_timeout "${BROWSER_INSTALL_TIMEOUT}" npx @playwright/mcp install-browser chrome-for-testing </dev/null; then
    ok "Chrome for Testing installed"
  else
    exit_code=$?
    if [[ $exit_code -eq 124 ]]; then
      warn "Chrome for Testing install timed out after ${BROWSER_INSTALL_TIMEOUT}s."
    else
      warn "Chrome for Testing install failed (exit code $exit_code)."
    fi
    warn "PilotDeck core features are still available."
    warn "To enable browser-use later, run: cd \"$INSTALL_DIR\" && npm run install:browser"
    warn "To increase timeout, set PILOTDECK_BROWSER_INSTALL_TIMEOUT=600 and re-run."
  fi
fi
echo ""

echo "Installing ClawHub CLI..."
if command -v clawhub >/dev/null 2>&1; then
  ok "ClawHub CLI already installed ($(clawhub --version 2>/dev/null || echo 'unknown version'))"
else
  npm install -g clawhub --loglevel=error </dev/null && \
    ok "ClawHub CLI installed" || \
    warn "ClawHub CLI install failed (skill marketplace features may not work)"
fi
echo ""

echo "Setting up CLI command..."
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

fail() { printf "pilotdeck: %s\n" "$1" >&2; exit 1; }
warn() { printf "pilotdeck: %s\n" "$1" >&2; }

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
    warn "Cannot update ${BIN_LINK} without sudo; falling back to user-local bin."
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
  ok "pilotdeck command linked to ${DIM}${TARGET_BIN}${RESET}"
elif sudo -n true 2>/dev/null; then
  sudo mkdir -p "$TARGET_BIN_DIR"
  sudo ln -sf "$CLI_TARGET" "$TARGET_BIN"
  ok "pilotdeck command linked to ${DIM}${TARGET_BIN}${RESET}"
else
  LOCAL_BIN="$HOME/.local/bin"
  mkdir -p "$LOCAL_BIN"
  ln -sf "$CLI_TARGET" "$LOCAL_BIN/pilotdeck"
  ok "pilotdeck command linked to ${DIM}${LOCAL_BIN}/pilotdeck${RESET}"
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
        ok "PATH updated in ${DIM}${SHELL_RC}${RESET}"
        warn "Run ${BOLD}source ${SHELL_RC}${RESET} or open a new terminal to use the ${BOLD}pilotdeck${RESET} command"
      else
        ok "${DIM}${SHELL_RC}${RESET} already contains .local/bin PATH entry"
      fi
      export PATH="$LOCAL_BIN:$PATH"
    fi
  fi
fi
echo ""

echo -e "${BOLD}Installation complete!${RESET}"
echo ""
echo -e "  App location:   ${DIM}${INSTALL_DIR}${RESET}"
echo -e "  Config file:    ${DIM}${CONFIG_FILE}${RESET}"
echo -e "  CLI command:    ${DIM}${TARGET_BIN}${RESET}"
echo ""

echo "Starting PilotDeck..."
echo ""
export PILOTDECK_CONFIG_PATH="$CONFIG_FILE"
resolve_runtime_ports
node "$INSTALL_DIR/scripts/bootstrap-pilotdeck-config.mjs"
echo -e "  UI:             ${DIM}http://localhost:${SERVER_PORT}${RESET}"
echo -e "  Gateway:        ${DIM}${PILOTDECK_GATEWAY_URL}${RESET}"
echo ""
export PILOTDECK_SKIP_DEFAULT_PROJECT=1
cd "$INSTALL_DIR/ui"
exec npm run start:built
