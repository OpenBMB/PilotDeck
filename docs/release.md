# PilotDeck releases and desktop builds

PilotDeck keeps Web and desktop sources on `main`. The desktop application is a
thin Electron shell around the same gateway and Web UI; desktop-specific runtime
behavior is enabled only when Electron sets `PILOTDECK_DESKTOP=1`.

## Cron upgrade compatibility

The schedule computation version 3 upgrade changes existing recurring tasks
with two restricted day fields from AND to Unix cron OR matching. These tasks
may run more often. Review affected schedules before upgrading; see
[Cron scheduling and the version 3 upgrade](cron-scheduling.md) for examples
and pending-run migration behavior.

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

The Web test job uses separate client/jsdom and server/Node Vitest projects.
They collect `ui/src` and `ui/server`; Playwright E2E tests use their own runner.
Desktop updater tests run in the Desktop checks job with desktop dependencies.
See [test selection and maintenance](testing.md) for local commands and
guidance on keeping regression coverage focused.

## Daily release policy

`.github/workflows/release.yml` runs every day at 02:00 Asia/Shanghai
(18:00 UTC on the previous calendar day). It compares `main` with the commit in
the latest unified release tag:

- no production change: skip the release;
- production change: build signed and notarized macOS arm64 and x64 installers,
  an unsigned Windows installer, and Ubuntu x64 and arm64 DEBs and RHEL-family x64 and arm64 RPMs, then publish one
  dated GitHub Release;
- repeated manual release on the same date: use `-r2`, `-r3`, and so on.

If the first Daily Release attempt fails only during builds,
`.github/workflows/release-retry.yml` requests one automatic retry of the failed
jobs on fresh runners. Successful platform builds and the original source SHA,
release date, and revision are retained. Publishing proceeds after the retried
builds succeed. Detection failures, publication failures, cancelled jobs, and
second or later attempts are not automatically retried. The retry decision is
recorded in the separate **Retry Release Build** workflow summary; both build
attempts remain visible in the original run. This applies to scheduled and
manually started Daily Release runs once the retry workflow is on `main`.

Each platform upload can replace its own artifact when a failed build is retried,
including when an earlier upload stored the artifact but failed before completing.
Artifacts from successful platform jobs are retained.

Release names and tags are `vYYYY.MM.DD`, for example `v2026.09.07`.
Additional releases on that date use `v2026.09.07-r2`, `-r3`, and so on.
The internal Electron version remains a numeric SemVer derived from the same
Shanghai date: `v2026.09.07` maps to `2026.907.0`, and `-r2` maps to
`2026.907.1`. GitHub Actions may also be started manually with an optional
zero-based release revision. An explicitly requested existing tag is rejected.

Each release shares one exact `main` commit across the tag, desktop installers,
and Web source code:

- Assets: macOS arm64 and x64 DMGs and update ZIPs, the Windows installer,
  Ubuntu x64 and arm64 DEBs and RHEL-family x64 and arm64 RPMs, architecture-specific update feeds, `release.json`,
  and `SHA256SUMS.txt`.
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

Desktop updates read the Latest release manifest directly. The Web About page
shows the local build version and links to GitHub Releases; command-line and IM
updates retain their supported Git deployment policy in [Web updates](web-update.md).

## Desktop updates

The desktop client discovers releases through the official Huawei OBS bucket
and GitHub repository only. Both requests start immediately, in every region;
public third-party proxies are not used. Each route has an 8-second discovery
deadline. After finding an update newer than the installed version, the client
allows 1.2 seconds for peers and chooses the highest valid version received.
If the first response is equal to or older than the installed version, it waits
for the other route's deadline before reporting no update, so a fast stale
mirror does not hide an available update. An unreachable source may still contain
a newer version, which a later check can discover. If neither route succeeds,
both receive one more attempt before the check fails.

