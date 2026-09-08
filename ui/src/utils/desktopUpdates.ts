export type DesktopUpdateState = {
  state: "idle" | "checking" | "downloading" | "verifying" | "installing" | "recovering" | "failed" | "cancelled";
  progress: number;
  reason?: string;
  version?: string;
};
export type DesktopUpdateCheck = {
  current: { version: string; buildTime?: string };
  latest: { version: string; publishedAt?: string } | null;
  hasUpdate: boolean;
  canDownload: boolean;
  checkUnavailable: boolean;
  reason?: string | null;
};
export function desktopUpdates() {
  const bridge = window.pilotdeckDesktop;
  if (!bridge?.startUpdate || !bridge.checkUpdates || !bridge.getUpdateStatus || !bridge.cancelUpdate) throw new Error("updateUnavailable");
  return bridge;
}
