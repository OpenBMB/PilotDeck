import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { desktopUpdates, type DesktopUpdateState } from "../../../../utils/desktopUpdates";
import { SettingsCard } from "../../shared/view";
import type { AboutSectionsProps } from ".";

const busyStates = new Set(["checking", "downloading", "verifying", "installing", "recovering"]);
const buttonClass = "rounded-md bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:cursor-not-allowed disabled:bg-muted disabled:text-muted-foreground";

export default function DesktopAboutSections({ title, versionInfo, checkingVersion }: AboutSectionsProps) {
  const { t } = useTranslation("settings");
  const [update, setUpdate] = useState<DesktopUpdateState | null>(null);
  const [pending, setPending] = useState(false);
  const [statusFailed, setStatusFailed] = useState(false);
  const busy = update ? busyStates.has(update.state) : false;
  const needsPolling = update === null || busy;

  useEffect(() => {
    if (!needsPolling) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const status = await desktopUpdates().getUpdateStatus();
        if (!active) return;
        setUpdate(status);
        setStatusFailed(false);
        if (!busyStates.has(status.state)) return;
      } catch {
        if (!active) return;
        setStatusFailed(true);
      }
      if (active) timer = setTimeout(poll, 1000);
    };
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [needsPolling]);

  const act = async (cancel = false) => {
    if (pending) return;
    setPending(true);
    try {
      const bridge = desktopUpdates();
      setUpdate(await (cancel ? bridge.cancelUpdate() : bridge.startUpdate()));
    } catch {
      // IPC may disconnect while quitting. Recover the main process state rather
      // than starting a second installation or marking it successful ourselves.
      setUpdate(null);
      setStatusFailed(true);
    } finally { setPending(false); }
  };

  const reason = statusFailed ? "statusFailed" : update?.reason || versionInfo.desktopReason;
  const status = busy ? update!.state : checkingVersion ? "checking" : reason && reason !== "cancelled" ? "unavailable"
    : versionInfo.checkUnavailable ? "unavailable" : versionInfo.hasUpdate ? "updateAvailable" : "upToDate";
  const disabled = pending || !update || busy || checkingVersion || versionInfo.checkUnavailable
    || versionInfo.canDownload !== true || update.reason === "installFailed";
  const progress = Math.round(Math.max(0, Math.min(1, update?.progress || 0)) * 100);

  return (
    <div className="space-y-8">
      <h2 className="text-2xl font-semibold text-foreground">{title}</h2>
      <SettingsCard className="overflow-hidden">
        <div className="flex flex-wrap items-center justify-between gap-4 px-5 py-4 text-sm">
          <div className="flex flex-wrap items-center gap-2">
            <span className="font-medium">{t("settingsPage.about.versionStatus")}</span>
            <span className="rounded-md border border-border bg-muted px-2 py-0.5" role="status">
              {t(`settingsPage.about.desktopUpdate.status.${status}`)}
            </span>
          </div>
          <div className="flex items-center gap-3">
            <button className={buttonClass} disabled={disabled} onClick={() => void act()}>
              {t(`settingsPage.about.desktopUpdate.${busy || pending ? "updating" : "updateAndRestart"}`)}
            </button>
            {(update?.state === "checking" || update?.state === "downloading") && (
              <button className="text-sm text-muted-foreground hover:text-foreground disabled:opacity-50" disabled={pending} onClick={() => void act(true)}>
                {t("settingsPage.about.desktopUpdate.cancel")}
              </button>
            )}
          </div>
        </div>
        <div className="space-y-3 border-t border-border px-5 py-4 text-sm text-muted-foreground">
          <div className="flex flex-wrap gap-x-6 gap-y-1">
            <span>{t("settingsPage.about.currentVersion")} {versionInfo.currentVersion}</span>
            <span>{t("settingsPage.about.latestVersion")} {versionInfo.latestVersion || "-"}</span>
            {versionInfo.latestPublishedAt && <span>{t("settingsPage.about.latestReleaseTime")} {new Date(versionInfo.latestPublishedAt).toLocaleString()}</span>}
          </div>
          {update?.state === "downloading" && <div className="flex items-center gap-3">
            <progress className="h-2 w-full accent-blue-600" max={100} value={progress} aria-label={t("settingsPage.about.desktopUpdate.progress")} />
            <span>{progress}%</span>
          </div>}
          <p role={reason ? "alert" : undefined}>
            {t(`settingsPage.about.desktopUpdate.reasons.${reason || (update?.state === "installing" ? "installing" : "automatic")}`, {
              defaultValue: t("settingsPage.about.desktopUpdate.reasons.updateFailed"),
            })}
          </p>
        </div>
      </SettingsCard>
    </div>
  );
}
