#!/usr/bin/env bash
# install-pilotdeck.sh — One-step PilotDeck repair / launch helper.
#
# WHY THIS EXISTS
# ---------------
# macOS 14+ (Sonoma) Gatekeeper rejects `.app` bundles delivered via
# *sandboxed* applications — Lark/Feishu, WeChat, QQ, DingTalk, etc. — even
# when code signing + Apple notarization are perfectly valid.
#
# Mechanism: the OS attaches a `com.apple.provenance` extended attribute to
# the .app, naming the sandbox identity that wrote it to disk. Gatekeeper
# treats sandboxed-IM provenance as low-trust and refuses to execute,
# producing a "无法启动 PilotDeck 应用程序" dialog that flashes once and
# disappears. `codesign --verify` reports valid because the signature itself
# is fine — the rejection happens at *execution policy* level, not signature
# level. Plain `xattr -d com.apple.quarantine` is NOT sufficient; provenance
# is a separate attribute and survives that.
#
# WHAT THIS SCRIPT DOES
# ---------------------
#   1. Locates PilotDeck.app (argv[1], /Applications, ~/Downloads, ~/Desktop)
#   2. Lists current xattrs so the user can see what's wrong
#   3. Strips ALL xattrs (quarantine + provenance + finder + writer-id)
#   4. Re-verifies code signature and Gatekeeper assessment
#   5. Optionally launches the app
#
# Usage:
#   bash install-pilotdeck.sh              # auto-discover
#   bash install-pilotdeck.sh /path/to/PilotDeck.app
#   bash install-pilotdeck.sh --launch     # also `open` the app at the end

set -euo pipefail

RED=$'\033[0;31m'
GRN=$'\033[0;32m'
YEL=$'\033[0;33m'
CYN=$'\033[0;36m'
DIM=$'\033[2m'
BLD=$'\033[1m'
RST=$'\033[0m'
ok()    { printf "  ${GRN}✓${RST} %s\n" "$*"; }
warn()  { printf "  ${YEL}⚠${RST} %s\n" "$*"; }
info()  { printf "  ${DIM}%s${RST}\n" "$*"; }
fail()  { printf "  ${RED}✗${RST} %s\n" "$*" >&2; exit 1; }
step()  { printf "\n${BLD}${CYN}%s${RST}\n" "$*"; }

LAUNCH=0
APP_ARG=""
for arg in "$@"; do
  case "$arg" in
    --launch|-l) LAUNCH=1 ;;
    -h|--help)
      sed -n '2,30p' "$0" | sed 's/^# \{0,1\}//'
      exit 0
      ;;
    *) APP_ARG="$arg" ;;
  esac
done

locate_app() {
  local candidates=(
    "${1:-}"
    "/Applications/PilotDeck.app"
    "$HOME/Applications/PilotDeck.app"
    "$HOME/Downloads/PilotDeck.app"
    "$HOME/Desktop/PilotDeck.app"
  )
  for p in "${candidates[@]}"; do
    [[ -n "$p" && -d "$p" ]] && { echo "$p"; return 0; }
  done
  return 1
}

APP="$(locate_app "$APP_ARG")" || fail "PilotDeck.app not found.
  Pass path as the first argument, e.g.:
    bash install-pilotdeck.sh /path/to/PilotDeck.app
  Or drag PilotDeck.app into /Applications first, then re-run."

printf "${BLD}PilotDeck 安装修复工具${RST}\n"
info "Target: $APP"

step "1. 当前扩展属性 (xattrs)"
XATTRS_BEFORE="$(xattr "$APP" 2>/dev/null || true)"
if [[ -z "$XATTRS_BEFORE" ]]; then
  ok "无任何 xattr — App 已经健康"
