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
      getRuntimeInfo: () => Promise<{
        serverPort: number;
        gatewayPort: number;
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
    };
  }

  interface EventSourceEventMap {
    result: MessageEvent;
    progress: MessageEvent;
    done: MessageEvent;
  }
}
