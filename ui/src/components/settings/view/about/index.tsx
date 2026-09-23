import { useTranslation } from "react-i18next";
import type { DesktopVersionCheckResult } from "../../version";
import DesktopAboutSections from "./DesktopAboutSections";
import { SettingsCard } from "../../shared/view";

export type AboutSectionsProps = {
  title: string;
  versionInfo: DesktopVersionCheckResult;
  checkingVersion: boolean;
  onRestartConfirmed?: () => void;
};

export default function AboutSections(props: AboutSectionsProps) {
  return props.versionInfo.mode === "desktop"
    ? <DesktopAboutSections {...props} />
    : <WebAboutSections versionInfo={props.versionInfo} />;
}

function WebAboutSections({ versionInfo }: { versionInfo: DesktopVersionCheckResult }) {
  const { t } = useTranslation("settings");
  const currentVersion = versionInfo.currentVersion === "unknown" ? "-" : versionInfo.currentVersion;

  return (
    <div className="about-page-content">
      <SettingsCard className="overflow-hidden">
        <div className="px-5 py-4 text-sm">
          <span className="font-medium">{t("settingsPage.about.currentVersion")}</span>
          <span className="ml-2 text-muted-foreground">{currentVersion}</span>
        </div>
        <div className="space-y-3 border-t border-border px-5 py-4 text-sm text-muted-foreground">
          <p>{t("settingsPage.about.webReleaseHint")}</p>
          <a
            href="https://github.com/OpenBMB/PilotDeck/releases/latest"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-block font-medium text-blue-600 underline-offset-2 hover:underline"
          >
            {t("settingsPage.about.webReleaseLink")}
          </a>
        </div>
      </SettingsCard>
    </div>
  );
}
