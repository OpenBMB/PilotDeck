# Ubuntu desktop support assessment

Status: local validation on 2026-09-29. This branch adds Linux DEB builds to
the release workflow and wires the desktop update action to the DEB updater.
The public Latest Release still has no Linux assets until this branch is merged
and a new release completes.
The `0.1.0` Ubuntu test packages predate this updater and must be upgraded
manually once. Releases built from this branch can update later releases.

## Target

- Minimum: Ubuntu 22.04 LTS, x86_64 and arm64. Build each architecture on a
  native Ubuntu 22.04 runner so bundled native modules do not acquire a newer
  glibc requirement. The 22.04 user space uses glibc 2.35. The build command
  rejects other Ubuntu versions.
  GitHub plans to retire its hosted 22.04 runner images on 2027-04-17; before
  then, move the 22.04 build user space to containers on newer native hosts or
  provide native 22.04 self-hosted runners while keeping the same build-host
  and packaged-binary compatibility checks.
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
  the Ubuntu validation below does not certify every Kylin, Deepin or UOS
  release.
- Display: support both X11/Xorg and native Wayland. Electron 42's Ozone
  selection defaults to `auto` on Linux. On a Wayland session, users can force
  XWayland with `pilotdeck-desktop --ozone-platform=x11` if a compositor-specific
  problem occurs. Do not force X11 for everyone.
- Background: closing the window hides it when the desktop tray is available.
  Ubuntu's top-panel AppIndicators host shows the menu to reopen or quit;
  launching the application again also restores the running window. If the
  tray cannot be created, closing the last window exits normally.

## Local validation

Both `.deb` packages were built in isolated Ubuntu 22.04 user spaces with glibc
2.35. The arm64 user space ran natively on the Ubuntu arm64 VM; the amd64 user
space ran through QEMU user emulation on that VM. Both packages installed with
`apt`, passed `desktop-file-validate`, and ran bundled Node.js plus
`better-sqlite3`, `bcrypt`, `sharp`, and `node-pty` (including a PTY spawn).
The packaged Electron executable, bundled Node.js, and Linux `.node` files have
no GLIBC symbol requirement above 2.34.

For the updater, both Ubuntu 22.04 user spaces built local `2026.928.0`
packages from this branch. Their packaged `electron-updater` modules loaded
successfully; `latest-linux.yml` and `latest-linux-arm64.yml` matched the
respective DEBs' sizes and SHA-512 hashes. The updater's DEB install command
upgraded an installed `0.1.0` package to `2026.928.0` with `dpkg` on both
architectures (amd64 under QEMU). The live Latest Release check correctly
reports `noCompatibleInstaller` on both Linux architectures because the
published release has no Linux assets. The full HTTPS download, desktop
PolicyKit dialog, and automatic relaunch await a published Linux release.

The installed arm64 package now shows its native File/Edit/View/Go/Help menu
under both Xorg and Wayland; an Xorg mouse click opened the File dropdown.
The launcher icon is installed at `hicolor/256x256/apps`, and GTK resolved
`pilotdeck-desktop` to that PNG in both the 22.04 user space and the full
Ubuntu 26.04 GNOME VM. The full VM showed the icon in the Dock and the Chinese
application menu. The earlier `1024x1024` icon path was absent from Jammy's
hicolor theme index.
The installer now keeps the `.desktop` launcher readable even when the build
shell has a restrictive umask. A normal VM user launched the rebuilt DEB from
its desktop entry, and the Dock displayed the PilotDeck icon. The Linux package
smoke explicitly checks launcher and icon read permissions.

The `2026.928.1` arm64 test DEB was installed in the full Ubuntu 26.04 GNOME
Wayland VM. Its PilotDeck indicator appeared in the top panel beside the
network icon, and its right-click menu showed **Open main window** and **Quit**
in Chinese. A left click on Ubuntu's AppIndicator also opened this menu.
Closing the main window left the indicator, Electron process, and
managed Node process running. The menu restored the same window. Quit showed
the localized confirmation; Cancel kept the app running, and confirming Quit
removed the process and indicator. The same indicator interaction still needs
a full Xorg GNOME session check on Ubuntu 22.04.

