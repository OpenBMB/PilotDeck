import { useEffect, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { desktopUpdates, type DesktopUpdateState } from "../../../../utils/desktopUpdates";
import { SettingsCard } from "../../shared/view";
import type { AboutSectionsProps } from ".";
import "./DesktopAboutSections.css";

const busyStates = new Set(["checking", "downloading", "paused", "cancelling", "verifying", "installing", "recovering"]);
type UpdateAction = "start" | "check" | "cancel" | "pause" | "resume";
const formatDownloadSpeed = (bytesPerSecond = 0) => {
  const speed = Number.isFinite(bytesPerSecond) ? Math.max(0, bytesPerSecond) : 0;
  return speed >= 1024 * 1024
    ? `${(speed / (1024 * 1024)).toFixed(1)} MB/s`
    : `${(speed / 1024).toFixed(1)} KB/s`;
};
const formatDownloadSize = (bytes = 0) => {
  const size = Number.isFinite(bytes) ? Math.max(0, bytes) : 0;
  return size >= 1024 * 1024 * 1024 ? `${(size / (1024 * 1024 * 1024)).toFixed(1)} GB`
    : size >= 1024 * 1024 ? `${(size / (1024 * 1024)).toFixed(1)} MB` : `${(size / 1024).toFixed(1)} KB`;
};
function UpdateIcon({ name, size = 16, className }: { name: "download" | "refresh" | "pause" | "play" | "close" | "loading"; size?: number; className?: string }) {
  const paths = {
    download: "M12 3v12m-5-5 5 5 5-5M5 17v4h14v-4",
    refresh: "M20 7v5h-5M4 17v-5h5M6.1 6.1a8 8 0 0 1 13.2 3.3M4.7 14.6a8 8 0 0 0 13.2 3.3",
    pause: "M8 5v14M16 5v14",
    play: "m7 4 14 8-14 8Z",
    close: "m6 6 12 12M6 18 18 6",
    loading: "M12 3a9 9 0 1 1-9 9",
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className={className}><path d={paths[name]} /></svg>;
}

export default function DesktopAboutSections({ versionInfo, checkingVersion, onCheckUpdates }: AboutSectionsProps) {
  const { t } = useTranslation("settings");
  const [update, setUpdate] = useState<DesktopUpdateState | null>(null);
  const [pendingAction, setPendingAction] = useState<UpdateAction | null>(null);
  const pending = pendingAction !== null;
  const [statusFailed, setStatusFailed] = useState(false);
  const command = useRef({ revision: 0, pending: false });
  const busy = update ? busyStates.has(update.state) : false;
  const needsPolling = update === null || busy;

  useEffect(() => {
    if (!needsPolling) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      const revision = command.current.revision;
      try {
        const status = await desktopUpdates().getUpdateStatus();
        if (!active) return;
        if (revision === command.current.revision && !command.current.pending) {
          setUpdate(status);
          setStatusFailed(false);
          if (!busyStates.has(status.state)) return;
        }
      } catch {
        if (!active) return;
        if (revision === command.current.revision && !command.current.pending) setStatusFailed(true);
      }
      if (active) timer = setTimeout(poll, 1000);
    };
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [needsPolling]);

  const act = async (action: UpdateAction = "start") => {
    if (command.current.pending) return;
    command.current = { revision: command.current.revision + 1, pending: true };
    setPendingAction(action);
    try {
      const bridge = desktopUpdates();
      if (action === "check") {
        await onCheckUpdates?.();
        setUpdate(await bridge.getUpdateStatus());
      } else {
        const commands = { start: bridge.startUpdate, cancel: bridge.cancelUpdate, pause: bridge.pauseUpdate, resume: bridge.resumeUpdate };
        setUpdate(await commands[action]());
      }
      setStatusFailed(false);
    } catch {
      // IPC may disconnect while quitting. Recover the main process state rather
      // than starting a second installation or marking it successful ourselves.
      setUpdate(null);
      setStatusFailed(true);
    } finally { command.current.pending = false; setPendingAction(null); }
  };

  const reason = statusFailed ? "statusFailed" : update?.reason || versionInfo.desktopReason;
  const message = reason || (update?.state === "installing" ? "installing" : null);
  const status = busy ? update!.state : checkingVersion ? "checking" : reason && reason !== "cancelled" ? "unavailable"
    : versionInfo.checkUnavailable ? "unavailable" : versionInfo.hasUpdate ? "updateAvailable" : "upToDate";
  const canInstall = versionInfo.hasUpdate && versionInfo.canDownload === true && !versionInfo.checkUnavailable
    && !statusFailed && update?.state !== "failed" && (!reason || reason === "cancelled");
  const disabled = pending || busy || checkingVersion || (!update && !statusFailed) || (!canInstall && !onCheckUpdates);
  const buttonLabel = busy && update?.state !== "checking" ? "updating"
    : checkingVersion || update?.state === "checking" || pendingAction === "check" ? "checking"
    : pending ? "updating" : canInstall ? "updateAndRestart" : "checkAgain";
  const progress = Math.round(Math.max(0, Math.min(1, update?.progress || 0)) * 100);
  const paused = update?.state === "paused";
  const transferVisible = update && ["downloading", "paused", "cancelling", "verifying"].includes(update.state);
  const canPause = typeof window.pilotdeckDesktop?.pauseUpdate === "function" && typeof window.pilotdeckDesktop?.resumeUpdate === "function";

  return (
    <div className="space-y-8">
      <SettingsCard className="desktop-update-card overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-4 px-5 py-4 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{t("settingsPage.about.versionStatus")}</span>
            <span className="desktop-update-status" data-state={status} role="status">
              {t(`settingsPage.about.desktopUpdate.status.${status}`)}
            </span>
          </div>
          <div className="flex items-center gap-3">
            {!transferVisible && <button className="desktop-update-button primary" disabled={disabled} onClick={() => void act(canInstall ? "start" : "check")}>
              <UpdateIcon name={busy || pending || checkingVersion ? "loading" : canInstall ? "download" : "refresh"} size={15} className={busy || pending || checkingVersion ? "animate-spin" : undefined} />
              {t(`settingsPage.about.desktopUpdate.${buttonLabel}`)}
            </button>}
            {update?.state === "checking" && <button className="desktop-update-button secondary" disabled={pending} onClick={() => void act("cancel")}>
              <UpdateIcon name="close" size={15} />{t("settingsPage.about.desktopUpdate.cancel")}
            </button>}
          </div>
        </div>
        <div className="space-y-3 border-t border-border px-5 py-4 text-sm text-muted-foreground">
          <div className="flex flex-wrap gap-x-6 gap-y-1">
            <span>{t("settingsPage.about.currentVersion")} {versionInfo.currentVersion}</span>
            <span>{t("settingsPage.about.latestVersion")} {versionInfo.latestVersion || "-"}</span>
            {versionInfo.latestPublishedAt && <span>{t("settingsPage.about.latestReleaseTime")} {versionInfo.latestPublishedAt}</span>}
          </div>
          {transferVisible && <div className="desktop-update-transfer" data-state={update.state} aria-busy={pending}>
            <div className="desktop-update-transfer-heading">
              <span className="desktop-update-transfer-icon" aria-hidden="true"><UpdateIcon name={paused ? "pause" : "download"} size={20} /></span>
              <div className="desktop-update-transfer-copy">
                <strong>{t(`settingsPage.about.desktopUpdate.status.${update.state}`)}</strong>
                <span>{t(`settingsPage.about.desktopUpdate.${paused ? "pausedHint" : update.state === "verifying" ? "verifyingHint" : "downloadHint"}`)}</span>
              </div>
              <span className="desktop-update-percent">{progress}%</span>
            </div>
            <div className="desktop-update-progress" role="progressbar" aria-label={t("settingsPage.about.desktopUpdate.progress")}
              aria-valuemin={0} aria-valuemax={100} aria-valuenow={progress}>
              <div className="desktop-update-progress-fill" style={{ width: `${progress}%` }} />
            </div>
            <div className="desktop-update-transfer-details">
              <span className="desktop-update-size">{formatDownloadSize(update.transferred)} / {update.total ? formatDownloadSize(update.total) : "—"}</span>
              <span className="desktop-update-speed">{t("settingsPage.about.desktopUpdate.speed")} {paused ? "—" : formatDownloadSpeed(update.bytesPerSecond)}</span>
            </div>
            <div className="desktop-update-transfer-actions">
              {(update.state === "downloading" || paused) && <>
                {canPause && <button className="desktop-update-button primary" disabled={pending} onClick={() => void act(paused ? "resume" : "pause")}>
                  <UpdateIcon name={paused ? "play" : "pause"} size={15} />
                  {t(`settingsPage.about.desktopUpdate.${paused ? "resume" : "pause"}`)}
                </button>}
                <button className="desktop-update-button secondary" disabled={pending} onClick={() => void act("cancel")}>
                  <UpdateIcon name="close" size={15} />{t("settingsPage.about.desktopUpdate.cancel")}
                </button>
              </>}
              {update.state === "cancelling" && <span className="desktop-update-settling"><UpdateIcon name="loading" size={15} className="animate-spin" />{t("settingsPage.about.desktopUpdate.status.cancelling")}</span>}
            </div>
          </div>}
          {message && <p role={reason ? "alert" : undefined}>
            {t(`settingsPage.about.desktopUpdate.reasons.${message}`, {
              defaultValue: t("settingsPage.about.desktopUpdate.reasons.updateFailed"),
            })}
          </p>}
        </div>
      </SettingsCard>
    </div>
  );
}
