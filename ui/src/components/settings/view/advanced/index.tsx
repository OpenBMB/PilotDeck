import { useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { AlertCircle, ChevronDown, FolderOpen, RefreshCw, Save } from "lucide-react";
import { usePilotDeckConfig } from "../../../../hooks/usePilotDeckConfig";
import { Button } from "../../../../shared/view/ui";
import { cn } from "../../../../lib/utils";
import {
  ConfigSaveError,
  PageSectionHeader,
  SettingsCard,
} from "../../shared/view";
import { configToYamlString, safeParseYaml } from "../modelPool/utils/configYaml";
import type { PilotDeckConfig } from "../modelPool/types";
import ServiceSection from "./components/ServiceSection";
import CustomEnvSection from "./components/CustomEnvSection";

type AdvancedSectionsProps = {
  title: string;
};

export default function AdvancedSections({ title }: AdvancedSectionsProps) {
  const { t } = useTranslation("settings");
  const {
    path,
    raw,
    setRaw,
    validation,
    parseError,
    isDirty,
    externalChangeNotice,
    dismissExternalNotice,
    save,
    refresh,
    openFile,
    loading,
    saving,
    opening,
    error,
  } = usePilotDeckConfig();
  const parsedConfig = useMemo(() => safeParseYaml(raw), [raw]);
  const [showRawYaml, setShowRawYaml] = useState(false);

  const onFormChange = (next: PilotDeckConfig) => {
    try {
      setRaw(configToYamlString(next));
      void save();
    } catch (caught) {
      console.error("Failed to serialise advanced config patch", caught);
    }
  };

  return (
    <div className="space-y-6">
      <h2 className="text-2xl font-semibold text-foreground">{title}</h2>
      <ConfigSaveError error={error} />
      {loading ? (
        <div className="py-6 text-xs text-muted-foreground">
          {t("pilotDeckConfig.loading")}
        </div>
      ) : parsedConfig ? (
        <>
          <PageSectionHeader
            title={t("pilotDeckConfig.panels.runtime.title")}
            description={t("pilotDeckConfig.panels.runtime.description")}
          />
          <ServiceSection config={parsedConfig} onChange={onFormChange} />

          <PageSectionHeader
            title={t("pilotDeckConfig.panels.customEnv.title")}
            description={t("pilotDeckConfig.panels.customEnv.description")}
          />
          <CustomEnvSection config={parsedConfig} onChange={onFormChange} />
        </>
      ) : (
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {t("settingsPage.invalidYaml.advanced")}
        </div>
      )}

      {!loading && (
        <SettingsCard className="p-4">
          <button
            type="button"
            onClick={() => setShowRawYaml((value) => !value)}
            className="flex w-full items-center justify-between gap-3 text-left"
            aria-expanded={showRawYaml || !parsedConfig}
          >
            <div className="min-w-0">
              <div className="text-sm font-semibold text-foreground">
                {t("pilotDeckConfig.rawYaml.rawYaml")}
              </div>
              <code className="mt-1 block truncate font-mono text-[11px] text-muted-foreground">
                {path}
              </code>
            </div>
            <ChevronDown
              className={cn(
                "h-4 w-4 shrink-0 text-muted-foreground transition-transform",
                (showRawYaml || !parsedConfig) && "rotate-180",
              )}
            />
          </button>

          {(showRawYaml || !parsedConfig) && (
            <div className="mt-4 space-y-3 border-t border-border pt-4">
              {(parseError || validation?.valid === false) && (
                <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  <div className="flex items-center gap-2 font-semibold">
                    <AlertCircle className="h-4 w-4" />
                    {t("pilotDeckConfig.rawYaml.configInvalid")}
                  </div>
                  {parseError && <div className="mt-1">{parseError}</div>}
                </div>
              )}

              {validation && validation.errors.length > 0 && (
                <div className="rounded-md border border-destructive/30 bg-destructive/10 p-3 text-xs text-destructive">
                  <div className="mb-1 font-semibold">
                    {t("pilotDeckConfig.rawYaml.errors")}
                  </div>
                  <ul className="list-disc space-y-1 pl-4">
                    {validation.errors.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
              )}

              {externalChangeNotice && (
                <div className="flex items-start justify-between gap-3 rounded-md border border-amber-500/40 bg-amber-500/10 p-3 text-xs text-amber-700 dark:text-amber-300">
                  <div className="flex-1">{externalChangeNotice}</div>
                  <button
                    type="button"
                    onClick={dismissExternalNotice}
                    className="rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide hover:bg-amber-500/20"
                  >
                    {t("pilotDeckConfig.actions.dismiss")}
                  </button>
                </div>
              )}

              <textarea
                value={raw}
                onChange={(event) => setRaw(event.target.value)}
                spellCheck={false}
                className="min-h-[360px] w-full resize-y rounded-md border border-border bg-background px-3 py-2 font-mono text-xs leading-5 text-foreground outline-none focus:ring-1 focus:ring-ring"
              />

              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex flex-wrap gap-2">
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={openFile}
                    disabled={opening}
                  >
                    <FolderOpen className="mr-1.5 h-3.5 w-3.5" />
                    {opening
                      ? t("pilotDeckConfig.actions.opening")
                      : t("pilotDeckConfig.actions.revealFileGeneric")}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    onClick={() => void refresh()}
                  >
                    <RefreshCw className="mr-1.5 h-3.5 w-3.5" />
                    {t("pilotDeckConfig.actions.refresh")}
                  </Button>
                </div>
                <Button
                  type="button"
                  size="sm"
                  onClick={() => void save()}
                  disabled={saving || !isDirty}
                >
                  <Save className="mr-1.5 h-3.5 w-3.5" />
                  {saving
                    ? t("pilotDeckConfig.actions.saving")
                    : t("pilotDeckConfig.actions.saveAndReloadShort")}
                </Button>
              </div>
            </div>
          )}
        </SettingsCard>
      )}
    </div>
  );
}
