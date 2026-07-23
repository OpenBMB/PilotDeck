import { useEffect, useMemo, useRef, useState } from "react";
import { useTranslation } from "react-i18next";
import {
  AlertCircle,
  CheckCircle2,
  Download,
  Loader2,
  Trash2,
  Upload,
} from "lucide-react";
import { Button } from "../../../../shared/view/ui";
import { cn } from "../../../../lib/utils";
import { authenticatedFetch } from "../../../../utils/api";
import type { SettingsProject } from "../../shared/types";
import { FormRow, Select } from "../../shared/components/Inputs";
import { SettingsCard, SettingsSection } from "../../shared/view";

type MemoryActionState = {
  kind: "idle" | "busy" | "success" | "error";
  message?: string;
};

type MemoryProjectTarget = {
  value: string;
  label: string;
  path: string;
};

type MemoryDataSectionProps = {
  projects: SettingsProject[];
};

const MEMORY_ALL_TARGET = "all_memory";

function memoryProjectPath(project: SettingsProject): string {
  return (project.fullPath || project.path || "").trim();
}

function memoryProjectLabel(
  project: SettingsProject,
  fallback: string,
): string {
  const direct = (project.displayName || project.name || "").trim();
  if (direct) return direct;

  const root = memoryProjectPath(project);
  const tail = root
    .replace(/[\\/]+$/, "")
    .split(/[\\/]/)
    .filter(Boolean)
    .pop();
  return tail || fallback;
}

function memoryProjectTargetValue(projectPath: string): string {
  return `project:${projectPath}`;
}

