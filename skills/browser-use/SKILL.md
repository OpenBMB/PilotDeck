---
name: browser-use
description: "Use PilotDeck's browser-use plugin for browser automation, screenshots, form filling, and web UI checks."
---

# browser-use

Use this skill when a task genuinely needs browser automation through PilotDeck's built-in `browser-use` plugin, especially for local Web UI smoke tests, screenshots, navigation, clicking, typing, and DOM inspection. For static pages, batch scraping, API responses, or plain text extraction, prefer ordinary HTTP/file tools first.

## Availability

PilotDeck ships the `browser-use` plugin, which runs `@playwright/mcp` with Chromium. Before installing anything, first try to use the existing browser/MCP setup or check the browser cache. If the browser is already present or browser-use launches successfully, do not reinstall it.

Check whether the browser is already installed:

```bash
if ls "$HOME/Library/Caches/ms-playwright"/mcp-chrome-for-testing-* >/dev/null 2>&1 || \
   ls "$HOME/.cache/ms-playwright"/mcp-chrome-for-testing-* >/dev/null 2>&1; then
  echo "Chrome for Testing is already installed; no reinstall needed."
else
  echo "Chrome for Testing is not installed yet."
fi
```

If that check reports an existing Chrome for Testing cache, proceed with browser automation directly. Repeated browser downloads are slow, brittle on restricted networks, and unnecessary when the cache is already populated.

Only install the browser when all of the following are true:

- The task truly requires an interactive browser rather than HTTP, curl, requests, or file parsing.
- The cache check shows Chrome for Testing is missing, or an actual browser-use launch failed because the browser executable is missing.
- The environment has network/proxy access suitable for downloading browser binaries.

The one-line installer uses the same check. If Chrome for Testing is already present, it prints `Chrome for Testing already installed` and does not download it again.

Install it from a PilotDeck source checkout or installed app directory:

```bash
cd /path/to/PilotDeck
corepack pnpm install --frozen-lockfile
corepack pnpm run install:browser
```

For an installed one-line setup, use the app directory shown by `pilotdeck status`:

```bash
pilotdeck status
cd ~/.pilotdeck/app
corepack pnpm run install:browser
```

To let the one-line installer install it during setup, opt in explicitly:

```bash
PILOTDECK_SKIP_BROWSER_INSTALL=0 bash install.sh
```

Repeated installs are safe only when the installer can confirm the cache first. In task containers or time-limited jobs, avoid ad hoc commands such as `playwright install chromium` unless the missing-browser error is confirmed and installation time is acceptable.

If the download is slow or blocked, configure your network proxy first and rerun the install command. Browser automation is optional; PilotDeck core chat, files, skills, and settings work without it.

## Usage Notes

- Prefer browser-use for interactive browser tasks. Prefer HTTP, curl, requests, or structured parsing for non-interactive retrieval and batch scraping.
- Try the existing browser setup before any installation step. If it works, continue; do not reinstall or upgrade browser binaries.
- For local PilotDeck checks, open the URL shown by `pilotdeck status`, usually `http://localhost:3001`.
- If no model provider is configured, a clean PilotDeck instance should land on onboarding rather than settings or chat.
- Keep browser tasks small and observable: navigate, wait for a visible heading, inspect relevant text, then report evidence.
- Do not store API keys, session cookies, or private credentials in screenshots or logs.

## Common Checks

```text
Open http://localhost:3001
Verify the page shows LLM Provider Setup when no real provider config exists
Open Settings and verify provider/API key controls are visible
Take a screenshot only when visual evidence is useful
```
