#!/usr/bin/env bash
# Run in a disposable RPM build/test container. Leave the real package installed
# for the subsequent runtime and display smoke tests.
set -euo pipefail
rpm_path="$(realpath "$1")"
package_name="$(rpm -qp --qf '%{NAME}' "$rpm_path")"
test "$package_name" = pilotdeck-desktop
if rpm -q "$package_name" >/dev/null 2>&1; then
  echo 'RPM upgrade test requires a clean container' >&2
  exit 1
fi
test_root="$(mktemp -d)"
trap 'rm -rf "$test_root"' EXIT
mkdir -p "$test_root/rpmbuild"/{BUILD,BUILDROOT,RPMS,SOURCES,SPECS,SRPMS}
cat > "$test_root/rpmbuild/SPECS/legacy.spec" <<'SPEC'
Name: pilotdeck-desktop
Version: 0.0.1
Release: 1
Summary: Legacy PilotDeck scriptlet fixture
License: AGPL-3.0-only
%description
Reproduces the unconditional launcher removal in older electron-builder RPMs.
%install
mkdir -p %{buildroot}/opt/PilotDeck
printf '#!/bin/sh\nexit 0\n' > %{buildroot}/opt/PilotDeck/pilotdeck-desktop
chmod 755 %{buildroot}/opt/PilotDeck/pilotdeck-desktop
%post
ln -sf /opt/PilotDeck/pilotdeck-desktop /usr/bin/pilotdeck-desktop
%postun
rm -f /usr/bin/pilotdeck-desktop
%files
/opt/PilotDeck/pilotdeck-desktop
SPEC
rpmbuild --define "_topdir $test_root/rpmbuild" -bb "$test_root/rpmbuild/SPECS/legacy.spec"
legacy_rpm="$(find "$test_root/rpmbuild/RPMS" -name '*.rpm' -print -quit)"
dnf install -y "$legacy_rpm"
test -x /usr/bin/pilotdeck-desktop
dnf install -y "$rpm_path"
test "$(rpm -q --qf '%{VERSION}-%{RELEASE}' "$package_name")" = "$(rpm -qp --qf '%{VERSION}-%{RELEASE}' "$rpm_path")"
test -x /usr/bin/pilotdeck-desktop
ELECTRON_RUN_AS_NODE=1 /usr/bin/pilotdeck-desktop -e 'console.log("RPM upgrade launcher:", process.platform, process.arch)'
# Exercise the installed package's upgrade branch without replacing its payload.
rpm -qp --qf '%{POSTUN}' "$rpm_path" > "$test_root/postun.sh"
sh "$test_root/postun.sh" 1
test -x /usr/bin/pilotdeck-desktop
dnf remove -y "$package_name"
test ! -e /usr/bin/pilotdeck-desktop
test ! -L /usr/bin/pilotdeck-desktop
dnf install -y "$rpm_path"
test -x /usr/bin/pilotdeck-desktop
echo 'RPM legacy upgrade, upgrade cleanup and final uninstall verified'
