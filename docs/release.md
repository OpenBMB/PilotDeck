# PilotDeck releases and desktop builds

PilotDeck keeps Web and desktop sources on `main`. The desktop application is a
thin Electron shell around the same gateway and Web UI; desktop-specific runtime
behavior is enabled only when Electron sets `PILOTDECK_DESKTOP=1`.

## Web compatibility

- The existing root and `ui` build commands remain the source of the Web build.
- Docker installs only the root and UI workspace dependencies, so Electron and
  its native packaging dependencies are not installed in the Web image.
- Browser deployments never receive the Electron preload bridge.
- Desktop runtime files live under `apps/desktop` and are ignored by the Docker
  build context.
- Desktop runtime production dependencies use the dedicated manifest and frozen
  lockfile under `apps/desktop/runtime`; Web installs do not include this package.

Pull requests that touch shared, UI, Docker, or desktop code run the Web
regression workflow. Desktop-related pull requests also compile and test the
desktop shell.

The Web test job temporarily excludes `ui/e2e/**` (Playwright tests are not
Vitest tests) and the upstream `streamSmoother.test.ts` fake-timer test. Both are
known baseline failures; all other UI/server tests remain in the merge gate.

## Daily release policy

`.github/workflows/release.yml` runs every day at 02:00 Asia/Shanghai
(18:00 UTC on the previous calendar day). It compares `main` with the commit in
the latest unified release tag:

- no production change: skip the release;
- production change: build signed and notarized macOS arm64 and x64 installers
  plus an unsigned Windows installer, then publish one dated GitHub Release;
- repeated manual release on the same date: use `-r2`, `-r3`, and so on.

Release names and tags are `vYYYY.MM.DD`, for example `v2026.09.07`.
Additional releases on that date use `v2026.09.07-r2`, `-r3`, and so on.
The internal Electron version remains a numeric SemVer derived from the same
Shanghai date: `v2026.09.07` maps to `2026.907.0`, and `-r2` maps to
`2026.907.1`. GitHub Actions may also be started manually with an optional
zero-based release revision. An explicitly requested existing tag is rejected.

Each release shares one exact `main` commit across the tag, desktop installers,
and Web source code:

- Assets: macOS arm64 and x64 DMGs and update ZIPs, the Windows installer,
  architecture-specific update feeds, `release.json`, and `SHA256SUMS.txt`.
- Web source: GitHub's automatically provided **Source code (zip)** and
  **Source code (tar.gz)** archives for the release tag. No separate Web archive
  or prebuilt deployment package is uploaded; source deployments still install
  dependencies and build the application.
- `release.json`: the numeric version, tag, release date, metadata generation
  time (`buildTime`), source commit (`sourceSha`), repository, and installer
  sizes, platforms, architectures, and SHA-256/SHA-512 checksums. `SHA256SUMS.txt`
  covers the uploaded installers, not GitHub-generated source archives.

Release detection considers Web, Gateway, desktop, shared runtime, and Docker
files. Changes limited to `docs/` or root README files skip the release unless
`force` is enabled.
Only the new `vYYYY.MM.DD[-rN]` tags are considered; historical `desktop-v` tags
are not used as a baseline, so the first unified release builds automatically.

Build scripts use `PILOTDECK_RELEASE_DATE`, `PILOTDECK_RELEASE_REVISION`,
`PILOTDECK_RELEASE_VERSION`, `PILOTDECK_RELEASE_TAG`, and
`PILOTDECK_RELEASE_BUILD_TIME` for release metadata. Desktop runtime environment
variables remain separate from these build-time inputs.

Publishing and packaged repository metadata use the repository running the
workflow. Upstream builds publish to `OpenBMB/PilotDeck`; fork builds publish to
their own repository.

Web and desktop updates both read these unified releases. See
[Web updates](web-update.md) for supported Git deployments.

## Desktop updates

