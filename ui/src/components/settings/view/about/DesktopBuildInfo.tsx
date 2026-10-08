import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import type { DesktopAboutInfo } from "../../../../utils/desktopAbout";
import { SettingsCard } from "../../shared/view";

export default function DesktopBuildInfo({ currentVersion }: { currentVersion: string }) {
  const { t, i18n } = useTranslation("settings");
  const [info, setInfo] = useState<DesktopAboutInfo | null>(null);
  const [copyStatus, setCopyStatus] = useState("copyInfo");
  useEffect(() => {
    let active = true;
    void window.pilotdeckDesktop?.getAboutInfo?.().then(value => {
      if (active) setInfo(value);
    }).catch(() => { /* Older shells still show the current version and project links. */ });
    return () => { active = false; };
  }, []);
  const validBuildTime = info?.buildTime && Number.isFinite(Date.parse(info.buildTime));
  const rows = [
    [t("settingsPage.about.currentVersion"), info?.version || currentVersion],
    ...(info ? [
      [t("settingsPage.about.platform"), `${info.platform} ${info.osRelease} (${info.arch})`],
      ...(validBuildTime ? [[t("settingsPage.about.buildTime"), new Date(info.buildTime!).toLocaleString(i18n.language, { hour12: false })]] : []),
      ...(info.commitSha ? [[t("settingsPage.about.commit"), info.commitSha.slice(0, 12)]] : []),
      ...Object.entries(info.versions).filter(([, value]) => value).map(([name, value]) => [name === "chrome" ? "Chromium" : name === "node" ? "Node.js" : "Electron", value!]),
    ] : []),
    [t("settingsPage.about.license"), info?.license || "AGPL-3.0-only"],
  ];
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(info!.versionInformation);
      setCopyStatus("copied");
    } catch { setCopyStatus("copyFailed"); }
  };
  return <SettingsCard className="overflow-hidden">
    <div className="flex items-center gap-4 px-5 py-5">
      <img src="/pilotdeck-p-mark-compact.png" alt="" className="h-12 w-12 rounded-xl" />
      <div><h2 className="text-lg font-semibold">PilotDeck</h2><p className="text-sm text-muted-foreground">{t("settingsPage.about.description")}</p></div>
    </div>
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-6 gap-y-3 border-t border-border px-5 py-4 text-sm">
      {rows.map(([label, value]) => <div key={label} className="contents"><dt className="text-muted-foreground">{label}</dt><dd className="min-w-0 break-words">{value}</dd></div>)}
    </dl>
    <div className="flex flex-wrap items-center gap-4 border-t border-border px-5 py-4 text-sm">
      <a href="https://github.com/OpenBMB/PilotDeck" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">{t("settingsPage.about.projectWebsite")}</a>
      <a href="https://github.com/OpenBMB/PilotDeck/issues" target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">{t("settingsPage.about.reportIssue")}</a>
      {info && <button type="button" className="text-primary hover:underline" onClick={() => void copy()}>{t(`settingsPage.about.${copyStatus}`)}</button>}
      <span className="text-muted-foreground">Copyright © OpenBMB</span>
    </div>
  </SettingsCard>;
}
