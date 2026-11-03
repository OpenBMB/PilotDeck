# Desktop build and release audit

## Pull request checks

Run [41605124886](https://github.com/OpenBMB/PilotDeck/actions/runs/41605124886)
on 2026-11-03 took approximately 15m19s. Static checks finished in 49s;
cross-platform checkpoint checks took roughly 1–2 minutes. Windows ARM64 took
15m15s, including dependency setup, real install/upgrade/uninstall fixtures,
runtime assembly and installer compression. These exercise valuable native
behavior, but repeating every release target for a React-only change adds
little coverage beyond the existing Web build and cross-platform tests.

`desktop-smoke.yml` now selects full native packaging for desktop code,
packaging resources, dependencies, runtime/bootstrap configuration and build
workflows. Other changes keep cross-platform checkpoint/MCP tests, desktop
compilation, packaging-helper tests and updater tests. Manual dispatch and
production releases still run every platform and architecture. Superseded PR
runs are cancelled. The current PR changes desktop code, so it intentionally
still receives full packaging coverage.

## Published Windows signatures

Both installers in [v2026.11.03](https://github.com/OpenBMB/PilotDeck/releases/tag/v2026.11.03)
were downloaded and checked with Windows `Get-AuthenticodeSignature` on
2026-11-03. Their SHA-256 values match GitHub's release asset digests:

| Architecture | SHA-256 | Authenticode |
| --- | --- | --- |
| x64 | `8f974f19b2a1d3c0f9f8e62e8ff971693e2b2c18b77f24715218b110ffe2c041` | `NotSigned` |
| ARM64 | `9e2f91daad15c5ce791cbee627216e7b6dc5da48a8219317a825bb5255de35b5` | `NotSigned` |

The [release build](https://github.com/OpenBMB/PilotDeck/actions/runs/41555411866)
skipped cloud signing and signed-installer verification on both architectures.
`release.yml` enables signing only when repository variable
`PILOTDECK_WINDOWS_SIGNING_ENABLED` equals `true`. Passing signing unit tests
does **not** prove a particular release was signed. SHA-256 checksums establish
byte integrity, not a publisher signature.

To produce signed releases, configure the existing `windows-signing`
environment with `CERTUM_EMAIL` and `CERTUM_OTP` secrets and `WINDOWS_CERT_SHA1`
and `WINDOWS_PUBLISHER` variables, run `Windows Signing Check` on trusted main,
then enable `PILOTDECK_WINDOWS_SIGNING_ENABLED`. The signing implementation
already verifies the certificate identity and trusted timestamp and rejects
unsigned files when signing is required. Credentials and repository settings
are external configuration; this audit does not change or fabricate them.

`Audit Published Windows Signatures` now independently checks the actual
published x64/ARM64 installers after each release (or via manual tag selection),
verifies checksums, and uploads a JSON signature report even when signatures
fail validation. Existing published installers need a new signed release;
source changes cannot retroactively sign their bytes.

The Daily Release completion trigger checks for a published release matching
the source SHA regardless of the overall workflow result. A later OBS sync
failure or cancellation therefore cannot suppress an audit of already-published
installers. Runs that did not publish a matching release exit without downloading.

## Windows startup reliability

The Windows audit covers the first Electron process, its bundled Node services,
native dependencies, process containment and filesystem paths. The following
issues were reproduced locally and now have regression coverage:

| Failure | Handling and verification |
| --- | --- |
| A global `NODE_OPTIONS` prevents Electron from reaching JavaScript bootstrap | Disable Electron's Node-options fuse during packaging, before signing. A real copied Electron executable rejects an invalid inherited option before the change and reaches app readiness afterward. Published-package smoke checks the actual executable fuse. |
| Stale `NODE_OPTIONS`/`NODE_PATH` or `ELECTRON_RUN_AS_NODE` break a packaged Node service | Clear these only for the app-owned packaged runtime environment. Preserve development flags, proxy configuration and `NODE_EXTRA_CA_CERTS` for bundled Node services. |
| Both `PATH` and `Path` are present and the wrong spelling wins | Normalize Windows environment keys before prepending bundled Node/Git. Test real command lookup with stale paths and a failing preload, including a Unicode/space/punctuation installation path. |
| Preferred loopback ports are occupied or denied | Try the preferred port, then OS-assigned ephemeral ports, at most three probes. Do not allocate the same Web/Gateway port. Preserve the final error code instead of retrying indefinitely. |
| Synchronous native directory copying corrupts a Chinese path | Use the JS/libuv copy implementation on Windows, preserve caller filters/overwrite options, and use `copyFileSync` for individual startup assets. Tests verify exact directory names and binary contents. |

The native lifecycle fixture now places the complete app, profile and runtime
under a Windows path containing Chinese characters, spaces, `&` and parentheses.
Production packaging retains its existing executable-architecture, bundled
Node/Git/Bash, SQLite/bcrypt/sharp/PTY, native process-host and installer checks.
The copy workaround is limited to build/fixture files; it does not change
business file operations or relax workspace boundaries.

The Electron fuse also disables `NODE_EXTRA_CA_CERTS` in Electron itself, as
documented upstream. Electron networking uses its platform certificate trust;
the bundled Node services still receive the configured custom CA and proxies.
Global user/machine environment settings are not modified.

Some failures remain dependent on the installation environment: an unavailable
or quarantined executable, unsigned releases, denied profile/TEMP access, disk
exhaustion and native GPU/driver failures. A protected Documents folder can also
reject the General workspace. Inspect the actual runtime diagnostic and Windows
Security Protection History before changing permissions or reinstalling. Keep
profile data and existing conversations when diagnosing startup problems.

Primary references: [Electron fuses](https://www.electronjs.org/docs/latest/tutorial/fuses),
[Node 22 child-process environment rules](https://nodejs.org/download/release/v22.23.1/docs/api/child_process.html),
[Windows socket errors](https://learn.microsoft.com/en-us/windows/win32/winsock/windows-sockets-error-codes-2),
[Controlled folder access](https://learn.microsoft.com/en-us/defender-endpoint/controlled-folder-access-overview),
and [Node's Windows Unicode copy reports](https://github.com/nodejs/node/issues/54476).
