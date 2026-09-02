import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import { cn } from "../../../../lib/utils";
import { authenticatedFetch } from "../../../../utils/api";
import type { SettingsProject } from "../../shared/types";

type MemoryProjectTarget = {
  value: string;
  label: string;
  path: string;
};

type MemoryDataSectionProps = {
  projects: SettingsProject[];
};

const MEMORY_GENERAL_TARGET = "general";

function memoryProjectPath(project: SettingsProject): string {
  return (project.fullPath || project.path || "").trim();
}

function memoryProjectName(
  project: SettingsProject,
  fallback: string,
): string {
  const direct = (project.name || project.displayName || "").trim();
  if (direct) return direct;

  const root = memoryProjectPath(project);
  const tail = root
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .filter(Boolean)
    .pop();
  return tail || fallback;
}

function isGeneralProject(project: SettingsProject): boolean {
  const name = (project.name || "").trim();
  const displayName = (project.displayName || "").trim();
  return name === MEMORY_GENERAL_TARGET || displayName === MEMORY_GENERAL_TARGET;
}

function withMemoryProjectPath(url: string, projectPath: string): string {
  if (!projectPath) return url;
  const separator = url.includes("?") ? "&" : "?";
  return `${url}${separator}projectPath=${encodeURIComponent(projectPath)}`;
}

function parseMemoryJson(raw: string): Record<string, unknown> | null {
  try {
    const value = JSON.parse(raw) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  return null;
}

function memoryApiErrorMessage(
  response: Response,
  raw: string,
  body: Record<string, unknown> | null,
): string {
  const bodyError = typeof body?.error === "string" ? body.error : "";
  return bodyError || raw || `Request failed: ${response.status}`;
}

function downloadMemoryText(raw: string, fileName: string) {
  const blob = new Blob([raw], { type: "application/json" });
  const href = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = href;
  link.download = fileName;
  link.click();
  URL.revokeObjectURL(href);
}

function safeDownloadToken(value: string): string {
  return (
    value
      .trim()
      .replace(/[^\w.-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 64) || "memory"
  );
}

function ChevronIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="14"
      height="14"
      fill="currentColor"
      viewBox="0 0 256 256"
      aria-hidden="true"
    >
      <path d="M216.49,104.49l-80,80a12,12,0,0,1-17,0l-80-80a12,12,0,0,1,17-17L128,159l71.51-71.52a12,12,0,0,1,17,17Z" />
    </svg>
  );
}

function ExportIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="18"
      height="18"
      fill="currentColor"
      viewBox="0 0 256 256"
    >
      <path d="M224,144v64a8,8,0,0,1-8,8H40a8,8,0,0,1-8-8V144a8,8,0,0,1,16,0v56H208V144a8,8,0,0,1,16,0Zm-101.66,5.66a8,8,0,0,0,11.32,0l40-40a8,8,0,0,0-11.32-11.32L136,124.69V32a8,8,0,0,0-16,0v92.69L93.66,98.34a8,8,0,0,0-11.32,11.32Z" />
    </svg>
  );
}

function ImportIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="18"
      height="18"
      fill="currentColor"
      viewBox="0 0 256 256"
    >
      <path d="M224,144v64a8,8,0,0,1-8,8H40a8,8,0,0,1-8-8V144a8,8,0,0,1,16,0v56H208V144a8,8,0,0,1,16,0ZM93.66,77.66,120,51.31V144a8,8,0,0,0,16,0V51.31l26.34,26.35a8,8,0,0,0,11.32-11.32l-40-40a8,8,0,0,0-11.32,0l-40,40A8,8,0,0,0,93.66,77.66Z" />
    </svg>
  );
}

function ClearIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="18"
      height="18"
      fill="currentColor"
      viewBox="0 0 256 256"
    >
      <path d="M216,48H180V36A28,28,0,0,0,152,8H104A28,28,0,0,0,76,36V48H40a12,12,0,0,0,0,24h4V208a20,20,0,0,0,20,20H192a20,20,0,0,0,20-20V72h4a12,12,0,0,0,0-24ZM100,36a4,4,0,0,1,4-4h48a4,4,0,0,1,4,4V48H100Zm88,168H68V72H188ZM116,104v64a12,12,0,0,1-24,0V104a12,12,0,0,1,24,0Zm48,0v64a12,12,0,0,1-24,0V104a12,12,0,0,1,24,0Z" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      width="18"
      height="18"
      fill="currentColor"
      viewBox="0 0 256 256"
    >
      <path d="M205.66,194.34a8,8,0,0,1-11.32,11.32L128,139.31,61.66,205.66a8,8,0,0,1-11.32-11.32L116.69,128,50.34,61.66A8,8,0,0,1,61.66,50.34L128,116.69l66.34-66.35a8,8,0,0,1,11.32,11.32L139.31,128Z" />
    </svg>
  );
}

