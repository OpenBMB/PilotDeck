import type { DesktopCommand, DesktopMenuState } from "../../shared/desktopCommands";
import type { DesktopUpdateCheck, DesktopUpdateState } from "../utils/desktopUpdates";
import type { LightAppearance } from '../lib/lightAppearance';
import type { InterfacePreferences } from '../lib/interfacePreferences';
import type { DesktopAboutInfo } from '../utils/desktopAbout';
export {};

declare global {
  interface Window {
    __ROUTER_BASENAME__?: string;
    refreshProjects?: () => void | Promise<void>;
    openSettings?: (tab?: string) => void;
    // Returns true if a project matching the given name was found and the
    // app navigated to it; false otherwise so callers (e.g. chat slash
    // command handler) can surface a friendly "not found" message.
    switchProject?: (projectName: string) => boolean;
    pilotdeckDesktop?: {
      platform?: string;
      getAboutInfo?: () => Promise<DesktopAboutInfo>;
      setMenuState?: (state: DesktopMenuState) => Promise<void>;
      onCommand?: (callback: (command: DesktopCommand) => void) => () => void;
      getAppearance?: () => { language: "en" | "zh-CN"; themeMode: "light" | "dark" | "system"; lightAppearance?: LightAppearance; interfacePreferences?: InterfacePreferences } | null;
      setAppearance?: (value: { language?: "en" | "zh-CN"; themeMode?: "light" | "dark" | "system"; lightAppearance?: LightAppearance; interfacePreferences?: InterfacePreferences }) => Promise<void>;
      getAppearanceCapabilities?: () => Promise<{ hardwareAcceleration: boolean }>;
      saveAppearanceImage?: (bytes: Uint8Array) => Promise<string>;
      readAppearanceImage?: (id: string) => Promise<Uint8Array | string>;
      deleteAppearanceImage?: (id: string) => Promise<void>;
      checkUpdates: () => Promise<DesktopUpdateCheck>;
      getUpdateStatus: () => Promise<DesktopUpdateState>;
      startUpdate: () => Promise<DesktopUpdateState>;
      cancelUpdate: () => Promise<DesktopUpdateState>;
      pauseUpdate: () => Promise<DesktopUpdateState>;
      resumeUpdate: () => Promise<DesktopUpdateState>;
      getRuntimeInfo: () => Promise<{
        serverPort: number;
        gatewayPort: number;
        gateway:
          | { state: 'stopped' | 'starting' | 'ready' }
          | { state: 'error'; error: string };
        runtimeRoot: string;
        logPath: string;
      } | null>;
      onRuntimeStatus: (callback: (status: {
        phase: string;
        message: string;
        logPath?: string;
        error?: string;
      }) => void) => () => void;
      retryRuntime: () => Promise<void>;
      openRuntimeLog: () => Promise<void>;
      pickFolder: () => Promise<string | null>;
      pickFiles?: (request: { inputId: string; accept: string; multiple: boolean; directory: boolean }) => Promise<'selected' | 'canceled' | 'busy'>;
    };
  }

  interface EventSourceEventMap {
    result: MessageEvent;
    progress: MessageEvent;
    done: MessageEvent;
  }
}
