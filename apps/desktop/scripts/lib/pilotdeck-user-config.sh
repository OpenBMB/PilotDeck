#!/usr/bin/env bash
# Backup / restore the user's real ~/.pilotdeck (only when a test opts in).
# Default L1/L2 sandboxes never call these — they use PILOT_HOME under a temp dir.

pd_user_config__real_home() {
  echo "${HOME}/.pilotdeck"
}

# Copy ~/.pilotdeck → ~/.pilotdeck.backup-release-smoke.<pid>
pd_user_config_backup() {
  local real
  real="$(pd_user_config__real_home)"
  PD_USER_CONFIG_BACKUP="${real}.backup-release-smoke.$$"
  if [[ ! -e "$real" ]]; then
    PD_USER_CONFIG_HAD_CONFIG=0
    return 0
  fi
  PD_USER_CONFIG_HAD_CONFIG=1
  rm -rf "$PD_USER_CONFIG_BACKUP"
  cp -a "$real" "$PD_USER_CONFIG_BACKUP"
  echo "  backed up ${real} → ${PD_USER_CONFIG_BACKUP}"
}

# Restore from backup; removes smoke-written config if there was no prior config.
pd_user_config_restore() {
  local real
  real="$(pd_user_config__real_home)"
  if [[ "${PD_USER_CONFIG_HAD_CONFIG:-0}" == "1" && -d "${PD_USER_CONFIG_BACKUP:-}" ]]; then
    rm -rf "$real"
    mv "$PD_USER_CONFIG_BACKUP" "$real"
    echo "  restored ${real} from backup"
  elif [[ "${PD_USER_CONFIG_HAD_CONFIG:-0}" == "0" && -d "$real" ]]; then
    rm -rf "$real"
    echo "  removed smoke-created ${real} (no prior config)"
  fi
  unset PD_USER_CONFIG_BACKUP PD_USER_CONFIG_HAD_CONFIG
}