function memoryProjectPathFromTarget(target: string): string {
  return target.startsWith("project:") ? target.slice("project:".length) : "";
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

export default function MemoryDataSection({
  projects,
}: MemoryDataSectionProps) {
  const { t } = useTranslation("settings");
  const importInputRef = useRef<HTMLInputElement>(null);
  const [memoryAction, setMemoryAction] = useState<MemoryActionState>({
    kind: "idle",
  });

  const projectTargets = useMemo(() => {
    const seen = new Set<string>();
    const fallback = t(
      "pilotDeckConfig.panels.memory.data.target.projectFallback",
    );
    return projects.reduce<MemoryProjectTarget[]>((items, project) => {
      const path = memoryProjectPath(project);
      if (!path || seen.has(path)) return items;
      seen.add(path);
      items.push({
        value: memoryProjectTargetValue(path),
        label: memoryProjectLabel(project, fallback),
        path,
      });
      return items;
    }, []);
  }, [projects, t]);

  const [selectedMemoryTarget, setSelectedMemoryTarget] = useState(
    () => projectTargets[0]?.value ?? MEMORY_ALL_TARGET,
  );

  const memoryTargetOptions = useMemo(
    () => [
      ...projectTargets.map((target) => ({
        value: target.value,
        label: target.label,
      })),
      {
        value: MEMORY_ALL_TARGET,
        label: t("pilotDeckConfig.panels.memory.data.target.all"),
      },
    ],
    [projectTargets, t],
  );

  useEffect(() => {
    if (
      !memoryTargetOptions.some(
        (option) => option.value === selectedMemoryTarget,
      )
    ) {
      setSelectedMemoryTarget(
        projectTargets[0]?.value ?? MEMORY_ALL_TARGET,
      );
    }
  }, [memoryTargetOptions, projectTargets, selectedMemoryTarget]);

  const targetIsAllMemory = selectedMemoryTarget === MEMORY_ALL_TARGET;
  const selectedProjectPath = targetIsAllMemory
    ? ""
    : memoryProjectPathFromTarget(selectedMemoryTarget);
  const selectedProjectTarget =
    projectTargets.find((target) => target.path === selectedProjectPath) ??
    null;
  const dashboardProjectPath =
    selectedProjectPath || projectTargets[0]?.path || "";
  const selectedTargetLabel = targetIsAllMemory
    ? t("pilotDeckConfig.panels.memory.data.target.all")
    : selectedProjectTarget?.label ??
      t("pilotDeckConfig.panels.memory.data.target.projectFallback");
  const actionBusy = memoryAction.kind === "busy";
  const canManageTarget = targetIsAllMemory || Boolean(selectedProjectPath);

  const readMemoryResponse = async (response: Response) => {
    const raw = await response.text();
    const body = parseMemoryJson(raw);
    if (!response.ok) {
      throw new Error(memoryApiErrorMessage(response, raw, body));
    }
    return { raw, body };
  };

  const setActionBusy = (messageKey: string) => {
    setMemoryAction({
      kind: "busy",
      message: t(messageKey, { target: selectedTargetLabel }),
    });
  };

  const setActionSuccess = (messageKey: string, warnings?: unknown) => {
    const warningList = Array.isArray(warnings)
      ? warnings.filter(
          (warning): warning is string =>
            typeof warning === "string" && warning.trim().length > 0,
        )
      : [];
    setMemoryAction({
      kind: "success",
      message: `${t(messageKey, { target: selectedTargetLabel })}${
        warningList.length > 0 ? ` ${warningList.join(" ")}` : ""
      }`,
    });
  };

  const setActionError = (error: unknown) => {
    setMemoryAction({
      kind: "error",
      message: error instanceof Error ? error.message : String(error),
    });
  };

  const handleExportMemory = async () => {
    if (!canManageTarget) {
      setMemoryAction({
        kind: "error",
        message: t(
          "pilotDeckConfig.panels.memory.data.errors.missingProject",
        ),
      });
      return;
    }

    setActionBusy("pilotDeckConfig.panels.memory.data.status.exporting");
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
      if (!body) {
        throw new Error(
          t("pilotDeckConfig.panels.memory.data.errors.invalidExport"),
        );
      }
      const prefix = targetIsAllMemory
        ? "pilotdeck-memory-all"
        : `pilotdeck-memory-${safeDownloadToken(selectedTargetLabel)}`;
      downloadMemoryText(raw, `${prefix}-${Date.now()}.json`);
      setActionSuccess("pilotDeckConfig.panels.memory.data.status.exported");
    } catch (error) {
      setActionError(error);
    }
  };

  const handleImportMemoryFile = async (file: File | null) => {
    if (!file) return;
    if (!canManageTarget) {
      setMemoryAction({
        kind: "error",
        message: t(
          "pilotDeckConfig.panels.memory.data.errors.missingProject",
        ),
      });
      return;
    }

    let payload: Record<string, unknown> | null = null;
    try {
      payload = parseMemoryJson(await file.text());
    } catch {
      payload = null;
    }
    if (!payload) {
      setMemoryAction({
        kind: "error",
        message: t(
          "pilotDeckConfig.panels.memory.data.errors.invalidImport",
        ),
      });
      return;
    }

    const confirmKey = targetIsAllMemory
      ? "pilotDeckConfig.panels.memory.data.confirm.importAll"
      : "pilotDeckConfig.panels.memory.data.confirm.importProject";
    if (!window.confirm(t(confirmKey, { target: selectedTargetLabel }))) {
      return;
    }

    setActionBusy("pilotDeckConfig.panels.memory.data.status.importing");
    try {
      const url = targetIsAllMemory
        ? "/api/memory/import/all-projects"
        : withMemoryProjectPath(
            "/api/memory/import/current-project",
            selectedProjectPath,
          );
      const response = await authenticatedFetch(url, {
        method: "POST",
        body: JSON.stringify(payload),
        suppressServerErrorToast: true,
      });
      const { body } = await readMemoryResponse(response);
      setActionSuccess(
        "pilotDeckConfig.panels.memory.data.status.imported",
        body?.warnings,
      );
    } catch (error) {
      setActionError(error);
    }
  };

  const handleClearMemory = async () => {
    if (!canManageTarget) {
      setMemoryAction({
        kind: "error",
        message: t(
          "pilotDeckConfig.panels.memory.data.errors.missingProject",
        ),
      });
      return;
    }

    const confirmKey = targetIsAllMemory
      ? "pilotDeckConfig.panels.memory.data.confirm.clearAll"
      : "pilotDeckConfig.panels.memory.data.confirm.clearProject";
    if (!window.confirm(t(confirmKey, { target: selectedTargetLabel }))) {
      return;
    }

    setActionBusy("pilotDeckConfig.panels.memory.data.status.clearing");
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
      setActionSuccess("pilotDeckConfig.panels.memory.data.status.cleared");
    } catch (error) {
      setActionError(error);
    }
  };

  const memoryActionTone =
    memoryAction.kind === "error"
      ? "border-destructive/30 bg-destructive/10 text-destructive"
      : memoryAction.kind === "success"
        ? "border-green-500/30 bg-green-500/10 text-green-700 dark:text-green-300"
        : "border-border bg-muted/40 text-muted-foreground";

  return (
    <SettingsSection
      title={t("pilotDeckConfig.panels.memory.data.title")}
      description={t("pilotDeckConfig.panels.memory.data.description")}
    >
      <SettingsCard divided>
        <FormRow
          label={t("pilotDeckConfig.panels.memory.data.target.label")}
          description={t(
            "pilotDeckConfig.panels.memory.data.target.description",
          )}
        >
          <Select
            value={selectedMemoryTarget}
            options={memoryTargetOptions}
            onChange={(value) => {
              setSelectedMemoryTarget(value);
              setMemoryAction({ kind: "idle" });
            }}
          />
        </FormRow>
        <div className="px-4 py-3">
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 px-2.5 text-xs"
              disabled={actionBusy || !canManageTarget}
              onClick={() => void handleExportMemory()}
            >
              <Download className="mr-1.5 h-3.5 w-3.5" />
              {t("pilotDeckConfig.panels.memory.data.actions.export")}
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="h-8 gap-1.5 px-2.5 text-xs"
              disabled={actionBusy || !canManageTarget}
              onClick={() => importInputRef.current?.click()}
            >
              <Upload className="mr-1.5 h-3.5 w-3.5" />
              {t("pilotDeckConfig.panels.memory.data.actions.import")}
            </Button>
            <Button
              type="button"
              variant="destructive"
              size="sm"
              className="h-8 gap-1.5 px-2.5 text-xs"
              disabled={actionBusy || !canManageTarget}
              onClick={() => void handleClearMemory()}
            >
              <Trash2 className="mr-1.5 h-3.5 w-3.5" />
              {t("pilotDeckConfig.panels.memory.data.actions.clear")}
            </Button>
          </div>
          <input
            ref={importInputRef}
            type="file"
            accept="application/json,.json"
            className="hidden"
            onChange={(event) => {
              const input = event.currentTarget;
              void handleImportMemoryFile(input.files?.[0] ?? null).finally(
                () => {
                  input.value = "";
                },
              );
            }}
          />
          {memoryAction.kind !== "idle" && memoryAction.message && (
            <div
              className={cn(
                "mt-3 flex items-start gap-2 rounded-md border px-3 py-2 text-xs leading-5",
                memoryActionTone,
              )}
            >
              {memoryAction.kind === "busy" && (
                <Loader2 className="mt-0.5 h-3.5 w-3.5 animate-spin" />
              )}
              {memoryAction.kind === "success" && (
                <CheckCircle2 className="mt-0.5 h-3.5 w-3.5" />
              )}
              {memoryAction.kind === "error" && (
                <AlertCircle className="mt-0.5 h-3.5 w-3.5" />
              )}
              <span>{memoryAction.message}</span>
            </div>
          )}
        </div>
      </SettingsCard>
    </SettingsSection>
  );
}
