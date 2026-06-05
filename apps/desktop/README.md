# PilotDeck Desktop

Electron desktop shell for the existing PilotDeck Web UI and local gateway runtime.

## Development

```bash
pnpm install --frozen-lockfile
pnpm --filter pilotdeck-desktop dev
```

The desktop process starts the existing PilotDeck gateway and UI server as local
child processes, then opens the packaged Web UI inside an Electron window.

## Packaging

```bash
pnpm --filter pilotdeck-desktop dist:mac
pnpm --filter pilotdeck-desktop dist:win
```

Platform release builds should run on matching GitHub Actions runners:

- macOS zip artifacts on `macos-latest`
- Windows artifacts on `windows-latest`

The first packaging pass produces unsigned artifacts. Developer ID notarization
and Windows Authenticode signing are separate hardening steps.
