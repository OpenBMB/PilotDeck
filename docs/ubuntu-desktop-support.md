# Ubuntu desktop support

PilotDeck provides architecture-matched DEB installers for Ubuntu 22.04 and later.
The build baseline and required checks below define compatibility; headless CI
does not certify every desktop environment.

## Target

- Minimum: Ubuntu 22.04 LTS, x86_64 and arm64. Build each architecture on a
  native Ubuntu 22.04 runner so bundled native modules do not acquire a newer
  glibc requirement. The 22.04 user space uses glibc 2.35. The build command
  rejects other Ubuntu versions.
- Package: one `.deb` per architecture. Ubuntu's package manager can install the
  declared desktop libraries and system Git, register the desktop launcher,
  and handle uninstall. The x86_64 package filename uses `x64`, matching the
  other desktop installers; the DEB's internal architecture remains Debian's
  `amd64`. Its update feed is `latest-linux.yml`. A portable AppImage
  can be evaluated later if users need other distributions; Snap and Flatpak
  need separate validation of local files, terminals, child processes, and
  browser downloads.
- Other Debian-family desktops: the window menu popup uses Electron's renderer
  and the current application menu template. It has no Yaru, GNOME Shell,
  AppIndicators, GTK theme, or distro-specific dependency. This is the shared
  implementation for Kylin, Deepin and UOS too. Installing the DEB still
  requires a compatible `amd64` or `arm64` system, glibc 2.35 or newer, and
  the declared system libraries. A top-panel tray icon additionally requires
  a status-icon host supplied by the desktop environment. Actual distro and
  version support must be established with installation and desktop tests;
  the Ubuntu build baseline does not certify every Kylin, Deepin or UOS
  release.
- Display: support both X11/Xorg and native Wayland. Electron 42's Ozone
  selection defaults to `auto` on Linux. On a Wayland session, users can force
  XWayland with `pilotdeck-desktop --ozone-platform=x11` if a compositor-specific
  problem occurs. Do not force X11 for everyone.
- Background: closing the window hides it when the desktop tray is available.
  Ubuntu's top-panel AppIndicators host shows the menu to reopen or quit;
  launching the application again also restores the running window. If the
  tray cannot be created, closing the last window exits normally.

## Release verification

1. The release workflow builds on `ubuntu-22.04` (x64) and `ubuntu-22.04-arm`
   (arm64). The same reusable workflow runs before PR merge and during Daily
   Release. Each job checks the `.deb` architecture, updater feed, installed
   launcher icon and native modules, then starts the installed app under
   Xvfb/X11 and headless Weston/Wayland. Both architecture jobs and both Linux
   feeds must pass before publishing. Confirm a completed workflow on the production
   repository; local builds cannot validate hosted runner behavior.
2. On full Ubuntu 22.04 desktop installations, test both an Xorg login and a
   Wayland login for each architecture. Install with `apt`, launch from the
   application menu, then test the onboarding window, resize/close/reopen,
   clipboard, file dialogs, terminal/PTY, tray/menu behavior, and clean exit.
   Repeat native Wayland and forced XWayland on the Wayland login.
   Before claiming Kylin, Deepin or UOS support for a specific release,
   repeat installation, menu, theme, tray, terminal and updater checks on that
   release and both CPU architectures. Their shell panels and system package
   names may differ from Ubuntu's.
3. Install an older release and exercise the full check, download, checksum,
   PolicyKit authorization, `dpkg` upgrade, and relaunch path against a newer
   published release on both architectures. The updater requires an explicit
   **Update and restart** action; closing the application does not install it.

References: [Electron Ozone behavior](https://www.electronjs.org/docs/latest/breaking-changes/),
[Electron Wayland window notes](https://www.electronjs.org/docs/latest/api/browser-window),
[electron-builder v26 Linux targets](https://www.electron.build/v26/docs/linux/),
[electron-updater v26 DEB support](https://www.electron.build/v26/docs/features/auto-update/),
[GitHub hosted runner labels](https://docs.github.com/en/actions/reference/runners/github-hosted-runners).

RPM packages for the RHEL family are described in [RPM desktop support](redhat-desktop-support.md).
Their build baseline and update feeds are separate from these Ubuntu DEBs.