The client checks stable, non-draft `vYYYY.MM.DD[-rN]` releases in its packaged
repository (or `PILOTDECK_UPDATE_REPOSITORY` override). It validates `release.json`
against the release tag, numeric version, repository, source commit format, and
published installer names and sizes. The newest release is compared numerically
with Electron's `app.getVersion()`: only a higher version offers an update.
Equal or older releases never trigger a downgrade. Release allocation uses the
largest existing revision for the date plus one, including manually skipped
revisions, and rejects a manually requested version below any published version. Historical `desktop-v` tags
and filename-based version guessing are not supported.

Automatic update selection requires an exact platform and running-client architecture:

| Client | Update payload | Feed |
| --- | --- | --- |
| macOS arm64 | arm64 ZIP | `latest-arm64-mac.yml` |
| macOS x64 (including Rosetta) | x64 ZIP | `latest-x64-mac.yml` |
| Windows x64 | x64 setup EXE | `latest-x64.yml` |

DMGs remain available for initial Mac installation. Each Mac build produces its
own feed, renamed before artifact upload so the matrix jobs cannot overwrite one
another's metadata. Each feed contains only its own architecture. CI verifies all
three feeds and both ZIPs before publishing. Full downloads are used initially;
blockmaps and differential updates are not required.

**Update and restart** is one explicit user action. The Electron main process
uses the shared release discovery module, then pins electron-updater's generic
feed to that exact GitHub Release tag. It checks the feed version, file names,
architecture, sizes and SHA-512 hashes against `release.json` before downloading.
Electron-updater verifies the downloaded payload; the client also verifies its
SHA-256 before stopping the gateway and Web server. Finally it invokes the
updater to install and relaunch the application. macOS performs native signature
verification; Windows may show an administrator approval prompt because our
NSIS installer is per-machine. Both the interactive installer and silent
`--force-run` updates launch via the existing `explorer.exe` workaround.
Before installation, runtime shutdown confirms that managed descendants exited;
a failed stop aborts installation and retains process records for recovery.

Release checks, manifests, update feeds and payload downloads share the
`electron-updater` network session. It reads the user's `proxy.url` and
`proxy.noProxy`; proxy environment variables (`PILOTDECK_PROXY`, `https_proxy`,
`HTTPS_PROXY`, `http_proxy`, `HTTP_PROXY`, in that order) take precedence.
Loopback traffic always bypasses the proxy for the local Mac updater. Proxy
settings refresh before checking and remain fixed during an active update.
Without an application or environment proxy, Electron uses system proxy settings.

The updater is a production dependency inside `app.asar`. CI loads it and its
transitive dependencies using the packaged Electron executable, and checks that
Windows includes `elevate.exe`. Normal shutdown continues through `app.quit()`;
the update path stops managed services first and lets the updater own process
exit. It must never short-circuit this with `app.exit()`.

The About page polls Electron IPC, so closing settings or stopping the Web server
does not interrupt the update. Checking and downloading can be cancelled; the
install phase cannot. Download/verification failures leave services running and
allow retry. Installation errors received while Electron is still running
restore the runtime and ask the user to restart the client before retrying.
Closing the client normally does not automatically install a cached update.
Unpackaged development clients cannot install updates.

This capability starts with a client built from this implementation. Clients
that only open DMG/EXE installers need to install this version once before later
releases can update automatically. A release without the required update feed
or matching payload disables the action with an explanation.

Changes to this flow require a real old-version-to-new-version install test on
macOS arm64, macOS x64 (including Rosetta), and Windows x64. Unit and packaging
tests alone do not establish that signing, elevation, replacement and relaunch
work on those systems.

## Required GitHub Secrets

Release builds deliberately fail when macOS code signing or notarization is
unavailable. Windows packaging remains explicitly unsigned, matching the
existing `desktopdev` release behavior.

macOS:

- `MACOS_DEVELOPER_ID_APPLICATION_P12_BASE64`
- `MACOS_DEVELOPER_ID_APPLICATION_PASSWORD`
- `APPLE_ID`
- `APPLE_APP_SPECIFIC_PASSWORD`
- `APPLE_TEAM_ID`
- `MACOS_KEYCHAIN_PASSWORD` (optional)

