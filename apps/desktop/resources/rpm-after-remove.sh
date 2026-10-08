#!/bin/sh
# RPM passes the number of remaining instances: only 0 means final removal.
# During upgrades the old package's postun runs after the new package's post.
[ "$1" = "0" ] || exit 0

if type update-alternatives >/dev/null 2>&1; then
  update-alternatives --remove '${executable}' '/opt/${sanitizedProductName}/${executable}'
else
  rm -f '/usr/bin/${executable}'
fi

APPARMOR_PROFILE_DEST='/etc/apparmor.d/${executable}'
if [ -f "$APPARMOR_PROFILE_DEST" ]; then
  if type apparmor_status >/dev/null 2>&1 && apparmor_status --enabled; then
    if ! type ischroot >/dev/null 2>&1 || ! ischroot; then
      if type apparmor_parser >/dev/null 2>&1; then
        apparmor_parser --remove "$APPARMOR_PROFILE_DEST" || true
      fi
    fi
  fi
  rm -f "$APPARMOR_PROFILE_DEST"
fi
