---
name: browser-use-install
description: Use before browser-use, Playwright MCP, web browsing, browser automation, or when browser-use fails with a missing browser, missing executable, "Executable doesn't exist", or Chrome/Chromium install error in PilotDeck Desktop.
---

# Browser-Use Install

PilotDeck Desktop ships browser-use without a bundled Chrome browser. When browser automation is needed, install the Playwright Chrome for Testing browser into the user's writable PilotDeck data directory, then retry the browser-use tool.

## Install

Run this from any working directory:

```bash
node "$PILOTDECK_RUNTIME_ROOT/dist/src/extension/plugins/builtin/browser-use/scripts/install-browser.mjs"
```

In PowerShell, use:

```powershell
node "$env:PILOTDECK_RUNTIME_ROOT/dist/src/extension/plugins/builtin/browser-use/scripts/install-browser.mjs"
```

If `PILOTDECK_RUNTIME_ROOT` is not set, find the PilotDeck runtime root first. It is the directory that contains `node_modules/@playwright/mcp/cli.js` and `dist/src/cli/pilotdeck.js`, then run:

```bash
PILOTDECK_RUNTIME_ROOT="/path/to/runtime" node "/path/to/runtime/dist/src/extension/plugins/builtin/browser-use/scripts/install-browser.mjs"
```

PowerShell equivalent:

```powershell
$env:PILOTDECK_RUNTIME_ROOT = 'C:\Path\To\PilotDeck\resources\runtime'
node "$env:PILOTDECK_RUNTIME_ROOT/dist/src/extension/plugins/builtin/browser-use/scripts/install-browser.mjs"
```

## Mirrors And Offline

Use the same environment variables as desktop packaging when the default network is blocked:

```bash
PILOTDECK_DESKTOP_DOWNLOAD_MIRROR=china node "$PILOTDECK_RUNTIME_ROOT/dist/src/extension/plugins/builtin/browser-use/scripts/install-browser.mjs"
```

For fully offline installs, point to a directory containing the matching `chrome-*.zip` archive:

```bash
PILOTDECK_DESKTOP_PLAYWRIGHT_ARCHIVE_DIR="/path/to/playwright-archives" node "$PILOTDECK_RUNTIME_ROOT/dist/src/extension/plugins/builtin/browser-use/scripts/install-browser.mjs"
```

## After Install

Retry the browser-use request after the install succeeds. If the current MCP session still reports the old missing-browser error, tell the user to send the same request once more so PilotDeck can start a fresh browser-use session.
