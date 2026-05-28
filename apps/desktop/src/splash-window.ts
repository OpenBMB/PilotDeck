/**
 * Splash window — shown during the long-running first-launch work that
 * happens before the main window can load:
 *
 *   1. Tarball extraction into ~/Library/Application Support/PilotDeck/
 *      runtime/<version>/ (~700MB total; can take 30s+ on a cold APFS
 *      cache or rotational disk).
 *   2. Spawning the bundled Node + Bun child processes.
 *   3. Polling /health until the express server reports `{status: "ok"}`.
 *
 * Without this, Electron shows nothing for tens of seconds — users assume
 * the app crashed and force-quit halfway through extraction, leaving a
 * partial runtime that won't pass the `.extracted` marker check next
 * time. A frameless splash with a phase label fixes both problems
 * (perceived hang and accidental abort).
 *
 * Lifecycle: opened by main.ts before serverManager.start(), updated via
 * the 'progress' event ServerManager emits at each phase boundary, closed
 * either when the main BrowserWindow signals 'ready-to-show' (success
 * path) or when start() throws (failure path — main.ts tears it down
 * before showing the error dialog).
 */

import { BrowserWindow } from "electron";
import * as path from "node:path";

export interface SplashController {
  /**
   * Update the status line shown to the user. Idempotent and safe to
   * call after `close()` — extra updates are dropped.
   */
  setStatus(text: string, footer?: string): void;
  /**
   * Tear the splash window down. Idempotent.
   */
  close(): void;
  /**
   * The underlying BrowserWindow. Exposed only so callers can attach it
   * as the parent of a dialog (e.g. so error pop-ups show on top of the
   * splash instead of behind it).
   */
  window: BrowserWindow;
}

const STATUS_CHANNEL = "splash:status";

/**
 * Open the splash window and return a controller for pushing status
 * updates and closing it. The window is opened immediately; the
 * `setStatus` calls made before the renderer is ready are buffered and
 * replayed when 'did-finish-load' fires.
 */
export function showSplashWindow(opts: {
  preloadPath: string;
  htmlPath: string;
}): SplashController {
  const win = new BrowserWindow({
    width: 380,
    height: 220,
    resizable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    movable: true,
    center: true,
    frame: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: true,
    alwaysOnTop: false,
    show: false,
    title: "PilotDeck",
    webPreferences: {
      preload: opts.preloadPath,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  let closed = false;
  let rendererReady = false;
  let pending: Array<{ text: string; footer?: string }> = [];

  // Keep the splash out of the macOS Dock — it's a transient progress
  // surface, not a real window the user might want to switch between.
  // (No-op on Linux/Windows.)
  if (process.platform === "darwin") {
    win.setSkipTaskbar(true);
  }

  win.once("ready-to-show", () => {
    if (!closed) win.show();
  });

  win.webContents.once("did-finish-load", () => {
    rendererReady = true;
    for (const update of pending) {
      win.webContents.send(STATUS_CHANNEL, update);
    }
    pending = [];
  });

  void win.loadFile(opts.htmlPath);

  const setStatus = (text: string, footer?: string): void => {
    if (closed) return;
    const update = { text, footer };
    if (!rendererReady) {
      pending.push(update);
      return;
    }
    if (win.isDestroyed()) return;
    win.webContents.send(STATUS_CHANNEL, update);
  };

  const close = (): void => {
    if (closed) return;
    closed = true;
    pending = [];
    if (!win.isDestroyed()) {
      win.close();
    }
  };

  return { setStatus, close, window: win };
}

/**
 * Resolve the splash HTML path inside the packaged app. Mirrors the
 * shape of resolveOnboardingHtmlPath() in main.ts — kept here so callers
 * don't need to know the on-disk layout.
 */
export function resolveSplashHtmlPath(): string {
  // Compiled main lives at <root>/dist/main.js, splash assets sit at
  // <root>/splash/. In the packaged app electron-builder mirrors the
  // same layout inside app.asar (via the splash/** files glob).
  return path.join(__dirname, "..", "splash", "splash.html");
}

/**
 * The IPC channel name `splash:status` is also referenced by
 * splash/splash.html via the preload bridge (`pilotdeckSplash.onStatus`).
 * Exposed for tests and for renderer-side wiring; not part of the
 * normal main-process API surface.
 */
export function getSplashStatusChannel(): string {
  return STATUS_CHANNEL;
}