export default function MemoryDataSection({
  projects,
}: MemoryDataSectionProps) {
  const { t } = useTranslation("settings");
  const importInputRef = useRef<HTMLInputElement>(null);
  const [actionBusy, setActionBusy] = useState(false);
  const [clearModalOpen, setClearModalOpen] = useState(false);

  const generalProjectPath = useMemo(() => {
    const general = projects.find(isGeneralProject);
    return general ? memoryProjectPath(general) : "";
  }, [projects]);

  const projectTargets = useMemo(() => {
    const seenNames = new Set<string>([MEMORY_GENERAL_TARGET]);
    const seenPaths = new Set<string>();
    const fallback = t(
      "pilotDeckConfig.panels.memory.data.target.projectFallback",
    );
    return projects.reduce<MemoryProjectTarget[]>((items, project) => {
      if (isGeneralProject(project)) return items;
      const path = memoryProjectPath(project);
      if (!path || seenPaths.has(path)) return items;
      seenPaths.add(path);
      let value = memoryProjectName(project, fallback);
      if (seenNames.has(value)) {
        value = `${value}-${items.length + 1}`;
      }
      seenNames.add(value);
      items.push({
        value,
        label: value,
        path,
      });
      return items;
    }, []);
  }, [projects, t]);

  const [selectedMemoryTarget, setSelectedMemoryTarget] = useState(
    MEMORY_GENERAL_TARGET,
  );

  const memoryTargetOptions = useMemo(
    () => [
      {
        value: MEMORY_GENERAL_TARGET,
        label: t("pilotDeckConfig.panels.memory.data.target.all"),
      },
      ...projectTargets.map((target) => ({
        value: target.value,
        label: target.label,
      })),
    ],
    [projectTargets, t],
  );

  useEffect(() => {
    if (
      !memoryTargetOptions.some(
        (option) => option.value === selectedMemoryTarget,
      )
    ) {
      setSelectedMemoryTarget(MEMORY_GENERAL_TARGET);
    }
  }, [memoryTargetOptions, selectedMemoryTarget]);

  const targetIsAllMemory = selectedMemoryTarget === MEMORY_GENERAL_TARGET;
  const selectedProjectTarget = targetIsAllMemory
    ? null
    : projectTargets.find((target) => target.value === selectedMemoryTarget) ??
      null;
  const selectedProjectPath = selectedProjectTarget?.path ?? "";
  const dashboardProjectPath =
    selectedProjectPath || generalProjectPath || projectTargets[0]?.path || "";
  const selectedTargetLabel = targetIsAllMemory
    ? t("pilotDeckConfig.panels.memory.data.target.all")
    : selectedProjectTarget?.label ??
      t("pilotDeckConfig.panels.memory.data.target.projectFallback");
  const canManageTarget = targetIsAllMemory || Boolean(selectedProjectPath);
  const actionsDisabled = actionBusy || !canManageTarget;

  const readMemoryResponse = async (response: Response) => {
    const raw = await response.text();
    const body = parseMemoryJson(raw);
    if (!response.ok) {
      throw new Error(memoryApiErrorMessage(response, raw, body));
    }
    return { raw, body };
  };

  const handleExportMemory = async () => {
    if (!canManageTarget) return;

    setActionBusy(true);
    try {
      const url = targetIsAllMemory
        ? "/api/memory/export/all-projects"
        : withMemoryProjectPath(
            "/api/memory/export/current-project",
            selectedProjectPath,
          );
      const response = await authenticatedFetch(url, {
        suppressServerErrorToast: true,
      });
      const { raw, body } = await readMemoryResponse(response);
      if (!body) return;
      const prefix = targetIsAllMemory
        ? "pilotdeck-memory-all"
        : `pilotdeck-memory-${safeDownloadToken(selectedTargetLabel)}`;
      downloadMemoryText(raw, `${prefix}-${Date.now()}.json`);
    } catch {
      // Status banners on this page are intentionally omitted.
    } finally {
      setActionBusy(false);
    }
  };

  const handleImportMemoryFile = async (file: File | null) => {
    if (!file || !canManageTarget) return;

    let payload: Record<string, unknown> | null = null;
    try {
      payload = parseMemoryJson(await file.text());
    } catch {
      payload = null;
    }
    if (!payload) return;

    const confirmKey = targetIsAllMemory
      ? "pilotDeckConfig.panels.memory.data.confirm.importAll"
      : "pilotDeckConfig.panels.memory.data.confirm.importProject";
    if (!window.confirm(t(confirmKey, { target: selectedTargetLabel }))) {
      return;
    }

    setActionBusy(true);
    try {
      const url = targetIsAllMemory
        ? "/api/memory/import/all-projects"
        : withMemoryProjectPath(
            "/api/memory/import/current-project",
            selectedProjectPath,
          );
      await authenticatedFetch(url, {
        method: "POST",
        body: JSON.stringify(payload),
        suppressServerErrorToast: true,
      }).then(readMemoryResponse);
    } catch {
      // Status banners on this page are intentionally omitted.
    } finally {
      setActionBusy(false);
    }
  };

  const closeClearModal = () => {
    if (actionBusy) return;
    setClearModalOpen(false);
  };

  const handleClearMemory = () => {
    if (!canManageTarget) return;
    setClearModalOpen(true);
  };

  const confirmClearMemory = async () => {
    if (!canManageTarget) return;

    setActionBusy(true);
    try {
      const response = await authenticatedFetch("/api/memory/clear", {
        method: "POST",
        body: JSON.stringify(
          targetIsAllMemory
            ? {
                scope: "all_memory",
                ...(dashboardProjectPath
                  ? { projectPath: dashboardProjectPath }
                  : {}),
              }
            : {
                scope: "current_project",
                projectPath: selectedProjectPath,
              },
        ),
        suppressServerErrorToast: true,
      });
      await readMemoryResponse(response);
      setClearModalOpen(false);
    } catch {
      // Status banners on this page are intentionally omitted.
    } finally {
      setActionBusy(false);
    }
  };

  useEffect(() => {
    if (!clearModalOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeClearModal();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [actionBusy, clearModalOpen]);

  return (
    <>
    <section
      className="memory-data-section"
      aria-labelledby="memory-data-title"
    >
      <div className="memory-card memory-data-card">
        <header className="memory-data-header">
          <div>
            <h2 id="memory-data-title">
              {t("pilotDeckConfig.panels.memory.data.title")}
            </h2>
            <p>{t("pilotDeckConfig.panels.memory.data.description")}</p>
          </div>
        </header>
        <div className="memory-data-selector-row">
          <div className="memory-setting-copy">
            <label htmlFor="memory-project">
              {t("pilotDeckConfig.panels.memory.data.target.label")}
            </label>
          </div>
          <div className="memory-data-controls">
            <div className="memory-select-wrap memory-project-select">
              <select
                id="memory-project"
                value={selectedMemoryTarget}
                onChange={(event) => {
                  setSelectedMemoryTarget(event.target.value);
                }}
              >
                {memoryTargetOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
              <ChevronIcon />
            </div>
            <div className="memory-data-actions">
              <button
                className="button secondary"
                type="button"
                disabled={actionsDisabled}
                onClick={() => void handleExportMemory()}
              >
                <ExportIcon />
                {t("pilotDeckConfig.panels.memory.data.actions.export")}
              </button>
              <label
                className={cn(
                  "button secondary memory-import-button",
                  actionsDisabled && "disabled",
                )}
              >
                <ImportIcon />
                <span>
                  {t("pilotDeckConfig.panels.memory.data.actions.import")}
                </span>
                <input
                  ref={importInputRef}
                  className="memory-import-input"
                  accept="application/json,.json"
                  aria-label={t(
                    "pilotDeckConfig.panels.memory.data.actions.import",
                  )}
                  type="file"
                  disabled={actionsDisabled}
                  onChange={(event) => {
                    const input = event.currentTarget;
                    void handleImportMemoryFile(input.files?.[0] ?? null).finally(
                      () => {
                        input.value = "";
                      },
                    );
                  }}
                />
              </label>
              <button
                className="button danger memory-clear-button"
                type="button"
                disabled={actionsDisabled}
                onClick={handleClearMemory}
              >
                <ClearIcon />
                {t("pilotDeckConfig.panels.memory.data.actions.clear")}
              </button>
            </div>
          </div>
        </div>
      </div>
    </section>
    {clearModalOpen ? (
      <div
        className="modal-backdrop"
        role="presentation"
        onMouseDown={(event) => {
          if (event.target === event.currentTarget) closeClearModal();
        }}
      >
        <section
          className="modal memory-clear-modal simple-delete-modal"
          role="dialog"
          aria-modal="true"
          aria-labelledby="modal-title"
        >
          <header className="modal-header">
            <div>
              <h2 id="modal-title">
                {t(
                  "pilotDeckConfig.panels.memory.data.confirm.clearModalTitle",
                  { name: selectedMemoryTarget },
                )}
              </h2>
              <p>
                {t(
                  "pilotDeckConfig.panels.memory.data.confirm.clearModalDescription",
                )}
              </p>
            </div>
            <button
              className="icon-button"
              type="button"
              aria-label={t(
                "pilotDeckConfig.panels.memory.data.confirm.clearModalClose",
              )}
              disabled={actionBusy}
              onClick={closeClearModal}
            >
              <CloseIcon />
            </button>
          </header>
          <footer className="modal-actions">
            <button
              className="button secondary"
              type="button"
              disabled={actionBusy}
              onClick={closeClearModal}
            >
              {t("settingsPage.actions.cancel")}
            </button>
            <button
              className="button danger"
              type="button"
              disabled={actionBusy}
              onClick={() => void confirmClearMemory()}
            >
              {t(
                "pilotDeckConfig.panels.memory.data.confirm.clearModalConfirm",
              )}
            </button>
          </footer>
        </section>
      </div>
    ) : null}
    </>
  );
}