The same installed test DEB was then started with `--ozone-platform=x11` in
that GNOME Wayland session. Its process and renderer reported the X11 Ozone
path, and the window used XWayland. Closing the window kept the top-panel icon
visible; its right-click menu remained accessible, and **Open main window**
restored the window. **Quit** showed the same confirmation dialog, and
confirming it removed the Electron process and status icon. This checks the
XWayland path, not a full Xorg login.

A new arm64 DEB built in the Ubuntu 22.04 user space was opened in the full
Ubuntu 26.04 GNOME Wayland session. Its native window controls and the five
application menus share one 40px title-bar row; the separate system title bar
and menu row are gone. The same layout rendered through forced XWayland. A
saved Chinese and dark appearance showed Chinese menu captions and matching
dark title-bar controls. An initial native GTK File popup stayed light when the
app was dark and the system GTK theme was light. Changing GTK_THEME after
startup did not update GTK. Linux now renders the popup in the application
window from the same current menu template, while Electron keeps the native
menu registered for accelerators. This avoids an environment-specific theme
override. The isolated Electron chrome smoke suite passed under Ubuntu 22.04
Xvfb/X11 and headless Weston/Wayland, checking all five captions, menu action
dispatch, keyboard navigation, Chinese/English menu entries, and immediate
light/dark popup changes. The headless 22.04 environment lacks Chinese fonts,
so visual glyph acceptance relies on the full GNOME session; these tests do
not replace the remaining full 22.04 desktop checks below.

The rebuilt arm64 DEB was reinstalled in the Ubuntu 22.04 user space after the
popup change. The launcher, icon, bundled native modules and packaged updater
passed validation; the installed app started and served its UI under both X11
and Wayland. The full Ubuntu 26.04 GNOME VM retained its installed test app;
opening a second isolated app instance made Parallels' screen capture black,
so a full GNOME visual check of the new popup is still pending. The interactive
popup was visually inspected from both X11 and Wayland smoke screenshots.

| Environment | Display path | Result |
| --- | --- | --- |
| Ubuntu 22.04 arm64 user space | Xvfb/X11, `--ozone-platform=x11` | Installed app rendered onboarding in an X11 screenshot; local HTTP server returned 200. |
| Ubuntu 22.04 arm64 user space | Xorg 1.21 with the dummy video driver, `--ozone-platform=x11` | Installed app rendered onboarding in an Xorg screenshot; local HTTP server returned 200. |
| Ubuntu 22.04 arm64 user space | Weston 9 headless native Wayland, forced and default Ozone selection | Installed app rendered onboarding in compositor screenshots; local HTTP server returned 200. |
| Ubuntu 22.04 amd64 user space under QEMU | Xvfb/X11, with and without disabled GPU flags | Package and native modules passed, but emulated Electron failed to start its GPU process and exited. This does not validate native x64 display support. |

These user spaces use the Ubuntu 26.04 VM kernel and are not full Ubuntu 22.04
GNOME login sessions. The Xorg dummy driver and headless Weston have no GPU
access; Weston has no keyboard seat. The minimal font set lacks Chinese glyphs.
Full 22.04 desktop acceptance is still required, especially native amd64 Xorg
and Wayland.

Earlier validation used an arm64 package built on Ubuntu 24.04: it rendered on
X11 and Weston Wayland there, and on native Wayland, XWayland, and Xvfb/X11 in
the full Ubuntu 26.04 arm64 GNOME VM. That package is separate from the 22.04
builds above. An arm64 package built on Ubuntu 26.04 required `GLIBC_2.42` in
`node-pty`, demonstrating why newer build hosts cannot establish 22.04 support.

## Before enabling Linux releases

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
[GitHub hosted runner labels](https://docs.github.com/en/actions/reference/runners/github-hosted-runners),
[Ubuntu 22.04 runner retirement](https://github.com/actions/runner-images/issues/14254).

RPM packages for the RHEL family are described in [RPM desktop support](redhat-desktop-support.md).
Their build baseline and update feeds are separate from these Ubuntu DEBs.
