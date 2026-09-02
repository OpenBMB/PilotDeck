export type DesktopVersionCheckResult = {
  mode: "desktop" | "web";
  hasUpdate: boolean;
  checkUnavailable: boolean;
  currentVersion: string;
  latestVersion: string | null;
  latestPublishedAt: string | null;
  buildTime: string | null;
};

export function normalizeDesktopVersionResult(
  payload: any,
): DesktopVersionCheckResult {
  return {
    mode: "desktop",
    hasUpdate: Boolean(payload?.hasUpdate),
    checkUnavailable: Boolean(payload?.checkUnavailable),
    currentVersion: payload?.current?.version ?? "unknown",
    latestVersion: payload?.latest?.version ?? null,
    latestPublishedAt: payload?.latest?.publishedAt ?? null,
    buildTime: payload?.current?.buildTime ?? null,
  };
}

export function normalizeWebVersionResult(
  payload: any,
): DesktopVersionCheckResult {
  return {
    mode: "web",
    hasUpdate: Boolean(payload?.hasUpdate),
    checkUnavailable: Boolean(payload?.checkUnavailable),
    currentVersion: payload?.localHead ?? "unknown",
    latestVersion: payload?.remoteHead ?? null,
    latestPublishedAt: null,
    buildTime: null,
  };
}
