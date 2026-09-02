import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Loader2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { authenticatedFetch } from "../../../../utils/api";
import { restartAndReload, type RestartUiStatus } from "../../../../utils/restartUi";
import { cn } from "../../../../lib/utils";
import type { DesktopVersionCheckResult } from "../../version";
import { SettingsCard } from "../../shared/view";
import {
  launchDesktopInstaller,
  readWebUpdateTerminalStatus,
} from "./updateActions";

type AboutSectionsProps = {
  title: string;
  versionInfo: DesktopVersionCheckResult;
  checkingVersion: boolean;
  onRestartConfirmed?: () => void;
};

type LocalUpdateResult =
  | "downloaded"
  | "installerLaunched"
  | "failed"
  | "webUpdated"
  | "webUpToDate"
  | null;
type VersionStatus =
  | "checking"
  | "updateAvailable"
  | "installerLaunched"
  | "upToDate"
  | "unavailable";

type WebUpdateStatusPayload = {
  updateInProgress?: boolean;
  lastUpdateResult?: {
    success?: boolean;
    alreadyUpToDate?: boolean;
    needsRestart?: boolean;
    error?: unknown;
  } | null;
};

type WebUpdatePollDecision = "continue" | "stop";
type RestartModalStatus = Exclude<RestartUiStatus, "confirmed">;

