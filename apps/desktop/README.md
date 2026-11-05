# PilotDeck Desktop

Electron shell for the shared Web UI and local Gateway. It owns native windows, menus, notifications, runtime supervision and updates; agent execution stays in [the core](../../src/README.md).

## Development

Use the Node.js and pnpm versions declared at the repository root. From that root:

```sh
pnpm install --frozen-lockfile
pnpm --filter pilotdeck-desktop dev
pnpm --filter pilotdeck-desktop compile
pnpm --filter pilotdeck-desktop test
```

Development and packaging prepare an architecture-matched runtime and pinned native resources. Packaging depends on the matching host architecture and platform toolchain. Use [release instructions](../../docs/release.md), [DEB support](../../docs/ubuntu-desktop-support.md) or [RPM support](../../docs/redhat-desktop-support.md) for build and signing setup.

## Entry points and boundaries

- [main.ts](src/main.ts): application lifecycle, IPC and supervised Web/Gateway processes.
- [preload.ts](src/preload.ts): the constrained renderer bridge.
- [applicationMenu.ts](src/applicationMenu.ts): native commands and shortcuts.
- [build-runtime.mjs](scripts/build-runtime.mjs): runtime assembly; [installer documentation](resources/installer/README.md) explains transactional Windows payload replacement.
- [rebuild-icon.mjs](scripts/rebuild-icon.mjs) regenerates platform icons; [rebuild-icon.ps1](scripts/rebuild-icon.ps1) preserves the Windows command entry.
- [computerUse.ts](src/computerUse.ts): built-in native Driver lifecycle. Settings > External integrations > Computer Use controls it; macOS permissions belong to PilotDeck Computer Use, not the main app. See [MCP](../../src/mcp/README.md).

Closing the window keeps background work running when a supported tray is available. Explicit Quit stops owned processes; updater failure must restore a working runtime. Do not terminate unrelated user processes.

Caption menus retain each native popup through deferred close completion. Renderer acknowledgements and queued menu switches resume after the native close callback exits; repeated close requests do not cancel that settlement.

Notifications follow application preferences and OS policy. Windows uses native Toasts without numeric app badges. Supported app badges count background tasks and clear when the main window gains focus; conversation unread state is independent.

General uses a registered PilotDeckGeneral workspace (Documents on Windows, home on macOS/Linux). Configuration may select another location; selection and migration must preserve existing files, validate directory identity and reject overlap with installation or state directories. See [configuration and paths](../../src/pilot/README.md).

Runtime logs are managed under userData/logs, or PILOT_HOME/logs for standalone services. The retention setting defaults to seven days. Download runtime logs exports redacted diagnostics; invalid configuration remains available for repair.

## Validation

The Node helper suite is collected by the test command above. [Desktop chrome acceptance](../../ui/e2e/desktop-chrome.smoke.mjs), [lifecycle acceptance](scripts/verify-desktop-lifecycle.cjs) and native installer checks need their stated build/platform prerequisites and isolated profiles. They do not establish that a particular published package is signed; [release verification](../../docs/release.md) checks the actual payload.

Caption-menu changes also require `pnpm --dir ui exec vitest run --project server server/services/windowsCaptionMenu.test.ts`; these fake-clock integration cases complement the desktop helper's real event-loop tests.

Shared development rules: [CONTRIBUTING.md](../../CONTRIBUTING.md). Test selection: [testing guide](../../docs/testing.md).
