/**
 * Onboarding flow — shown when ~/.pilotdeck/pilotdeck.yaml is missing.
 *
 * Renders a dedicated BrowserWindow loading onboarding/onboarding.html.
 * The renderer collects (providerType, baseUrl, apiKey, model) from the user
 * and POSTs it back to main via IPC. We then write a minimal *structured*
 * YAML to ~/.pilotdeck/pilotdeck.yaml — the ui/server's deep-merge will fill
 * the rest from buildDefaultPilotDeckConfig().
 *
 * The function returns:
 *   - "saved"     — user successfully completed onboarding; main should
 *                   proceed to start the server.
 *   - "cancelled" — user closed the window or hit "退出"; main should quit.
 */

import { BrowserWindow, ipcMain } from "electron";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

function resolveOnboardingIconPath(): string | undefined {
  const candidates = [
    path.join(__dirname, "..", "resources", "icon.icns"),
    path.join(process.resourcesPath, "icon.icns"),
  ];
  for (const p of candidates) {
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}
import {
  buildConfigYaml,
  type OnboardingPayload,
} from "./onboarding-config.js";
import { testProviderOnboarding } from "./provider-tester";

export type OnboardingResult = "saved" | "cancelled";

function writeConfig(
  payload: OnboardingPayload,
): { ok: true } | { ok: false; error: string } {
  try {
    if (!payload || typeof payload !== "object") {
      return { ok: false, error: "Invalid payload" };
    }
    const required: Array<keyof OnboardingPayload> = [
      "providerType",
      "baseUrl",
      "apiKey",
      "model",
    ];
    for (const key of required) {
      const v = payload[key];
      if (typeof v !== "string" || !v.trim()) {
        return { ok: false, error: `Missing field: ${key}` };
      }
    }

    const configDir = process.env.PILOT_HOME || path.join(os.homedir(), ".pilotdeck");
    const configPath = path.join(configDir, "pilotdeck.yaml");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(configPath, buildConfigYaml(payload), { mode: 0o600 });
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
}

export function showOnboardingWindow(opts: {
  preloadPath: string;
  htmlPath: string;
}): Promise<OnboardingResult> {
  return new Promise((resolve) => {
    const iconPath = resolveOnboardingIconPath();
    const win = new BrowserWindow({
      width: 580,
      height: 760,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      title: "PilotDeck — 初始化",
      backgroundColor: "#0f1115",
      ...(iconPath ? { icon: iconPath } : {}),
      webPreferences: {
        preload: opts.preloadPath,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      },
    });

    let settled = false;
    const finish = (result: OnboardingResult) => {
      if (settled) return;
      settled = true;
      ipcMain.removeHandler("onboarding:save");
      ipcMain.removeHandler("onboarding:testProvider");
      ipcMain.removeAllListeners("onboarding:cancel");
      if (!win.isDestroyed()) win.close();
      resolve(result);
    };

    ipcMain.handle(
      "onboarding:save",
      async (_e, payload: OnboardingPayload) => {
        const res = writeConfig(payload);
        if (res.ok) {
          setTimeout(() => finish("saved"), 200);
        }
        return res;
      },
    );

    ipcMain.handle(
      "onboarding:testProvider",
      async (
        _e,
        payload: { providerType: string; baseUrl: string; apiKey: string; model: string },
      ) => {
        return testProviderOnboarding({
          type: payload.providerType,
          baseUrl: payload.baseUrl,
          apiKey: payload.apiKey,
          model: payload.model,
        });
      },
    );

    ipcMain.on("onboarding:cancel", () => finish("cancelled"));

    win.on("closed", () => finish("cancelled"));

    void win.loadFile(opts.htmlPath);
  });
}
