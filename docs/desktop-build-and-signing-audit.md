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