The macOS jobs run in parallel on GitHub's Apple Silicon `macos-latest` and
Intel `macos-15-intel` images. Each job fails early when the runner architecture
does not match its installer, and verifies the Electron executable, bundled
Node.js, and native runtime modules before uploading the DMG.

The macOS certificate must be a Developer ID Application certificate. The
Windows installer does not require a signing certificate. GitHub's automatic
`GITHUB_TOKEN` is used to publish the Release.

## Manual builds

```bash
pnpm install --frozen-lockfile
pnpm --filter pilotdeck-desktop test
# Run the command matching the Mac host architecture:
pnpm --filter pilotdeck-desktop dist:mac:arm64
pnpm --filter pilotdeck-desktop dist:mac:x64
# Run the following on Windows:
pnpm --filter pilotdeck-desktop dist:win
```

Local macOS builds can use ad-hoc signing. Set
`PILOTDECK_DESKTOP_REQUIRE_SIGNING=1` to enforce production signing locally.

When a root or UI dependency used by the desktop runtime changes, update
`apps/desktop/runtime/package.json`, then refresh its dedicated lockfile with:

```bash
pnpm --dir apps/desktop/runtime install --lockfile-only --ignore-workspace
```

The desktop build fails if the runtime manifest no longer matches the root and
UI manifests, or if its committed lockfile is stale.

## Recovery

If one architecture or platform fails, fix the credential or build issue and
rerun the failed workflow. A release is created only after both macOS DMGs and
the Windows installer are downloaded and verified. For a deliberate additional
release on the same Shanghai date, leave revision empty to select the next
available `-rN` tag automatically.

## Update regression smoke checks

After compiling the desktop main process, run the real Electron networking
check with the installed development Electron binary:

```sh
pnpm --filter pilotdeck-desktop compile
pnpm --filter pilotdeck-desktop exec electron scripts/verify-update-network.cjs
node apps/desktop/scripts/verify-installer.cjs
```

The network check requires OpenSSL and uses a temporary local HTTPS origin and
proxy, without contacting GitHub or installing anything. It covers both config
and environment proxy discovery/download paths, proxy authentication, and loopback bypass. The installer
check downloads the builder's NSIS toolchain if uncached, compiles the launch
paths using the installed templates, and checks that both use `explorer.exe`.
It does not run the generated EXE. Windows elevation/relaunch and signed macOS
cross-version replacement still require real platform upgrade tests.

## Managed process shutdown

Only explicitly launched desktop services and Web update build commands use the
registry and guardian. There is no global Node spawn replacement or inherited
preload. Business commands, plugins, cluster workers and IPC keep their native
process behavior. Command exit is reported independently from guardian cleanup,
so a completed command does not wait for its background processes to finish.

On POSIX, a guardian anchors each command's group until its members finish or
shutdown terminates the group. Creation identities are checked before signals;
a missing or replaced guardian is an explicit cleanup failure. On Windows, an
external PowerShell/C# Job holder assigns the guardian to a non-breakaway Job
before command execution, terminates through the Job handle, and confirms zero
active processes. Runtime restart/installation must not proceed if registration,
identity verification, Job assignment or cleanup cannot be confirmed.
On POSIX the guarantee covers the registered process group, including orphaned
members that retain that group. Arbitrary business tasks that detach into other
sessions/groups are outside this guarantee; this is not a general process sandbox.

`node --test apps/desktop/scripts/process-scope.test.mjs` exercises IPC and
inherited-group cleanup after command exit, plus native Bash background launch
and sibling cancellation behavior on POSIX. Both desktop platform build jobs
run it before packaging.
The Desktop Smoke workflow also runs the native Windows process tests on each
relevant PR. Windows identity lookup uses targeted .NET process queries instead
of CIM enumeration, allowing 15 seconds per query and a bounded 60-second
bootstrap window. Shutdown retains identity checks and native Job termination;
startup failure reports its cause before waiting for application IPC. These
checks do not replace an actual Windows installation/upgrade test.