else
  while IFS= read -r line; do
    case "$line" in
      *com.apple.quarantine*)  warn "$line   ← Gatekeeper 隔离标记" ;;
      *com.apple.provenance*)  warn "$line  ← 沙盒 App 投放标记 (飞书/IM 等)" ;;
      *com.apple.macl*)        info "$line       (访问控制列表)" ;;
      *com.apple.lastuseddate*) info "$line  (最近使用时间)" ;;
      *)                       info "$line" ;;
    esac
  done <<< "$XATTRS_BEFORE"
fi

step "2. 抹除所有扩展属性"
if [[ -z "$XATTRS_BEFORE" ]]; then
  ok "已经干净，跳过"
else
  if xattr -cr "$APP" 2>/dev/null; then
    ok "已清除所有 xattrs"
  else
    warn "无 sudo 清除失败 — 用 sudo 重试 (会要求输入密码)"
    sudo xattr -cr "$APP" || fail "sudo xattr 仍失败 — 请检查 $APP 的所有权"
    ok "已清除所有 xattrs (with sudo)"
  fi
fi

step "3. 验证代码签名"
if codesign --verify --deep --strict "$APP" 2>/dev/null; then
  AUTHORITY="$(codesign -dvv "$APP" 2>&1 | grep -m1 '^Authority=' | cut -d= -f2- || true)"
  ok "签名有效 — Authority: ${AUTHORITY:-unknown}"
else
  warn "签名验证失败 (这通常意味着 .app 在传输中损坏)"
  warn "建议:重新从干净渠道下载 PilotDeck-*.dmg"
fi

step "4. Notarize ticket (stapler)"
# Stapler ticket 存在 Contents/CodeResources 文件里 (不是 xattr),所以
# step 2 的 xattr -cr 不会清掉它。这一步独立验证 ticket 是否存在,以便
# 区分"provenance 问题"和"app 本身没 staple"两种根本不同的故障模式。
STAPLER_OUT="$(xcrun stapler validate "$APP" 2>&1 || true)"
if echo "$STAPLER_OUT" | grep -q "validate action worked"; then
  STAPLER_OK=1
  ok "Stapled ticket 嵌入在 Contents/CodeResources,离线也可校验"
else
  STAPLER_OK=0
  warn "Stapled ticket 缺失:"
  echo "$STAPLER_OUT" | sed 's/^/      /'
  warn "→ 这份 .app 不是最新打包出来的版本(可能用了某次 unnotarized release)"
  warn "→ 请联系打包者拿最新 PilotDeck-*.dmg(目前最新版本由 release.sh --signed 产出)"
fi

step "5. Gatekeeper 评估"
SPCTL_OUT="$(spctl -a -t exec -vv "$APP" 2>&1 || true)"
if echo "$SPCTL_OUT" | grep -q "accepted"; then
  SOURCE="$(echo "$SPCTL_OUT" | grep -m1 '^source=' | cut -d= -f2- | xargs || true)"
  ok "Gatekeeper 接受 — source: ${SOURCE:-unknown}"
elif [[ "$STAPLER_OK" == "1" ]]; then
  warn "Stapler ticket 有效但 Gatekeeper 仍拒绝 — 不太常见,可能是:"
  warn "  • spctl 缓存了旧决策 → 试试 sudo spctl --master-disable && sudo spctl --master-enable"
  warn "  • LaunchServices 数据库异常 → 重启 Mac 后再试"
  echo "$SPCTL_OUT" | sed 's/^/      /'
else
  warn "Gatekeeper 不接受 (因为 stapler ticket 缺失,见上一步):"
  echo "$SPCTL_OUT" | sed 's/^/      /'
fi

step "6. 完成"
ok "可以正常启动 PilotDeck 了"
echo
echo "  方式 1 (Finder/Dock):  双击 ${BLD}PilotDeck${RST}"
echo "  方式 2 (Terminal):     open '${APP}'"
echo

if [[ "$LAUNCH" == "1" ]]; then
  info "(--launch 已指定，正在启动…)"
  open "$APP"
fi
