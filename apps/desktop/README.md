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

Desktop includes Python 3.12, uv/uvx and a curated set of agent, data, statistics, plotting and document libraries on all six Windows/macOS/Linux x64/ARM64 targets. Settings > Advanced > Python environment enables it by default. The Gateway creates an offline, writable virtual environment under `PILOT_HOME/runtimes/python`, sharing the immutable bundled base libraries. Preference changes apply to subsequent turns and retain running tasks and MCP connections. See [bundled Python release inputs](../../docs/release.md#bundled-python).

## Entry points and boundaries

- [main.ts](src/main.ts): application lifecycle, IPC and supervised Web/Gateway processes.
- [preload.ts](src/preload.ts): the constrained renderer bridge.
- [applicationMenu.ts](src/applicationMenu.ts): native commands and shortcuts.
- [updates.ts](src/updates.ts), [JsonReleaseProvider.ts](src/JsonReleaseProvider.ts) and [updateDownload.ts](src/updateDownload.ts): pinned release identity, differential/full download recovery and transport control; see [release policy](../../docs/release.md#differential-downloads-and-recovery).
- [build-runtime.mjs](scripts/build-runtime.mjs): runtime assembly; [installer documentation](resources/installer/README.md) explains transactional Windows payload replacement.
- [rebuild-icon.mjs](scripts/rebuild-icon.mjs) regenerates platform icons; [rebuild-icon.ps1](scripts/rebuild-icon.ps1) preserves the Windows command entry.
- [computerUse.ts](src/computerUse.ts): built-in native Driver lifecycle. Settings > External integrations > Computer Use controls it; macOS permissions belong to PilotDeck Computer Use, not the main app. See [MCP](../../src/mcp/README.md).

Closing the window keeps background work running when a supported tray is available. Explicit Quit stops owned processes; updater failure must restore a working runtime. Do not terminate unrelated user processes.

Caption menus retain each native popup through deferred close completion. `close()` stops hover tracking and returns a promise that resolves after native teardown. Renderer acknowledgements and queued menu switches resume after the native close callback exits; repeated close requests do not cancel that settlement. Native acceptance controls popup closure through renderer IPC and reads main-process debugger state after dismissal.

Notifications follow application preferences and OS policy. Windows uses native Toasts without numeric app badges. Supported app badges count background tasks and clear when the main window gains focus; conversation unread state is independent.

General uses a registered PilotDeckGeneral workspace (Documents on Windows, home on macOS/Linux). Configuration may select another location; selection and migration must preserve existing files, validate directory identity and reject overlap with installation or state directories. See [configuration and paths](../../src/pilot/README.md).

Runtime logs are managed under userData/logs, or PILOT_HOME/logs for standalone services. The retention setting defaults to seven days. Download runtime logs exports redacted diagnostics; invalid configuration remains available for repair.

## Preference persistence

Ordinary application updates replace the installation payload and retain the user profile. Desktop theme mode, color palette, custom colors, wallpaper parameters and interface performance preferences live in Electron's `userData/appearance.json`; managed background images live in `userData/appearance-images/`. Language/theme updates merge into the saved appearance rather than replacing it. Model, tool and skill preferences live under `PILOT_HOME` (normally `~/.pilotdeck`); device UI choices also use the Web view's local storage. These locations must stay outside the installation directory. Desktop startup selects an available localhost port beginning at 3001; if it changes, local-storage-only choices such as project sorting and code editor options use a different origin and can appear reset. File-backed appearance, images and Gateway preferences are independent of that port.

Browser deployments keep appearance settings in local storage and images in IndexedDB, scoped to the browser profile and site origin (scheme, hostname and port). Reinstalling with personal-data deletion, clearing site data, changing the application profile/identity or changing the Web origin is outside normal update retention. Storage keys remain stable across palette refinements; the retired lavender preset remains readable as a custom choice without overwriting separately saved custom colors; user custom colors and image effects are preserved.

## Appearance tokens

The six presets use paired 12-step sRGB scales exported from the [Radix custom palette tool](https://www.radix-ui.com/colors/custom); source inputs are recorded in [themeScales.ts](src/themeScales.ts). [appearancePalette.ts](src/appearancePalette.ts) maps backgrounds to steps 1–2, interactions to 3–5, borders to 6–8, solid actions to 9–10 and text to 11–12. Contrast checks protect button labels and selected text; custom accents use the same semantic roles with derived colors. The UI, native caption and memory dashboard share these tokens. The original default light styling remains opt-out; all six palettes support dark and system mode. Wallpaper effects remain light-only, with saved images and adjustments retained across mode changes.

Use palette tokens for interactive accents (links, selection, focus, switches, progress and primary actions), including portalled menus and dark styles. Use `--pd-accent-strong` for colored text, `--pd-accent` / `--pd-button-hover` for solid buttons with white labels, and distinct soft/hover/selected tokens for their backgrounds. Permission bypass uses a separate amber warning pair. Success, errors, Git additions/deletions, file types, chart categories, product logos, document content and terminal/syntax colors retain their meanings across accents; their foreground/background pairs must still be readable in each mode. Editor chrome follows the palette while syntax categories remain distinct.

## Validation

The Node helper suite is collected by the test command above. [Desktop chrome acceptance](../../ui/e2e/desktop-chrome.smoke.mjs), [lifecycle acceptance](scripts/verify-desktop-lifecycle.cjs) and native installer checks need their stated build/platform prerequisites and isolated profiles. They do not establish that a particular published package is signed; [release verification](../../docs/release.md) checks the actual payload.

Caption-menu changes also require `pnpm --dir ui exec vitest run --project server server/services/windowsCaptionMenu.test.ts`; these fake-clock integration cases complement the desktop helper's real event-loop tests.

Shared development rules: [CONTRIBUTING.md](../../CONTRIBUTING.md). Test selection: [testing guide](../../docs/testing.md).
