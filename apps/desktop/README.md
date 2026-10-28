# PilotDeck Desktop

Electron desktop shell for the existing PilotDeck Web UI and local gateway runtime.

## Notifications

**Settings > General > Notifications** controls system notifications, the default
notification sound, app icon counts, and message previews. Desktop preferences
are saved on this device. Banners and sounds also follow OS permission and
Do Not Disturb settings; the settings card links to the native notification
settings and provides instructions if the desktop environment cannot open them.

Completion, approval requests, questions, and terminal errors generate one
reminder per event. A conversation contributes at most one to the badge count;
viewing it clears that reminder without approving an operation or answering a
question. The visible, focused conversation is quiet. Connection loss lasting
15 seconds reminds only for running conversations. Automatic model retries and
user cancellation do not notify.

Desktop notifications rely on the OS application identity icon; no additional
content image is attached on macOS, Windows or Linux.

macOS uses Dock badges. Windows uses taskbar overlays; Windows and Linux tray
icons also show counts while the main window is hidden. Linux launcher badges
depend on the desktop's LauncherEntry support. Clicking a notification restores
the existing window and opens its conversation.

The web app uses browser notifications on HTTPS/localhost. With browser
permission and a reachable Web Push service, reminders can also arrive while
the page is closed. Browser tabs display the count in the title; installed PWAs
use app badges where supported. Service Worker storage deduplicates live and
push delivery and preserves pending reminders. Read state is local to each
browser/device.

## Development

```bash
pnpm install --frozen-lockfile
pnpm --filter pilotdeck-desktop dev
```

The desktop process starts the existing PilotDeck gateway and UI server as local
child processes, then opens the packaged Web UI inside an Electron window.

## Background behavior and quitting

On macOS, the red close button and **File > Close Window** (`Cmd+W`) hide the
main window without destroying it. Tasks continue, and the same interface is
restored by clicking the Dock icon or choosing **Open main window** from the
PilotDeck status icon at the top of the screen. Full-screen windows leave their
Space before hiding. Minimizing and `Cmd+H` retain their native behavior. The Dock
icon remains available even if the status icon cannot be created.

The status icon menu, Dock **Quit**, application **Quit PilotDeck**, and `Cmd+Q`
share one native confirmation dialog. Cancel is the default. Confirming stops
the managed server, gateway and task processes before exiting. If cleanup fails,
the window reappears with an error and quitting can be retried. Menus and the
confirmation follow the application language. The status icon uses a monochrome
template image for light/dark menu bars, with a Retina representation.

This does not prevent sleep or change power management. System shutdown and
update installation bypass the user confirmation; update failure restores the
runtime and normal quit protection.

### Windows

Closing the main window (including Alt+F4) hides it in the Windows notification
area and keeps the local runtime and tasks running. Click the PilotDeck tray icon
or choose **Open main window** to restore the same window and its current state.
Launching the client again also restores the existing instance.

The tray's **Quit** command and **File > Exit** restore the main window and show
an owned confirmation dialog. Cancel is the default. Confirming stops the managed
runtime before the application exits; automatic updates use their existing quit
path without a second confirmation. Tray menus and confirmation text follow the
application language.

### Ubuntu

Closing the main window keeps the app and local tasks running when a system tray
is available. The PilotDeck icon in Ubuntu's top panel opens a native menu with
**Open main window** and **Quit**. Select **Open main window** to restore it.
Quit asks for confirmation and stops managed tasks. Launching PilotDeck again
restores the existing window instead of starting another runtime. If creating
the tray icon fails, closing the window quits normally so it is not stranded
in the background. The desktop environment must provide a status icon host,
such as Ubuntu's AppIndicators extension, to show the top-panel icon.

Run `node --test apps/desktop/scripts/desktop-lifecycle.test.mjs` from the repository
root for the cross-platform controller checks. On macOS or Windows,
`node apps/desktop/scripts/verify-desktop-lifecycle.cjs` exercises the production
main process with real Electron windows and isolated server/gateway/task
processes. It covers hiding during startup, state-preserving restoration,
minimization, native macOS full screen, native quit dispatch, cancellation,
cleanup failure/retry, startup quit, update preparation/recovery and shutdown.
Windows also checks second-instance restoration. Dialog responses, update
handoff and shutdown events are simulated; the test never installs an update or
shuts down the host. Each scenario uses its own profile/configuration, and owned
process trees are cleaned even if an assertion fails.

