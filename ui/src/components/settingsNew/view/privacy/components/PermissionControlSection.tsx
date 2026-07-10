import type { ChangeEvent, RefObject } from "react";
import { AlertTriangle, Download, Upload } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../../../../../shared/view/ui";
import { SettingsCard, SettingsRow, SettingsSection, SettingsToggle } from "../../../shared/view";
import type { StatusBanner } from "../types";

type PermissionControlSectionProps = {
  fileInputRef: RefObject<HTMLInputElement | null>;
  onFileChosen: (event: ChangeEvent<HTMLInputElement>) => void;
  onExport: () => void;
  onImportClick: () => void;
  banner: StatusBanner;
  skipPermissions: boolean;
  onSkipPermissionsChange: (value: boolean) => void;
};

export default function PermissionControlSection({
  fileInputRef,
  onFileChosen,
  onExport,
  onImportClick,
  banner,
  skipPermissions,
  onSkipPermissionsChange,
}: PermissionControlSectionProps) {
  const { t } = useTranslation("settings");

  return (
    <SettingsSection>
      <p className="text-sm text-muted-foreground">
        {t("permissions.description", {
          defaultValue:
            "Manage which tools the assistant can run without asking. Grants from the chat Add permission button land here too.",
        })}
      </p>
      <input
        ref={fileInputRef}
        type="file"
        accept="application/json,.json"
        className="hidden"
        onChange={onFileChosen}
      />
      <div className="mb-3 flex flex-wrap items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={onExport}
          className="h-8 gap-1.5 text-xs"
        >
          <Download className="h-3.5 w-3.5" />
          {t("permissions.export", { defaultValue: "Export" })}
        </Button>
        <Button
          variant="outline"
          size="sm"
          onClick={onImportClick}
          className="h-8 gap-1.5 text-xs"
        >
          <Upload className="h-3.5 w-3.5" />
          {t("permissions.import", { defaultValue: "Import" })}
        </Button>
        <span className="text-xs text-muted-foreground">
          {t("permissions.importExportHint", {
            defaultValue: "Share or back up your tool permissions as JSON.",
          })}
        </span>
      </div>

      {banner ? (
        <div
          role="status"
          className={
            banner.kind === "success"
              ? "mb-3 rounded-lg border border-green-200 bg-green-50 px-3 py-2 text-xs text-green-800 dark:border-green-900/50 dark:bg-green-950/30 dark:text-green-200"
              : "mb-3 rounded-lg border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-800 dark:border-red-900/50 dark:bg-red-950/30 dark:text-red-200"
          }
        >
          {banner.message}
        </div>
      ) : null}

      <SettingsCard divided>
        <SettingsRow
          label={
            <span className="inline-flex items-center gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-600 dark:text-amber-400" />
              {t("permissions.skipPermissions.title", {
                defaultValue: "Skip permission prompts",
              })}
            </span>
          }
          description={t("permissions.skipPermissions.description", {
            defaultValue:
              "Run tool calls without asking for confirmation. This maps to bypassPermissions and should only be used in trusted workspaces.",
          })}
        >
          <SettingsToggle
            checked={skipPermissions}
            ariaLabel={t("permissions.skipPermissions.title", {
              defaultValue: "Skip permission prompts",
            })}
            onChange={onSkipPermissionsChange}
          />
        </SettingsRow>
        {skipPermissions ? (
          <div className="border-t border-border px-4 py-2.5 text-xs leading-relaxed text-amber-700 dark:text-amber-300">
            {t("permissions.skipPermissions.warning", {
              defaultValue:
                "Permission prompts are currently bypassed. Allowed and blocked rules below are still saved, but this global mode lets the agent run without asking.",
            })}
          </div>
        ) : null}
      </SettingsCard>
    </SettingsSection>
  );
}
