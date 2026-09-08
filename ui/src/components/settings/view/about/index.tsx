import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Check, Info, Loader2, X } from "lucide-react";
import { useTranslation } from "react-i18next";
import { authenticatedFetch } from "../../../../utils/api";
import { restartAndReload, type RestartUiStatus } from "../../../../utils/restartUi";
import { cn } from "../../../../lib/utils";
import type { DesktopVersionCheckResult } from "../../Settings";
import DesktopAboutSections from "./DesktopAboutSections";
import { SettingsCard } from "../../shared/view";
import { readWebUpdateTerminalStatus } from "./updateActions";

export type AboutSectionsProps = {
  title: string;
  versionInfo: DesktopVersionCheckResult;
  checkingVersion: boolean;
};

type LocalUpdateResult =
  | "failed"
  | "webUpdated"
  | "webUpToDate"
  | null;
type VersionStatus =
  | "checking"
  | "updateAvailable"
  | "upToDate"
  | "unavailable"
  | "manualUpdate"
  | "restartRequired";

type WebUpdateStatusPayload = {
  updateInProgress?: boolean;
  currentUpdateId?: string | null;
  lastUpdateResult?: {
    updateId?: string;
    success?: boolean;
    alreadyUpToDate?: boolean;
    needsRestart?: boolean;
    error?: unknown;
    reason?: string;
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

export default function AboutSections(props: AboutSectionsProps) {
  return props.versionInfo.mode === "desktop" ? <DesktopAboutSections {...props} /> : <WebAboutSections {...props} />;
}

function WebAboutSections({
  title,
  versionInfo,
  checkingVersion,
}: AboutSectionsProps) {
  const { t } = useTranslation("settings");
  const [webUpdating, setWebUpdating] = useState(false);
  const [webFailureReason, setWebFailureReason] = useState<string | null>(null);
  const [webRefused, setWebRefused] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [localUpdateResult, setLocalUpdateResult] = useState<LocalUpdateResult>(null);
  const [restartStatus, setRestartStatus] = useState<RestartModalStatus | null>(null);
  const webStatusPollRef = useRef<number | null>(null);
  const mountedRef = useRef(true);
  const hasObservedWebUpdateRef = useRef(false);
  const autoRestartRef = useRef(sessionStorage.getItem("pilotdeck-web-update-restart"));

  const stopWebStatusPolling = useCallback(() => {
    if (webStatusPollRef.current !== null) {
      window.clearInterval(webStatusPollRef.current);
      webStatusPollRef.current = null;
    }
  }, []);

  const applyWebUpdateStatus = useCallback((payload: WebUpdateStatusPayload): WebUpdatePollDecision => {
    const intent = autoRestartRef.current;
    const result = !intent || payload.lastUpdateResult?.updateId === intent ? payload.lastUpdateResult : null;
    if (payload.updateInProgress) {
      hasObservedWebUpdateRef.current = true;
      setWebUpdating(true);
      return "continue";
    }
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
      setWebFailureReason(result.reason || "applyFailed");
      return "stop";
    }
    if (intent) {
      // A successful idle status with no matching result confirms the request
      // was not retained (for example, the server restarted). Allow a retry.
      setWebFailureReason("applyFailed");
      setLocalUpdateResult("failed");
    }
    hasObservedWebUpdateRef.current = false;
    setWebUpdating(false);
    return "stop";
  }, []);

  const refreshWebUpdateStatus = useCallback(async (): Promise<WebUpdatePollDecision> => {
    const intent = autoRestartRef.current;
    try {
      const res = await authenticatedFetch("/api/update/status");
      // Ignore an idle response from the mount request if Update was clicked
      // while it was in flight.
      if (!res.ok) return hasObservedWebUpdateRef.current || autoRestartRef.current ? "continue" : "stop";
      const payload = await res.json() as WebUpdateStatusPayload;
      if (intent !== autoRestartRef.current || !mountedRef.current) return "stop";
      return applyWebUpdateStatus(payload);
    } catch {
      return hasObservedWebUpdateRef.current || autoRestartRef.current ? "continue" : "stop";
    }
  }, [applyWebUpdateStatus]);

  const startWebStatusPolling = useCallback(() => {
    if (!mountedRef.current || webStatusPollRef.current !== null) return;
    webStatusPollRef.current = window.setInterval(() => {
      void refreshWebUpdateStatus().then((decision) => {
        if (decision === "stop") stopWebStatusPolling();
      });
    }, 1000);
  }, [refreshWebUpdateStatus, stopWebStatusPolling]);

  useEffect(() => {
    let active = true;
    mountedRef.current = true;
    void refreshWebUpdateStatus().then((decision) => {
      if (active && decision === "continue") startWebStatusPolling();
    });

    return () => {
      active = false;
      mountedRef.current = false;
      stopWebStatusPolling();
    };
  }, [refreshWebUpdateStatus, startWebStatusPolling, stopWebStatusPolling]);

  const status: VersionStatus = useMemo(() => {
    if (checkingVersion || webUpdating) return "checking";
    if (localUpdateResult === "webUpdated") return "restartRequired";
    if (localUpdateResult === "webUpToDate") return "upToDate";
    if (localUpdateResult === "failed") return "unavailable";
    if (versionInfo.checkUnavailable) return "unavailable";
    if (versionInfo.webReason && versionInfo.webReason !== "upToDate") return "manualUpdate";
    if (versionInfo.hasUpdate) return "updateAvailable";
    return "upToDate";
  }, [checkingVersion, localUpdateResult, versionInfo.checkUnavailable, versionInfo.hasUpdate, versionInfo.webReason, webUpdating]);

  const handleWebUpdate = async () => {
    if (versionInfo.canUpdate !== true || checkingVersion || versionInfo.checkUnavailable
        || !versionInfo.latestVersion || !versionInfo.latestSourceSha) return;
    // randomUUID is unavailable on ordinary HTTP LAN deployments.
    const updateId = typeof crypto.randomUUID === "function" ? crypto.randomUUID()
      : Array.from(crypto.getRandomValues(new Uint8Array(16)), value => value.toString(16).padStart(2, "0")).join("");
    autoRestartRef.current = updateId;
    sessionStorage.setItem("pilotdeck-web-update-restart", updateId);
    setWebFailureReason(null);
    hasObservedWebUpdateRef.current = true;
    setWebUpdating(true);
    setLocalUpdateResult(null);
    let confirmedFailure: string | null = null;
    try {
      const res = await authenticatedFetch("/api/update/apply", {
        method: "POST",
        body: JSON.stringify({ updateId, target: { tagName: versionInfo.latestVersion, sourceSha: versionInfo.latestSourceSha } }),
      });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        // Proxy-generated errors are not authoritative task results.
        if (typeof payload.reason === "string") confirmedFailure = payload.reason;
        throw new Error(confirmedFailure || "applyFailed");
      }
      const terminalStatus = await readWebUpdateTerminalStatus(res.body, (reason) => {
        confirmedFailure = reason;
        setWebFailureReason(reason);
        setWebRefused(!["buildFailed", "buildTimedOut", "applyFailed"].includes(reason));
      });
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
      if (!confirmedFailure) {
        // The server owns the job. Losing its stream says nothing about whether
        // file replacement succeeded; preserve restart intent and recover status.
        startWebStatusPolling();
        return;
      }
      setWebFailureReason(confirmedFailure);
      setWebRefused(!["buildFailed", "buildTimedOut", "applyFailed"].includes(confirmedFailure));
      hasObservedWebUpdateRef.current = false;
      stopWebStatusPolling();
      setLocalUpdateResult("failed");
    }
    setWebUpdating(false);
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
          if (status === "confirmed") return;
          setRestartStatus(status);
          if (status !== "restarting") setInstalling(false);
        },
      },
    );
  };

  useEffect(() => {
    if (!autoRestartRef.current) return;
    if (localUpdateResult === "webUpdated") {
      autoRestartRef.current = null;
      sessionStorage.removeItem("pilotdeck-web-update-restart");
      handleWebRestart();
    } else if (localUpdateResult === "failed" || localUpdateResult === "webUpToDate") {
      autoRestartRef.current = null;
      sessionStorage.removeItem("pilotdeck-web-update-restart");
    }
  }, [localUpdateResult]);

  const showWebUpdateButton = localUpdateResult !== "webUpdated";
  const showWebRestartButton = localUpdateResult === "webUpdated";
  const statusBadgeClass = cn(
    "inline-flex items-center rounded-md border px-2 py-0.5 text-sm font-medium leading-5",
    status === "updateAvailable"
      ? "border-blue-300 bg-blue-50 text-blue-700"
      : status === "upToDate"
        ? "border-emerald-300 bg-emerald-50 text-emerald-700"
        : (status === "checking" || status === "manualUpdate" || status === "restartRequired")
          ? "border-slate-300 bg-slate-50 text-slate-700"
          : "border-red-300 bg-red-50 text-red-700",
  );
  const statusIconClass = "h-3.5 w-3.5";

  return (
    <div className="space-y-8">
      <h2 className="text-2xl font-semibold text-foreground">{title}</h2>

      <SettingsCard className="overflow-hidden">
        <div className="grid min-h-[64px] grid-cols-1 sm:grid-cols-[1fr_auto] lg:grid-cols-[1fr_auto_auto] items-center gap-4 px-5 py-4">
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
              ) : status === "manualUpdate" ? (
                <Info className={cn("mr-1", statusIconClass)} />
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
          {showWebUpdateButton ? (
            <button
              type="button"
              onClick={handleWebUpdate}
              disabled={webRefused || webUpdating || installing || checkingVersion || versionInfo.checkUnavailable || versionInfo.canUpdate !== true || !versionInfo.hasUpdate || !versionInfo.latestSourceSha || localUpdateResult === "webUpToDate"}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100"
            >
              {webUpdating ? t("about.updating") : t("about.updateAndRestart")}
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
          ) : (
            <div />
          )}
        </div>
        <div className="space-y-2 border-t border-border px-5 py-4 text-sm">
          <div className="flex flex-wrap gap-x-6 gap-y-1 text-muted-foreground">
            <span>{t("settingsPage.about.currentVersion")} {versionInfo.currentVersion}</span>
            <span>{t("settingsPage.about.latestVersion")} {versionInfo.latestVersion || "-"}</span>
          </div>
          <p className="text-muted-foreground" role={webFailureReason ? "alert" : undefined}>
            {t(`settingsPage.about.webUpdateReasons.${webFailureReason || (localUpdateResult === "webUpdated" ? "restartRequired" : versionInfo.webReason) || "standard"}`, {
              defaultValue: t("settingsPage.about.webUpdateReasons.applyFailed"),
            })}
          </p>
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