The Windows release workflow also accepts the existing
`verify-windows-tray.cjs` entry point. Mac lifecycle checks run in Desktop Smoke
and both architecture-specific release builds. For manual validation of OS entry
points, check the actual red close button, `Cmd+W`, Dock click/right-click Quit,
status menu Open/Quit and `Cmd+Q`; cancel once, then confirm with a task running.
For an isolated native-dialog session, run
`node apps/desktop/scripts/verify-desktop-lifecycle.cjs manual` (five-minute timeout).
Confirm that restoring retains the draft and that quitting leaves no managed
runtime processes. Check the status icon in both light and dark menu bars.

Regenerate status icons from the checked-in SVG with
`node apps/desktop/scripts/rebuild-tray-icon.mjs`.

## Packaging

```bash
# Run the command matching the Mac host architecture:
pnpm --filter pilotdeck-desktop dist:mac:arm64
pnpm --filter pilotdeck-desktop dist:mac:x64
# On a native Windows host with the matching CPU architecture:
pnpm --filter pilotdeck-desktop dist:win:x64
pnpm --filter pilotdeck-desktop dist:win:arm64
# On a native Ubuntu host with the matching CPU architecture:
pnpm --filter pilotdeck-desktop dist:linux:arm64
pnpm --filter pilotdeck-desktop dist:linux:x64
# On Rocky Linux 9 with the matching CPU architecture and system FPM:
USE_SYSTEM_FPM=true pnpm --filter pilotdeck-desktop dist:linux:rpm:arm64
USE_SYSTEM_FPM=true pnpm --filter pilotdeck-desktop dist:linux:rpm:x64
```

Build DEB release packages on Ubuntu 22.04 LTS for the intended minimum
version. Native modules compiled on newer Ubuntu releases may require a newer
glibc and will not run on 22.04. A 4 GB build VM may need
`NODE_OPTIONS=--max-old-space-size=2560` for the Web UI build. Linux packages
use the system Git package and include a bundled Node.js runtime.
See [Ubuntu desktop support assessment](../../docs/ubuntu-desktop-support.md)
for the X11, Wayland, and XWayland test matrix and remaining release gates.

RPMs use Rocky Linux 9 containers for the RHEL 9 glibc baseline. See
[RPM desktop support](../../docs/redhat-desktop-support.md) for installation,
updates and the RPM validation matrix.

Platform release builds should run on matching GitHub Actions runners:

- macOS arm64 DMG artifacts on `macos-latest`
- macOS x64 DMG artifacts on `macos-15-intel`
- Windows x64 NSIS installer artifacts on `windows-latest`
- Windows ARM64 NSIS installer artifacts on `windows-11-arm`
- Ubuntu x64 DEB artifacts on `ubuntu-22.04`
- Ubuntu arm64 DEB artifacts on `ubuntu-22.04-arm`
- RPM x64/ARM64 artifacts in Rocky Linux 9 containers on the same native runners

PR checks and releases share the Linux, macOS and Windows workflows. Linux
includes DEB/RPM builds, installation and X11/Wayland checks within each package
job for both architectures; macOS PRs build ad-hoc signed application directories,
while releases require Developer ID signing and notarization. Windows runs
installer lifecycle checks and verifies
the packaged Electron, Node, Git and native modules on each native runner.
Portable Git's MSYS Bash may use x64 emulation on Windows ARM64.

For Linux-only acceptance, manually run the `Linux` workflow
(`desktop-linux.yml`) on the branch under test and select `arm64`, `x64` or
`all`. Manual runs default to native ARM64 and execute both DEB and RPM jobs,
including installation, RPM upgrade, native modules, updater and X11/Wayland
GUI checks. Installers and GUI screenshots are retained as Actions artifacts;
this workflow does not publish a release. PR and release callers still default
to both architectures.

Release installer filenames retain the existing
`PilotDeck-<version>-<os>-<arch>` pattern. Windows installers end in `-setup.exe`.
Windows x64 continues to use `latest-x64.yml`; ARM64 uses `latest-arm64.yml`.
Publication requires all ten installers and eight separate update feeds, with
matching versions, architectures, package types, sizes and checksums.

macOS CI signs and notarizes release artifacts when the repository provides
these GitHub Secrets:

- `MACOS_DEVELOPER_ID_APPLICATION_P12_BASE64`: base64-encoded `.p12` for
  a valid `Developer ID Application` certificate.
- `MACOS_DEVELOPER_ID_APPLICATION_PASSWORD`: the `.p12` export password.
- `MACOS_KEYCHAIN_PASSWORD`: optional password for the temporary CI keychain.
- `APPLE_ID`: Apple account email used for notarization.
- `APPLE_APP_SPECIFIC_PASSWORD`: Apple app-specific password for notarization.
- `APPLE_TEAM_ID`: Apple Developer Team ID.

CI release builds fail closed when signing credentials are absent. Local macOS
development packages may still use ad-hoc signing.

Each packaging script stages one architecture-matched, production-only runtime
in `.runtime/app` before calling `electron-builder`; the final app should not
include the other macOS architecture or the workspace development dependency
tree.

Linux packaging and chrome smoke tests prepare the installed Electron version
through `scripts/prepare-electron.mjs`. The default download source is the
official Electron release; `PILOTDECK_DESKTOP_DOWNLOAD_MIRROR=china` selects
`https://cdn.npmmirror.com/binaries/electron/` with version directories without
the `v` prefix. Explicit Electron mirror configuration (including npm config
variables) takes priority over the China preset; the version directory follows
the selected mirror unless `ELECTRON_CUSTOM_DIR` or its npm equivalent is set.
Downloads automatically honor `HTTP_PROXY`, `HTTPS_PROXY` and `NO_PROXY`
(including lowercase variants), without requiring `ELECTRON_GET_USE_PROXY`.
Set `electron_config_cache` to reuse a task-local archive cache. Preparation
reuses an extracted distribution with the matching version and architecture,
retries downloads up to three times, and applies 15-second connection,
60-second idle and 15-minute total timeouts to each download. Linux packaging
passes this distribution to electron-builder via `electronDist`.

See [`docs/release.md`](../../docs/release.md) for the daily
release policy, required GitHub Secrets, manual recovery, and Web deployment
compatibility guarantees.

## Window chrome and application commands

macOS keeps native traffic lights in the sidebar's 48px top strip. The main
header extends to the window edge. Collapsing the sidebar, entering compact
mode or opening Settings reserves a full-width strip; fullscreen removes it.
Windows and Ubuntu use a 40px title-bar overlay with native caption buttons,
putting the application menus and window controls on one row. The caption
has a neutral light/dark background; the main interface keeps its original sidebar
gradient, layout, rounded frame, borders and viewport gutter.
File, Edit, View, Go and Help open the corresponding menu sections; Alt+F/E/V/G/H
access them directly. F10 opens the application menu on Windows and the File
section on Linux, including in fullscreen. Tab and arrow keys navigate caption
buttons. Menu clicks preserve the editor selection. While a popup is open,
hovering or clicking another caption menu switches directly to it. Windows uses
native submenus and tracks the native cursor while they are open. Linux renders
the popup from the same current application menu template inside the window;
the native menu remains registered for keyboard accelerators and OS integration.
Its drag region reserves the native controls' area through
the Window Controls Overlay geometry; the workspace header also supports dragging.
Alt does not reveal a duplicate system menu row. Windows fullscreen state is
published after the native transition updates, removing/restoring the top inset.
All three platforms retain native frames, resizing and shadows. macOS removes the Web
viewport's extra gutter, border, rounded corners and shadow. Windows and Ubuntu reserve
space for the caption; business components and browser/PWA styles are preserved.
The caption is preload-owned, so it also works during startup and onboarding.
Caption labels initialize from the saved desktop language and follow the UI's
resolved i18n language immediately, together with the native application menu.
The caption, Linux popup and Electron native theme follow the app's
light/dark/system preference immediately. The Linux popup does not depend on a
particular GTK theme, panel extension or desktop environment, so the same menu
code applies on Ubuntu, Kylin, Deepin and UOS when their Electron and package
dependencies are compatible. Distribution-level installation and tray behavior
still require testing on each target desktop. Opaque surfaces are intentional;
this implementation does not require vibrancy or Mica.