OBS uses the website's `PilotDeck/latest.json` pointer, then the immutable
`PilotDeck/<tag>/release.json`; pointer URLs are never trusted as download hosts.
GitHub uses the release explicitly marked **Latest**. Fork builds
and `PILOTDECK_UPDATE_REPOSITORY` overrides never query the official OBS bucket.
The release workflow marks each completed release Latest. The client validates
the manifest's tag, numeric version, repository, source commit format, asset
names, sizes and checksums. That version is compared numerically
with Electron's `app.getVersion()`: only a higher version offers an update.
Equal or older releases never trigger a downgrade. Release allocation uses the
largest existing revision for the date plus one, including manually skipped
revisions, and rejects a manually requested version below any published version. Historical `desktop-v` tags
and filename-based version guessing are not supported.

`release.json` is the canonical release configuration. Its `schemaVersion` remains
`1` for installed clients; additive `artifactSchemaVersion: 1`, `format` and
`roles` fields distinguish initial installers (`install`), updater payloads
(`update`) and generated legacy metadata (`compatibility`). Older JSON manifests
without these fields remain readable. The release job hashes payloads first,
derives all eight YML feeds from those records, then records the feeds' hashes in
the same JSON and checksum file. Builder-generated feeds are replaced, not merged
as a second source of release metadata.

Automatic update selection requires an exact platform and running-client architecture.
New clients read JSON directly; the feed column documents compatibility for older clients:

| Client | Update payload | Feed |
| --- | --- | --- |
| macOS arm64 | arm64 ZIP | `latest-arm64-mac.yml` |
| macOS x64 (including Rosetta) | x64 ZIP | `latest-x64-mac.yml` |
| Windows x64 | x64 setup EXE | `latest-x64.yml` |
| Windows arm64 | arm64 setup EXE | `latest-arm64.yml` |
| Ubuntu x64 | x64 DEB | `latest-linux.yml` |
| Ubuntu arm64 | arm64 DEB | `latest-linux-arm64.yml` |
| RHEL-family x64 | x64 RPM | `latest-rpm-linux.yml` |
| RHEL-family arm64 | arm64 RPM | `latest-rpm-linux-arm64.yml` |

The release download table and OBS website pointer list DMGs for Mac users.
ZIPs remain in the full release assets for native automatic updates, including
old clients; GitHub's raw Assets list still exposes them. CI verifies all ten
payloads and eight generated feeds before publication and again before OBS sync.
New releases also publish the four external `.exe.blockmap` and `.zip.blockmap`
files. They are checksummed compatibility assets, not installer choices; the
eight legacy YML feeds retain their existing shape. Release verification requires
nonempty gzip v2 maps with valid block sizes covering the corresponding payload.
GitHub publication and OBS synchronization include these files before promoting
the release pointer. Older manifests without differential metadata remain valid
for repair and installed-client compatibility.

### Differential downloads and recovery

The additive `release.json` boolean `differentialUpdates: true` enables best-effort
block reuse on Windows NSIS and macOS ZIP updates when the selected architecture
has a checksummed blockmap. Missing/false/unknown capability values, incompatible
maps and Linux DEB/RPM targets retain full downloads. The client still reconstructs
one complete package, verifies SHA-512 and SHA-256, and uses the same native
installer and signature policy. This reduces network transfer, not the staging
space or necessarily the extraction/install time. Shell and runtime versions
remain one release; running files are never patched in place by the downloader.

The pinned electron-updater uses a cached installer (`installer.exe` on Windows,
`update.zip` on macOS) and an old blockmap. Historical map addresses use the same
route's old release tag, including same-day revisions; no remote-supplied host is
accepted. Single Range requests avoid reliance on multipart proxy/CDN support.
Responses must honor the exact range and length. Unsupported Range, unavailable
or malformed maps, missing/corrupt caches, reconstruction checksum failures and
connection deadlines fall back to the full package. An unsuccessful attempt
forces subsequent routes/retries to full download, with version and hashes still
pinned. Cancellation aborts the operation instead of starting fallback downloads.
Download failures do not stop services or install partial packages.

Pause and cancellation cover blockmaps, full transfers and Range requests.
Blockmaps have an 8 MiB compressed/32 MiB expanded limit and a 15-second request
budget; active download connections have a 15-second inactivity deadline.
Pausing suspends those download deadlines. Local block copying is excluded from
the network stall watchdog; verification/installation still waits for Resume.
Local copying may continue while network consumption is paused. Differential
progress reports downloaded bytes, not bytes reused from disk.

