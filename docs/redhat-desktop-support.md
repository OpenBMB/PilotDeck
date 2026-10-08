# RPM desktop support

PilotDeck ships separate RPM installers for Linux x64 and ARM64, alongside the
existing Ubuntu DEBs. The RPM build baseline is Rocky Linux 9 (glibc 2.34), with
native architecture-matched CI runners. The target family is RHEL 9+, Rocky Linux
9+, AlmaLinux 9+, and Fedora desktops. RHEL 8 and older are outside this baseline.
A build baseline does not certify every distribution or desktop environment;
current hands-on results are recorded below.

## Build and installation

Build in a Rocky Linux 9 container on the matching CPU architecture:

```bash
# As root, install the packaging/native-module toolchain:
bash apps/desktop/scripts/install-rpm-build-deps.sh
# Install Node.js 22.23.1 and pnpm 10.32.1, then:
pnpm install --frozen-lockfile
USE_SYSTEM_FPM=true pnpm --filter pilotdeck-desktop dist:linux:rpm:x64
# Or, on ARM64:
USE_SYSTEM_FPM=true pnpm --filter pilotdeck-desktop dist:linux:rpm:arm64
```

The installer names use `linux-x64.rpm` and `linux-arm64.rpm`; their RPM header
architectures are `x86_64` and `aarch64`. Install with the system package manager
so the declared Git, GTK3, audio, GBM, NSS, notification, Secret Service and X11
library dependencies are resolved:

```bash
sudo dnf install ./PilotDeck-VERSION-linux-arm64.rpm
# Substitute linux-x64.rpm on x64 devices. yum is supported on RHEL systems too.
```

The app installs at `/opt/PilotDeck`, with a desktop launcher and hicolor icon.
RPM payloads use gzip compression to keep memory use practical on 4 GB build
VMs. Its Node.js runtime and native SQLite, bcrypt, image and terminal modules are
bundled. Linux menus, localization, appearance and window chrome share the
existing DEB implementation. Tray visibility depends on the desktop's status
icon host; standard GNOME may need an extension for status icons.

## Updates and release gates

The installed `resources/package-type` selects `RpmUpdater` or `DebUpdater`.
RPM clients accept only their own architecture's RPM payload and use
`latest-rpm-linux.yml` (x64) or `latest-rpm-linux-arm64.yml` (ARM64). DEB feeds
retain their existing names. Each downloaded payload is verified against the
unified release manifest and SHA256/SHA512 checksums before installation.
The RPM updater installs through the system package manager with elevated
authorization; the current dependency tries dnf/yum after zypper.

Desktop Smoke and Daily Release call the same RPM workflow. Each architecture
builds on Rocky Linux 9, validates the RPM header, feed and package marker,
installs on that baseline, and executes the bundled native modules and updater.
The same RPM job starts the installed server and Electron window under X11 and
Wayland on Rocky Linux 9 before uploading the installer. Linux CI exposes only
DEB and RPM jobs for x64 and ARM64. Daily Release requires both RPMs and both
RPM feeds before publishing. Fedora desktop behavior is covered by the local
validation below.
The Wayland test installs Weston from EPEL after baseline package verification;
this test-tool repository is not required by the PilotDeck RPM itself.

## Local validation

On 2026-10-04, both RPMs were built from the working changes based on
`d2110278bc06938afedac78a9a50305d32e4b720` and installed on Rocky Linux 9.
ARM64 built natively; x64 built and ran native-module checks under QEMU on the
ARM64 host. Both installed payloads passed SQLite, bcrypt, sharp, PTY, launcher,
icon, package-marker and packaged-updater checks on the glibc 2.34 baseline.

The ARM64 RPM also passed installation and X11/Wayland startup on a real
Fedora 44 ARM64 VM. Its GNOME session passed Chinese onboarding and menus,
light/dark switching, sidebar resizing, native fullscreen, minimize/restore,
and a local simulated-model streaming conversation with history after reload.
The packaged updater's dnf command accepted the already-installed test RPM;
a download/PolicyKit/version-upgrade cycle remains unverified.

The default x64 Electron graphical smoke failed in QEMU with a GPU subprocess
trap. A diagnostic X11 run with `--no-zygote --in-process-gpu` then passed
window creation and bundled-server startup. These are test-only emulation
switches; a native x64 graphical result is still required. The new CI workflow
includes native x64 and ARM64 display checks, but has not run from this local
branch. RHEL/AlmaLinux desktops, GNOME tray hosting and external model providers
remain untested.

The local record `artifacts/rpm-support/validation.md` contains package hashes,
logs and screenshots. These local artifacts are ignored by Git.

References: [electron-builder Linux targets](https://www.electron.build/v26/docs/linux/),
[RpmUpdater](https://www.electron.build/v26/docs/api/electron-updater.class.rpmupdater/).
