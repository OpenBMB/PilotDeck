import { useMemo, useState } from "react";
import { Check, Loader2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { authenticatedFetch } from "../../../../utils/api";
import { cn } from "../../../../lib/utils";
import type { DesktopVersionCheckResult } from "../../SettingsNew";
import { SettingsCard } from "../../shared/view";

type AboutSectionsProps = {
  title: string;
  versionInfo: DesktopVersionCheckResult;
  checkingVersion: boolean;
};

type LocalUpdateResult = "downloaded" | "installSuccess" | "failed" | "webUpdated" | null;
type VersionStatus = "checking" | "updateAvailable" | "upToDate" | "unavailable";

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
    if (localUpdateResult === "installSuccess") return "upToDate";
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
      const reader = res.body?.getReader();
      if (!reader) {
        setLocalUpdateResult("webUpdated");
        return;
      }

      const decoder = new TextDecoder();
      let done = false;
      let failed = false;
      while (!done) {
        const chunk = await reader.read();
        done = chunk.done;
        if (!chunk.value) continue;
        const text = decoder.decode(chunk.value, { stream: !done });
        for (const line of text.split("\n").filter(Boolean)) {
          try {
            const parsed = JSON.parse(line);
            if (parsed?.status === "error") {
              failed = true;
            }
          } catch {
            // ignore malformed stream chunks
          }
        }
      }

      setLocalUpdateResult(failed ? "failed" : "webUpdated");
    } catch {
      setLocalUpdateResult("failed");
    } finally {
      setWebUpdating(false);
    }
  };

  const handleRestartInstall = async () => {
    setInstalling(true);
    try {
      const installRes = await authenticatedFetch("/api/update/desktop/install", {
        method: "POST",
        body: JSON.stringify({ filePath: downloadedFilePath }),
      });
      if (!installRes.ok) {
        throw new Error("Failed to launch desktop installer");
      }
      setLocalUpdateResult("installSuccess");

      try {
        await authenticatedFetch("/api/update/restart", {
          method: "POST",
        });
      } catch {
        // best effort: server may close connection while restarting
      }
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
    && localUpdateResult !== "webUpdated";
  const showWebRestartButton = !isDesktop && localUpdateResult === "webUpdated";
  const statusBadgeClass = cn(
    "inline-flex items-center rounded-md border px-2 py-0.5 text-sm font-medium leading-5",
    status === "updateAvailable"
      ? "border-blue-300 bg-blue-50 text-blue-700"
      : status === "upToDate"
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
              {t("settingsNew.about.versionStatus")}
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
              {t(`settingsNew.about.status.${status}`)}
            </span>
          </div>
          <div className="text-sm text-foreground">
            <span className="font-medium">{t("settingsNew.about.latestReleaseTime")}</span>
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
                ? t("settingsNew.about.downloadingAndInstalling")
                : t("settingsNew.about.downloadAndInstall")}
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
                ? t("settingsNew.about.restartingAndInstalling")
                : t("about.restartToApply")}
            </button>
          ) : showRestartInstallButton ? (
            <button
              type="button"
              onClick={handleRestartInstall}
              disabled={installing || downloading}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {installing
                ? t("settingsNew.about.restartingAndInstalling")
                : t("settingsNew.about.restartAndInstall")}
            </button>
          ) : (
            <div />
          )}
        </div>
      </SettingsCard>
    </div>
  );
}