The existing OBS retention policy remains unchanged. If a historical map has
expired and is absent from the local cache, full download remains supported.
First updates after enabling this feature may be full, especially on macOS,
where clients that disabled differential downloads did not retain `update.zip`.
Real transfer savings depend on the changed artifacts and must be measured.

To disable differential use for a release, set the repository Actions variable
`PILOTDECK_DIFFERENTIAL_UPDATES=0` before publication (the same environment variable
works for local manifest generation). Maps remain required so disabling the
optimization cannot hide an incomplete build. Publish a new revision to change
this policy; never mutate an immutable release or its checksums. An installed
client can immediately use the full path with
`PILOTDECK_DISABLE_DIFFERENTIAL_UPDATES=1` in its launch environment. These controls
do not downgrade installed applications or roll back user data. Native installer
file rollback and runtime recovery retain their existing platform-specific limits.

### Download and installation lifecycle

**Update and restart** is one explicit user action. The Electron main process
uses the shared release discovery module, then gives electron-updater a custom
provider containing the exact selected JSON payload and release tag. New clients
never fetch a YML update feed. The same version, file name, architecture, size and
SHA-512 hash stay pinned across every route and retry.
Electron-updater verifies the downloaded payload; the client also verifies its
SHA-256 before stopping the gateway and Web server. Finally it invokes the
updater to install and relaunch the application. macOS performs native signature
verification; Windows may show an administrator approval prompt because our
NSIS installer is per-machine. Both the interactive installer and silent
`--force-run` updates launch via the existing `explorer.exe` workaround.
On Ubuntu, the DEB updater asks for PolicyKit authorization to install the
verified package with `dpkg`, then relaunches. The client does not install
updates automatically on quit.
Before installation, runtime shutdown confirms that managed descendants exited;
a failed stop aborts installation and retains process records for recovery.

Release checks, manifests and payload downloads share the
`electron-updater` network session. It reads the user's `proxy.url` and
`proxy.noProxy`; proxy environment variables (`PILOTDECK_PROXY`, `https_proxy`,
`HTTPS_PROXY`, `http_proxy`, `HTTP_PROXY`, in that order) take precedence.
Loopback traffic always bypasses the proxy for the local Mac updater. Proxy
settings refresh before checking and remain fixed during an active update.
Without an application or environment proxy, Electron uses system proxy settings.

Before offering an update, the client samples the selected payload on both
routes, stopping as soon as one works. If neither works within eight seconds,
the new version stays visible with a temporary-unavailability message and a
Check again action. Starting an update rechecks readiness. HTML/error responses,
empty bodies and known size mismatches are rejected. This is a reachability
check, not a guarantee against a later outage; full-download hashes remain required.

Before downloading, the client samples up to 256 KiB of the selected installer
from both routes concurrently, with a 5-second deadline per request and no disk writes.
After the first successful sample, it gives the competitor 150 ms to finish,
then aborts outstanding sampling instead of waiting for the slow route's timeout.
It also aborts the sample if a host ignores Range. Elapsed sample time determines
order. A remembered successful route gets a 100 ms preference when speeds are
similar; without history an exact tie prefers OBS. Failed or unfinished probes
remain fallbacks for transient network failures. A server rejecting Range with
400/405/416 gets one bounded plain GET attempt; it still stops after 256 KiB.
There is no IP geolocation or language-based region assumption: actual network
conditions, including the configured proxy, determine the choice each time.

Daily Release calls the reusable OBS synchronization workflow immediately after
GitHub publication, passing the exact tag rather than rediscovering Latest.
Manual and scheduled repair runs remain available. OBS uploads and verifies all
assets (including YML and ZIP), then promotes `latest.json` last. A delayed older
job cannot move the pointer backwards; conflicting bytes under an existing tag
require a new revision. GitHub can become visible before OBS finishes; clients
fall back to GitHub for that same version. Sync failure leaves the old OBS pointer
intact unless publication itself failed ambiguously, in which case the saved
pointer and readback evidence support manual recovery.

Keep generating YML while supported installed clients need it. Once those clients
are retired, remove compatibility generation and its publication gate together;
new clients require no protocol change. The builder's local `app-update.yml`
is library/cache configuration, not a second remote release manifest, and stays.

