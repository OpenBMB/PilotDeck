import { useMemo, useState } from "react";
import { Check, Loader2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { authenticatedFetch } from "../../../../utils/api";
import { cn } from "../../../../lib/utils";
import type { DesktopVersionCheckResult } from "../../Settings";
import { SettingsCard } from "../../shared/view";
import {
  launchDesktopInstaller,
  readWebUpdateTerminalStatus,
} from "./updateActions";

type AboutSectionsProps = {
  title: string;
  versionInfo: DesktopVersionCheckResult;
  checkingVersion: boolean;
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
  title,
  versionInfo,
  checkingVersion,
}: AboutSectionsProps) {
  const { t } = useTranslation("settings");
  const [downloading, setDownloading] = useState(false);
  const [webUpdating, setWebUpdating] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [localUpdateResult, setLocalUpdateResult] = useState<LocalUpdateResult>(null);
  const [downloadedFilePath, setDownloadedFilePath] = useState<string | null>(null);
  const isDesktop = versionInfo.mode === "desktop";

  const status: VersionStatus = useMemo(() => {
    if (checkingVersion) return "checking";
    if (localUpdateResult === "installerLaunched") return "installerLaunched";
    if (localUpdateResult === "webUpToDate") return "upToDate";
    if (localUpdateResult === "failed") return "unavailable";
    if (versionInfo.checkUnavailable) return "unavailable";
    if (versionInfo.hasUpdate) return "updateAvailable";
    return "upToDate";
  }, [checkingVersion, localUpdateResult, versionInfo.checkUnavailable, versionInfo.hasUpdate]);

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
    } catch {
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

  const handleWebRestart = async () => {
    setInstalling(true);
    try {
      await authenticatedFetch("/api/update/restart", {
        method: "POST",
      });
    } catch {
      // best effort: server can drop connection while restarting
    } finally {
      setInstalling(false);
    }
  };

  const showDownloadButton =
    isDesktop && status === "updateAvailable" && localUpdateResult !== "downloaded";
  const showRestartInstallButton = isDesktop && localUpdateResult === "downloaded";
  const showWebUpdateButton =
    !isDesktop
    && versionInfo.hasUpdate
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
    <div className="space-y-8">
      <h2 className="text-2xl font-semibold text-foreground">{title}</h2>

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
    </div>
  );
}