function formatDateTime(value: string | null): string {
  if (!value) return "-";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) {
    return value;
  }
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export default function AboutSections({
  title: _title,
  versionInfo,
  checkingVersion,
  onRestartConfirmed,
}: AboutSectionsProps) {
  const { t } = useTranslation("settings");
  const [downloading, setDownloading] = useState(false);
  const [webUpdating, setWebUpdating] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [localUpdateResult, setLocalUpdateResult] = useState<LocalUpdateResult>(null);
  const [downloadedFilePath, setDownloadedFilePath] = useState<string | null>(null);
  const [restartStatus, setRestartStatus] = useState<RestartModalStatus | null>(null);
  const webStatusPollRef = useRef<number | null>(null);
  const hasObservedWebUpdateRef = useRef(false);
  const isDesktop = versionInfo.mode === "desktop";

  const stopWebStatusPolling = useCallback(() => {
    if (webStatusPollRef.current !== null) {
      window.clearInterval(webStatusPollRef.current);
      webStatusPollRef.current = null;
    }
  }, []);

  const applyWebUpdateStatus = useCallback((payload: WebUpdateStatusPayload): WebUpdatePollDecision => {
    const result = payload.lastUpdateResult;
    if (result?.needsRestart) {
      hasObservedWebUpdateRef.current = false;
      setWebUpdating(false);
      setLocalUpdateResult("webUpdated");
      return "stop";
    }
    if (result?.alreadyUpToDate) {
      hasObservedWebUpdateRef.current = false;
      setWebUpdating(false);
      setLocalUpdateResult("webUpToDate");
      return "stop";
    }
    if (result?.success === false || result?.error) {
      hasObservedWebUpdateRef.current = false;
      setWebUpdating(false);
      setLocalUpdateResult("failed");
      return "stop";
    }
    if (payload.updateInProgress) {
      hasObservedWebUpdateRef.current = true;
      setWebUpdating(true);
      return "continue";
    }
    hasObservedWebUpdateRef.current = false;
    setWebUpdating(false);
    return "stop";
  }, []);

  const refreshWebUpdateStatus = useCallback(async (): Promise<WebUpdatePollDecision> => {
    if (isDesktop) return "stop";
    try {
      const res = await authenticatedFetch("/api/update/status");
      if (!res.ok) return hasObservedWebUpdateRef.current ? "continue" : "stop";
      const payload = await res.json() as WebUpdateStatusPayload;
      return applyWebUpdateStatus(payload);
    } catch {
      return hasObservedWebUpdateRef.current ? "continue" : "stop";
    }
  }, [applyWebUpdateStatus, isDesktop]);

  const startWebStatusPolling = useCallback(() => {
    if (webStatusPollRef.current !== null) return;
    webStatusPollRef.current = window.setInterval(() => {
      void refreshWebUpdateStatus().then((decision) => {
        if (decision === "stop") stopWebStatusPolling();
      });
    }, 1000);
  }, [refreshWebUpdateStatus, stopWebStatusPolling]);

  useEffect(() => {
    if (isDesktop) {
      stopWebStatusPolling();
      return;
    }

    let active = true;
    void refreshWebUpdateStatus().then((decision) => {
      if (active && decision === "continue") startWebStatusPolling();
    });

    return () => {
      active = false;
      stopWebStatusPolling();
    };
  }, [isDesktop, refreshWebUpdateStatus, startWebStatusPolling, stopWebStatusPolling]);

  const status: VersionStatus = useMemo(() => {
    if (checkingVersion || webUpdating) return "checking";
    if (localUpdateResult === "installerLaunched") return "installerLaunched";
    if (localUpdateResult === "webUpToDate") return "upToDate";
    if (localUpdateResult === "failed") return "unavailable";
    if (versionInfo.checkUnavailable) return "unavailable";
    if (versionInfo.hasUpdate) return "updateAvailable";
    return "upToDate";
  }, [checkingVersion, localUpdateResult, versionInfo.checkUnavailable, versionInfo.hasUpdate, webUpdating]);

  const handleDownloadAndInstall = async () => {
    setDownloading(true);
    setLocalUpdateResult(null);
    setDownloadedFilePath(null);
    try {
      const startRes = await authenticatedFetch("/api/update/desktop/download", {
        method: "POST",
        body: JSON.stringify({ force: true }),
      });
      if (!startRes.ok) {
        throw new Error("Failed to start download");
      }

      let attempts = 0;
      while (attempts < 300) {
        attempts += 1;
        const pollRes = await authenticatedFetch("/api/update/desktop/download/status");
        if (!pollRes.ok) {
          throw new Error("Failed to fetch download status");
        }
        const pollData = await pollRes.json();
        const state = pollData?.download?.state;
        if (state === "downloaded") {
          setDownloadedFilePath(pollData?.download?.filePath ?? null);
          setLocalUpdateResult("downloaded");
          setDownloading(false);
          return;
        }
        if (state === "failed" || state === "cancelled") {
          setLocalUpdateResult("failed");
          setDownloading(false);
          return;
        }
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }

      setLocalUpdateResult("failed");
    } catch {
      setLocalUpdateResult("failed");
    } finally {
      setDownloading(false);
    }
  };

  const handleWebUpdate = async () => {
    hasObservedWebUpdateRef.current = true;
    setWebUpdating(true);
    setLocalUpdateResult(null);
    try {
      const res = await authenticatedFetch("/api/update/apply", {
        method: "POST",
      });
      if (!res.ok) {
        throw new Error("Failed to apply web update");
      }
      const terminalStatus = await readWebUpdateTerminalStatus(res.body);
      setLocalUpdateResult(
        terminalStatus === "error"
          ? "failed"
          : terminalStatus === "up-to-date"
            ? "webUpToDate"
            : "webUpdated",
      );
      hasObservedWebUpdateRef.current = false;
      stopWebStatusPolling();
    } catch {
      hasObservedWebUpdateRef.current = false;
      stopWebStatusPolling();
      setLocalUpdateResult("failed");
    } finally {
      setWebUpdating(false);
    }
  };

  const handleInstall = async () => {
    setInstalling(true);
    try {
      await launchDesktopInstaller(downloadedFilePath);
      setLocalUpdateResult("installerLaunched");
    } catch {
      setLocalUpdateResult("failed");
    } finally {
      setInstalling(false);
    }
  };

  const handleWebRestart = () => {
    setInstalling(true);
    stopWebStatusPolling();
    restartAndReload(
      (context) => authenticatedFetch("/api/update/restart", {
        method: "POST",
        suppressServerErrorToast: true,
        signal: context?.signal,
      }),
      {
        copy: {
          title: t("about.restartingTitle"),
          description: t("about.restartWaitingDescription"),
        },
        onStatusChange: (status) => {
          if (status === "confirmed") {
            onRestartConfirmed?.();
            return;
          }
          setRestartStatus(status);
          if (status !== "restarting") setInstalling(false);
        },
      },
    );
  };

  const showDownloadButton =
    isDesktop && status === "updateAvailable" && localUpdateResult !== "downloaded";
  const showRestartInstallButton = isDesktop && localUpdateResult === "downloaded";
  const showWebUpdateButton =
    !isDesktop
    && (versionInfo.hasUpdate || webUpdating)
    && localUpdateResult !== "webUpdated"
    && localUpdateResult !== "webUpToDate";
  const showWebRestartButton = !isDesktop && localUpdateResult === "webUpdated";
  const statusBadgeClass = cn(
    "inline-flex items-center rounded-md border px-2 py-0.5 text-sm font-medium leading-5",
    status === "updateAvailable"
      ? "border-blue-300 bg-blue-50 text-blue-700"
      : status === "upToDate" || status === "installerLaunched"
        ? "border-emerald-300 bg-emerald-50 text-emerald-700"
        : status === "checking"
          ? "border-slate-300 bg-slate-50 text-slate-700"
          : "border-red-300 bg-red-50 text-red-700",
  );
  const statusIconClass = "h-3.5 w-3.5";

  return (
    <div className="about-page-content">
      <SettingsCard className="overflow-hidden">
        <div className="grid min-h-[64px] grid-cols-[1fr_auto_auto] items-center gap-4 px-5 py-4">
          <div className="min-w-0 text-sm text-foreground">
            <span className="font-medium">
              {t("settingsPage.about.versionStatus")}
            </span>
            <span className={cn("ml-2", statusBadgeClass)}>
              {status === "updateAvailable" ? (
                <span className="mr-1.5 inline-block h-2 w-2 rounded-full bg-blue-600" />
              ) : status === "checking" ? (
                <Loader2 className={cn("mr-1.5 animate-spin", statusIconClass)} />
              ) : status === "unavailable" ? (
                <X className={cn("mr-1", statusIconClass)} />
              ) : (
                <Check className={cn("mr-1", statusIconClass)} />
              )}
              {t(`settingsPage.about.status.${status}`)}
            </span>
          </div>
          <div className="text-sm text-foreground">
            <span className="font-medium">{t("settingsPage.about.latestReleaseTime")}</span>
            <span className="ml-2">{formatDateTime(versionInfo.latestPublishedAt)}</span>
          </div>
          {showDownloadButton ? (
            <button
              type="button"
              onClick={handleDownloadAndInstall}
              disabled={downloading || installing}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {downloading
                ? t("settingsPage.about.downloadingAndInstalling")
                : t("settingsPage.about.downloadAndInstall")}
            </button>
          ) : showWebUpdateButton ? (
            <button
              type="button"
              onClick={handleWebUpdate}
              disabled={webUpdating || installing}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {webUpdating ? t("about.updating") : t("about.updateNow")}
            </button>
          ) : showWebRestartButton ? (
            <button
              type="button"
              onClick={handleWebRestart}
              disabled={installing || webUpdating}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {installing
                ? t("settingsPage.about.restartingAndInstalling")
                : t("about.restartToApply")}
            </button>
          ) : showRestartInstallButton ? (
            <button
              type="button"
              onClick={handleInstall}
              disabled={installing || downloading}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {installing
                ? t("settingsPage.about.launchingInstaller")
                : t("settingsPage.about.installUpdate")}
            </button>
          ) : (
            <div />
          )}
        </div>
      </SettingsCard>

      {restartStatus && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 backdrop-blur-sm">
          <div className="mx-4 w-full max-w-sm rounded-xl border border-neutral-200 bg-white p-6 text-center shadow-2xl dark:border-neutral-700 dark:bg-neutral-900">
            {restartStatus === "restarting" ? (
              <>
                <Loader2 className="mx-auto mb-4 h-8 w-8 animate-spin text-blue-600" />
                <h3 className="mb-2 text-base font-semibold text-neutral-900 dark:text-neutral-100">
                  {t("about.restartingTitle")}
                </h3>
                <p className="text-sm text-neutral-600 dark:text-neutral-400">
                  {t("about.restartWaitingDescription")}
                </p>
              </>
            ) : (
              <>
                <X className="mx-auto mb-4 h-8 w-8 text-red-500" />
                <h3 className="mb-2 text-base font-semibold text-neutral-900 dark:text-neutral-100">
                  {t("about.restartFailedTitle")}
                </h3>
                <p className="text-sm text-neutral-600 dark:text-neutral-400">
                  {t("about.restartFailedDescription")}
                </p>
                <button
                  type="button"
                  onClick={() => window.location.reload()}
                  className="mt-5 rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-blue-700"
                >
                  {t("about.refreshPage")}
                </button>
              </>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