Only a fully downloaded and verified package records route success. The client
atomically saves the repository, official route ID and success timestamp in
`update-route.json` under Electron's user-data directory. This preference survives
restarts for seven days, contains no credentials or remote-supplied URLs, and is
discarded on that route's download/feed/verification failure. Cancellation does
not record success or penalize a route. Unknown IDs, different repositories,
expired/future timestamps and unreadable caches are ignored; inability to save
the cache never prevents updating. Every download still samples both routes so
network changes, travel or a different VPN can override the previous preference.

Feed requests have a 15-second deadline, including redirects and response bodies.
Feed, network and checksum failures advance to the next route. After trying all
routes, one final round retries them. Thirty seconds without progress triggers
a switch; the first round also switches below 32 KiB/s sustained throughput.
The final round accepts slow progress so slow local connectivity still works.
The watchdog counts actual payload bytes in the download transport, independently
of progress events or Content-Length, so healthy chunked responses are not cancelled.
Pausing suspends this watchdog and prevents switching until Resume; cancellation
stops probing/downloading and never starts another route or installs. Switching
restarts the payload and its progress from zero; bytes from different routes are
not combined. Every attempt validates against the originally selected manifest.
Installation is invoked only after a complete verified download.

Routing is internal. The update UI retains its existing check/download/pause/
verify/install states, byte counts and speed; it shows no source names, mirror
selector, URLs or raw network errors. Manifest hashes detect corruption and
inconsistent packages. Existing native installer signature policy remains in
effect. Web/CLI source-deployment discovery and installation are unchanged.

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
that only open DMG/EXE installers, and the earlier Ubuntu `0.1.0` test packages,
need to install this version once before later
releases can update automatically. A release without the required update feed
or matching payload disables the action with an explanation.

Changes to this flow require a real old-version-to-new-version install test on
macOS arm64, macOS x64 (including Rosetta), Windows x64, Ubuntu x64, and Ubuntu
arm64. Unit and packaging
tests alone do not establish that signing, elevation, replacement and relaunch
work on those systems.

## Required GitHub Secrets