The native menu routes New Conversation, New Project, Settings, Find, sidebar
visibility, Conversation, Project Files, Skills, Scheduled Tasks and Check for
Updates to their existing UI owners. App actions are disabled before the shell
is ready and while a modal blocks navigation. Reload/renderer failure clears the
native state, and the renderer rechecks context when a command arrives.
Find menu state uses the same registered, visible target and focused-surface
resolver as the Find shortcut; an empty Files page does not enable it. A new
conversation uses the same project inheritance as the sidebar button. Updates
open Settings > About and use the existing check and installation UI.

Default shortcuts: Cmd/Ctrl+N (conversation), Cmd/Ctrl+Shift+N (project),
Cmd/Ctrl+, (settings), Cmd/Ctrl+F (focused-surface find), Cmd/Ctrl+B (sidebar),
Cmd/Ctrl+R (reload), plus the native edit, zoom and fullscreen commands. Find and
sidebar shortcuts reach the renderer so editors/terminals keep their own keys.
Help opens the public documentation and GitHub issues in the system browser;
Copy Version Information includes version, OS/architecture, Electron and build
commit, without logs or project paths. Existing close/quit safeguards still apply.

### Chrome verification

Use Node 22, then run:

```bash
pnpm --filter pilotdeck-desktop compile
pnpm --dir ui exec vitest run server/services/desktopChrome.test.ts server/services/windowsCaptionMenu.test.ts server/services/desktopApplicationMenu.test.ts src/components/desktop/useDesktopCommands.test.tsx src/contexts/FindShortcutContext.test.tsx
```

On macOS or Windows, start an isolated UI development server in a separate terminal:

```bash
pnpm --dir ui exec vite --host 127.0.0.1 --port 5187 --strictPort
node ui/e2e/desktop-chrome.smoke.mjs
```

On Ubuntu 22.04, run the same smoke suite under both X11 and a headless Wayland
compositor with `bash apps/desktop/scripts/run-linux-chrome-smoke.sh x11` and
`bash apps/desktop/scripts/run-linux-chrome-smoke.sh wayland`. It verifies the
single-row caption, menu commands, Chinese/English labels in the caption and
Linux popup, and light/dark menu colors. The Linux CI job runs both display
paths on x64 and arm64 before PR merge and in the daily release pipeline.

The smoke host uses the real compiled preload and application UI with a temporary
Electron profile and mocked API/WebSocket traffic. It does not start the real
runtime or send model requests. It invokes native menu callbacks to check commands,
project inheritance, dialog blocking, sidebar collapse, repeated update checks,
light/dark appearance, native fullscreen transitions and traffic-light position,
and minimize/restore. Windows checks native popup requests; Linux checks its
interactive popup contents and live theme/language updates. Both check
caption/sidebar colors, control safe area and fullscreen inset restoration.
Windows additionally checks maximize/restore; the headless Linux compositors
have no window manager to verify maximize behavior.
Set `PILOTDECK_CHROME_SCALE` to `1`, `1.25` or `1.5` for Windows scaling checks.
Screenshots go to `outputs/desktop-chrome-review` (override
with `PILOTDECK_CHROME_ARTIFACTS`). Run the lifecycle suite above as well when
changing the main process.

Windows native acceptance needs a Windows host: check menu keyboard
navigation/F10, all three caption buttons, double-click maximize/restore, edge
resizing, Snap Layouts, 100%/125%/150% scaling, fullscreen and light/dark/system
appearance. On macOS, manually check native menu accelerators, titlebar dragging and the system's configured
double-click action, including controls/popovers overlapping the header.

## Windows signing (EXE installers)

Windows packaging loads `electron-builder.config.cjs`. On a configured Windows
machine, `pack` and every `dist:win*` command automatically sign the PilotDeck
application, installer payload helper, NSIS uninstaller, and final installer or
portable EXE. Bundled third-party executables retain their original signatures.
Every signature uses SHA-256 and an RFC3161 timestamp, then passes SignTool
`verify /pa /all` and a certificate thumbprint/publisher/timestamp check.
Signing errors stop packaging. The updater receives the expected publisher name.

For local Certum SimplySign signing, log in to SimplySign Desktop under the same
Windows account that runs the build. DSignTool is an optional manual UI; automated
builds call Microsoft's Windows SDK SignTool directly. No PFX export is needed.
Create `%LOCALAPPDATA%\PilotDeck\build-signing.json` with public metadata only:

```json
{
  "certificateSha1": "YOUR_40_CHARACTER_CERTIFICATE_THUMBPRINT",
  "publisherName": "EXACT_CERTIFICATE_COMMON_NAME",
  "signToolPath": "C:\\Program Files (x86)\\Windows Kits\\10\\bin\\SDK_VERSION\\x64\\signtool.exe",
  "timestampServer": "http://time.certum.pl"
}
```

Do not put a PIN, OTP seed or private key in this file or the repository.
`PILOTDECK_WINDOWS_SIGNING_CONFIG` selects another local config file.
`PILOTDECK_WINDOWS_CERT_SHA1`, `PILOTDECK_WINDOWS_PUBLISHER` and `SIGNTOOL_PATH`
override individual values. `PILOTDECK_WINDOWS_SIGNING=required` rejects missing
configuration; `off` explicitly produces an unsigned development build. Without
configuration, `auto` keeps the existing unsigned build behavior. A present but
invalid config fails rather than silently producing unsigned output. These
settings do not change macOS/Linux packaging. SimplySign may require a fresh login
before a later build; signing does not make its desktop session permanent.

```powershell
pnpm --filter pilotdeck-desktop run dist:win:x64
node apps/desktop/scripts/windows-signing.cjs verify PATH_TO_SETUP_EXE
```

### GitHub hosted runner option

The Windows workflow supports an opt-in cloud backend using the independent
[ssign client](https://github.com/Le-Syl21/ssign). It does not need a self-hosted
runner or an online desktop PC. `setup-cloud-signing.ps1` pins v0.1.8 and the ZIP's
SHA-256 digest; this version includes the Certum EV intermediate certificate fix.
This is not a Certum-supported integration. A successful local SignTool test does
not validate the cloud client; complete a real cloud build before enabling daily
release signing.

Repository administrator setup:

1. Create the GitHub Environment `windows-signing`, restrict its deployment
   branches to `main`, and add required reviewers if each signature needs approval.
2. Add environment secrets `CERTUM_EMAIL` (SimplySign login) and `CERTUM_OTP`
   (the long-lived base32 TOTP seed or complete `otpauth://` URI from the activation
   QR backup, **not** a current six-digit code). Enter these directly in GitHub;
   never put them in chat, workflow inputs, command arguments or build artifacts.
3. Add environment variables `WINDOWS_CERT_SHA1` and `WINDOWS_PUBLISHER` matching
   the certificate. Both are public metadata. For certificate renewal, update the
   thumbprint and repeat the cloud test; retain the publisher if its CN is unchanged.
4. After the workflow changes are on `main`, run **Windows Signing Check** for a
   small real signature/verification probe, then run the **Windows** workflow
   with `require_windows_signing=true`. It builds both native architectures, signs
   each EXE before generating updater hashes, and fails on invalid signatures.
5. Only after that succeeds, set the repository variable
   `PILOTDECK_WINDOWS_SIGNING_ENABLED=true`. Daily Release then requires the signed
   Windows job to succeed. Until enabled, existing daily Windows builds remain
   unsigned. Manual Desktop Build also exposes `require_windows_signing`.

An activation QR backup must contain the actual TOTP seed/`otpauth://` URI for
this client. An activation URL alone is not sufficient; do not upload the QR image
to an online decoder. Confirm the backup format locally before configuring CI.

Only trusted `main` runs in `OpenBMB/PilotDeck` may request signing. Dependencies,
tests and runtime compilation run before signing secrets are injected. The two
architecture jobs are serialized when signing to avoid consuming one TOTP twice.
Credentials are scoped to the packaging step, and its temporary session cache is
removed even on failure; it must never be cached/uploaded. Signatures are checked
with Microsoft's verifier and must match the configured certificate. ssign v0.1.8
selects the first cloud card; accounts with several cards require a client with
explicit certificate selection before use. The TOTP seed grants signing authority,
so GitHub access to the environment must be controlled accordingly.

Linux package signing is separate: RPM and APT repository signing use OpenPGP/GPG
keys. This Authenticode certificate cannot be substituted for those keys. Running
ssign on Linux signs Windows PE files, not Linux DEB/RPM packages. See
[Certum's SignTool instructions](https://files.certum.eu/documents/manual_en/CS-Code_Signing_in_the_Cloud_Signtool_jarsigner_signing.pdf),
[RPM signing](https://rpm.org/docs/6.1.x/man/rpmsign.1) and
[APT authentication](https://manpages.debian.org/unstable/apt/apt-secure.8.en.html).
