#!/bin/sh
# Releases with electron-builder's default postun remove the new launcher on
# upgrade. Repair it after all old-package scriptlets have finished as well.
if [ -x '/opt/PilotDeck/pilotdeck-desktop' ]; then
  if type update-alternatives >/dev/null 2>&1; then
    update-alternatives --install '/usr/bin/pilotdeck-desktop' 'pilotdeck-desktop' '/opt/PilotDeck/pilotdeck-desktop' 100
  else
    ln -sf '/opt/PilotDeck/pilotdeck-desktop' '/usr/bin/pilotdeck-desktop'
  fi
fi