Release builds deliberately fail when macOS code signing/notarization or Windows
code signing is unavailable. Daily Release always requires the signed Windows
job to succeed before publication; there is no unsigned release fallback.
Configure and validate the [Windows signing environment](#windows-signing)
before releasing. PR CI remains unsigned and does not receive signing secrets.
Passing helper tests or checksum checks does not establish
that a published installer has a valid publisher signature.

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
Windows certificate requirements depend on the signing mode above. GitHub's
automatic `GITHUB_TOKEN` is used to publish the Release. The published-Windows
signature audit checks the actual release payloads independently of build tests.

## Manual builds

```bash
pnpm install --frozen-lockfile
pnpm --filter pilotdeck-desktop test
# Run the command matching the Mac host architecture:
pnpm --filter pilotdeck-desktop dist:mac:arm64
pnpm --filter pilotdeck-desktop dist:mac:x64
# Run the following on Windows:
pnpm --filter pilotdeck-desktop dist:win
# On native Ubuntu 22.04 hosts with matching architectures:
pnpm --filter pilotdeck-desktop dist:linux:x64
pnpm --filter pilotdeck-desktop dist:linux:arm64
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
rerun the failed workflow. A release is created only after both macOS DMGs, the
Windows installer, and both Ubuntu DEBs are downloaded and verified. For a
deliberate additional release on the same Shanghai date, leave revision empty to select the next
available `-rN` tag automatically.

## Update regression smoke checks

After compiling the desktop main process, run the real Electron networking
check with the installed development Electron binary:

```sh
pnpm --filter pilotdeck-desktop compile
pnpm --filter pilotdeck-desktop exec electron scripts/verify-update-network.cjs
pnpm --filter pilotdeck-desktop exec electron scripts/verify-update-download.cjs
pnpm --filter pilotdeck-desktop exec electron scripts/verify-differential-update.cjs
node apps/desktop/scripts/verify-installer.cjs
```

The download check also runs in Windows CI. It uses local HTTP fixtures to test
pause/resume, cancellation, retry and a chunked transfer lasting more than 30 seconds
without Content-Length or upstream progress events; installation is stubbed.

The differential check runs in Windows and macOS CI. It generates blockmaps with
the installed builder and uses real Electron requests and NSIS/Mac updater download
paths against an isolated loopback origin. It requires actual reduced transfer,
byte-identical reconstruction, full fallback for cache/map/Range failures, bounded
stalls and trickling maps, pause/resume, cancellation without installation or
fallback, route switching, kill switches, SHA rejection, injected publisher
rejection and injected `ENOSPC`. The Mac native handoff and installer execution
are intercepted; these tests do not certify Authenticode, macOS signatures,
production CDN/proxies, actual volume exhaustion, or signed installed upgrades.

The network check requires OpenSSL and uses a temporary local HTTPS origin and
proxy, without contacting GitHub or installing anything. It covers both config
and environment proxy discovery/download paths, the GitHub asset redirect,
proxy authentication, and loopback bypass. The installer
check downloads the builder's NSIS toolchain if uncached, compiles the launch
paths using the installed templates, and checks that both use `explorer.exe`.
It uses the builder's template working directory, stdin input, and include
search paths, including a project path with spaces. Custom sibling includes
must resolve from `${PROJECT_DIR}` rather than relying on the current directory.
Desktop and Daily Release share the Windows workflow: both
build the actual NSIS installer, validate the packaged updater and elevation
helper, and require the update feed. PR builds only upload Actions artifacts;
they do not publish a Release.
The installer fixture executes isolated install, upgrade, cancellation and
uninstall flows. Production Windows elevation/relaunch and signed macOS
cross-version replacement still require real platform upgrade tests.

Desktop and Daily Release also share the Linux workflow. Native
Ubuntu 22.04 x64 and arm64 runners each build and install their DEB, validate
the launcher icon and bundled native modules, then start the installed app under
Xvfb/X11 and headless Weston/Wayland. The smoke waits for a responsive Web UI;
the X11 check also verifies that an application window exists. A failed matrix
job blocks its PR check or the daily release. These headless checks do not
exercise a full GNOME session, top-panel indicator interaction, PolicyKit
authorization, or a published-release update and relaunch.

The same Linux workflow builds RPMs on Rocky Linux 9 and verifies installation,
native modules, the updater, and X11/Wayland startup within each RPM job. Linux
checks are grouped by DEB and RPM, each with x64 and ARM64 variants.

The shared macOS workflow builds an ad-hoc signed application directory for PRs
and checks its architecture, signature and packaged updater. PRs do not import
Developer ID certificates, notarize, create DMGs/ZIPs or upload macOS release
assets. Daily Release enables production signing and notarization and requires
the DMG, ZIP and update feed. Only Daily Release's final publish job has release
write permission and creates a GitHub Release. All shared builds check out the
calling event's fixed SHA; callers cannot choose arbitrary source revisions.

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

RPM builds and validation are documented in [RPM desktop support](redhat-desktop-support.md).
The reusable Desktop Smoke / RPM workflow builds both architectures in Rocky Linux 9,
checks installation and native modules on that baseline, and starts the installed
RPM under X11 and Wayland in the same job. Both installers and feeds are release gates.

## Windows signing

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

The Windows workflow uses a cloud backend for signed builds using the independent
[ssign client](https://github.com/Le-Syl21/ssign). It does not need a self-hosted
runner or an online desktop PC. `setup-cloud-signing.ps1` pins v0.1.8 and the ZIP's
SHA-256 digest; this version includes the Certum EV intermediate certificate fix.
This is not a Certum-supported integration. A successful local SignTool test does
not validate the cloud client; complete a real cloud build before releasing.

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
5. Daily Release always passes `require_windows_signing=true`; the legacy
   `PILOTDECK_WINDOWS_SIGNING_ENABLED` variable is no longer used. Missing or
   invalid credentials, signatures or timestamps stop the Windows job before
   artifact upload and block the entire release. PR checks retain the reusable
   workflow's unsigned default. Manual Desktop Build exposes
   `require_windows_signing` and only uploads build artifacts, never a Release.

The independent published-signature audit remains a second check after release;
it is not a substitute for the build-time signing and verification gate. Sign
the final installer before generating its blockmap and updater checksums; do not
sign or replace immutable release assets after publication.

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
