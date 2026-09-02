import { useEffect, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertCircle,
  Pencil,
  RefreshCw,
  Search,
} from "lucide-react";
import { usePilotDeckConfig } from "../../../../hooks/usePilotDeckConfig";
import { cn } from "../../../../lib/utils";
import {
  normalizeOfficePreviewService,
  readOfficePreviewStatus,
  type OfficePreviewService,
  type OfficePreviewStatus,
} from "../../../../utils/officePreviewStatus";
import {
  FormRow,
  Select,
} from "../../shared/components/Inputs";
import {
  ConfigSaveError,
  SettingsCard,
  SettingsSection,
} from "../../shared/view";
import type { PilotDeckConfig } from "../modelPool/types";
import { configToYamlString, safeParseYaml } from "../modelPool/utils/configYaml";
import { patch } from "../modelPool/utils/patch";

type OfficePreviewSectionsProps = {
  title: string;
};

function OfficePreviewSection({
  config,
  onChange,
}: {
  config: PilotDeckConfig;
  onChange: (next: PilotDeckConfig) => void;
}) {
  const { t } = useTranslation("settings");
  const [status, setStatus] = useState<OfficePreviewStatus | null>(null);
  const [statusError, setStatusError] = useState<string | null>(null);
  const [statusLoading, setStatusLoading] = useState(true);
  const [statusReloadKey, setStatusReloadKey] = useState(0);
  const [binaryPathEditing, setBinaryPathEditing] = useState(false);
  const service = normalizeOfficePreviewService(
    config.webui?.officePreview?.service,
  );
  const configuredBinaryPath =
    config.webui?.officePreview?.binaryPath ?? "";
  const [binaryPathDraft, setBinaryPathDraft] = useState(
    configuredBinaryPath,
  );

  useEffect(() => {
    let cancelled = false;
    setStatusLoading(true);
    setStatusError(null);

    readOfficePreviewStatus({ refresh: statusReloadKey > 0 })
      .then((body: OfficePreviewStatus) => {
        if (cancelled) return;
        setStatus(body);
        setStatusError(body.statusError || null);
      })
      .catch((error: Error) => {
        if (cancelled) return;
        setStatusError(
          error.message ||
            t("pilotDeckConfig.panels.officePreview.status.error"),
        );
      })
      .finally(() => {
        if (!cancelled) setStatusLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [statusReloadKey, t]);

  const libreOfficeStatusKnown =
    status?.libreOffice?.available !== undefined;
  const libreOfficeAvailable = status?.libreOffice?.available === true;
  const libreOfficeUnavailable =
    !statusLoading && status?.libreOffice?.available === false;
  const showLibreOfficeStatus =
    service === "libreoffice" && libreOfficeStatusKnown;
  const libreOfficeUnknown =
    showLibreOfficeStatus &&
    !statusLoading &&
    !statusError &&
    !libreOfficeStatusKnown;
  useEffect(() => {
    if (!binaryPathEditing) setBinaryPathDraft(configuredBinaryPath);
  }, [binaryPathEditing, configuredBinaryPath]);

  const setService = (next: OfficePreviewService) =>
    onChange(
      patch(config, ["webui", "officePreview", "service"], next),
    );
  const setBinaryPath = (next: string) =>
    onChange(
      patch(config, ["webui", "officePreview", "binaryPath"], next),
    );
  const scanLibreOfficePaths = () => {
    setStatusReloadKey((value) => value + 1);
  };
  const startEditingBinaryPath = () => {
    setBinaryPathDraft(configuredBinaryPath);
    setBinaryPathEditing(true);
  };
  const cancelEditingBinaryPath = () => {
    setBinaryPathDraft(configuredBinaryPath);
    setBinaryPathEditing(false);
  };
  const saveBinaryPath = () => {
    setBinaryPath(binaryPathDraft);
    setBinaryPathEditing(false);
  };

  return (
    <SettingsSection
      title={t("pilotDeckConfig.panels.officePreview.title")}
      description={t("pilotDeckConfig.panels.officePreview.description")}
      className="office-config-section"
    >
      <SettingsCard className="office-card">
        <div className="office-card-body">
          <FormRow
            label={t(
              "pilotDeckConfig.panels.officePreview.fields.service.label",
            )}
            description={t(
              "pilotDeckConfig.panels.officePreview.fields.service.description",
            )}
            className="office-setting-row office-service-row"
          >
            <div className="office-select-wrap">
              <Select
                value={service}
                onChange={(value) =>
                  setService(value as OfficePreviewService)
                }
                options={[
                  {
                    value: "builtin",
                    label: t(
                      "pilotDeckConfig.panels.officePreview.options.builtin",
                    ),
                  },
                  {
                    value: "libreoffice",
                    label: libreOfficeUnavailable
                      ? t(
                          "pilotDeckConfig.panels.officePreview.options.libreOfficeUnavailable",
                        )
                      : t(
                          "pilotDeckConfig.panels.officePreview.options.libreOffice",
                        ),
                  },
                ]}
              />
            </div>
          </FormRow>

          {service === "libreoffice" && (
            <FormRow
              label={t(
                "pilotDeckConfig.panels.officePreview.fields.binaryPath.label",
              )}
              description={t(
                "pilotDeckConfig.panels.officePreview.fields.binaryPath.description",
              )}
              className="office-setting-row office-path-row"
            >
              <div className="office-path-control">
                <div className="office-path-input-row">
                  <div className="office-path-input">
                    <input
                      value={
                        binaryPathEditing
                          ? binaryPathDraft
                          : configuredBinaryPath
                      }
                      placeholder={t(
                        "pilotDeckConfig.panels.officePreview.fields.binaryPath.placeholder",
                      )}
                      readOnly={!binaryPathEditing}
                      aria-label={t(
                        "pilotDeckConfig.panels.officePreview.fields.binaryPath.label",
                      )}
                      onChange={(event) =>
                        setBinaryPathDraft(event.target.value)
                      }
                      onKeyDown={(event) => {
                        if (event.key === "Enter") saveBinaryPath();
                        if (event.key === "Escape") {
                          cancelEditingBinaryPath();
                        }
                      }}
                    />
                  </div>
                  <div className="office-path-actions">
                    {binaryPathEditing ? (
                      <>
                        <button
                          type="button"
                          onClick={cancelEditingBinaryPath}
                          className="button secondary"
                        >
                          {t("settingsPage.actions.cancel")}
                        </button>
                        <button
                          type="button"
                          onClick={saveBinaryPath}
                          className="button primary"
                        >
                          {t("settingsPage.actions.save")}
                        </button>
                      </>
                    ) : (
                      <>
                        <button
                          type="button"
                          onClick={startEditingBinaryPath}
                          className="button secondary"
                        >
                          <Pencil size={14} />
                          {t("settingsPage.actions.edit")}
                        </button>
                        <button
                          type="button"
                          onClick={scanLibreOfficePaths}
                          disabled={statusLoading}
                          className="button secondary"
                        >
                          <Search size={14} />
                          {t(
                            "pilotDeckConfig.panels.officePreview.scan.button",
                          )}
                        </button>
                      </>
                    )}
                  </div>
                </div>
              </div>
            </FormRow>
          )}

          <div className="office-status-area">
            {showLibreOfficeStatus && (
              <div
                className={cn(
                  "office-status-panel",
                  libreOfficeAvailable && "available",
                )}
              >
                <div className="office-status-heading">
                  <div>
                    <span
                      className={cn(
                        "office-status-dot",
                        !libreOfficeAvailable &&
                          !libreOfficeUnavailable &&
                          !statusError &&
                          "checking",
                      )}
                    />
                    <strong>
                      {statusLoading
                        ? t(
                            "pilotDeckConfig.panels.officePreview.status.checking",
                          )
                        : statusError
                          ? t(
                              "pilotDeckConfig.panels.officePreview.status.error",
                            )
                          : libreOfficeAvailable
                              ? t(
                                "pilotDeckConfig.panels.officePreview.status.available",
                              )
                            : libreOfficeUnavailable
                              ? t(
                                  "pilotDeckConfig.panels.officePreview.status.unavailable",
                                )
                              : libreOfficeUnknown
                                ? t(
                                    "pilotDeckConfig.panels.officePreview.status.unknown",
                                  )
                                : t(
                                    "pilotDeckConfig.panels.officePreview.status.unavailable",
                                  )}
                    </strong>
                  </div>
                  <button
                    type="button"
                    onClick={() =>
                      setStatusReloadKey((value) => value + 1)
                    }
                  >
                    <RefreshCw
                      className={cn(
                        "h-3.5 w-3.5",
                        statusLoading && "animate-spin",
                      )}
                    />
                    {t(
                      "pilotDeckConfig.panels.officePreview.status.refresh",
                    )}
                  </button>
                </div>

                {libreOfficeAvailable &&
                  (status?.libreOffice?.binaryPath ||
                    status?.libreOffice?.version) && (
                    <div className="office-status-detail">
                      {status.libreOffice.binaryPath && (
                        <p title={status.libreOffice.binaryPath}>
                          <span>
                            {t(
                              "pilotDeckConfig.panels.officePreview.status.pathLabel",
                            )}
                          </span>
                          <code>{status.libreOffice.binaryPath}</code>
                        </p>
                      )}
                      {status.libreOffice.version && (
                        <p title={status.libreOffice.version}>
                          <span>
                            {t(
                              "pilotDeckConfig.panels.officePreview.status.versionLabel",
                            )}
                          </span>
                          <code>{status.libreOffice.version}</code>
                        </p>
                      )}
                    </div>
                  )}
              </div>
            )}

            {service === "builtin" && (
              <div className="office-builtin-note">
                {t(
                  "pilotDeckConfig.panels.officePreview.builtinNote",
                )}
              </div>
            )}

            {service === "libreoffice" && libreOfficeUnavailable && (
              <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-[12px] leading-5 text-amber-700 dark:text-amber-300">
                <AlertCircle className="mt-0.5 h-4 w-4 flex-shrink-0" />
                <div>
                  {t(
                    "pilotDeckConfig.panels.officePreview.unavailableWarning",
                  )}
                </div>
              </div>
            )}

            {service === "libreoffice" && statusError && (
              <div className="rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-[12px] leading-5 text-destructive">
                {statusError}
              </div>
            )}
          </div>
        </div>
      </SettingsCard>
    </SettingsSection>
  );
}

export default function OfficePreviewSections({
  title,
}: OfficePreviewSectionsProps) {
  const { t } = useTranslation("settings");
  const { raw, setRaw, save, loading, error } = usePilotDeckConfig();
  const parsedConfig = useMemo(() => safeParseYaml(raw), [raw]);

  const onFormChange = async (next: PilotDeckConfig) => {
    try {
      setRaw(configToYamlString(next));
      await save();
    } catch (caught) {
      console.error(
        "Failed to serialise Office preview config patch",
        caught,
      );
    }
  };

  if (loading) {
    return (
      <div className="space-y-6">
        <h2 className="text-2xl font-semibold text-foreground">{title}</h2>
        <div className="py-6 text-xs text-muted-foreground">
          {t("pilotDeckConfig.loading")}
        </div>
      </div>
    );
  }

  if (!parsedConfig) {
    return (
      <div className="space-y-6">
        <h2 className="text-2xl font-semibold text-foreground">{title}</h2>
        <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
          {t("settingsPage.invalidYaml.officePreview")}
        </div>
      </div>
    );
  }

  return (
    <div className="office-page-content">
      <h2 className="text-2xl font-semibold text-foreground">{title}</h2>
      <ConfigSaveError error={error} />
      <OfficePreviewSection
        config={parsedConfig}
        onChange={onFormChange}
      />
    </div>
  );
}
