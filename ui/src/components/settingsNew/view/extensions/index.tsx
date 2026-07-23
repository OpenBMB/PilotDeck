import { useEffect, useMemo, useState } from "react";
import { Loader2, Plus, RefreshCw, Save, Server } from "lucide-react";
import { useTranslation } from "react-i18next";
import { Button } from "../../../../shared/view/ui";
import { authenticatedFetch } from "../../../../utils/api";
import { cn } from "../../../../lib/utils";
import type { SettingsProject } from "../../shared/types";
import { PageSectionHeader } from "../../shared/view";
import McpServerFormCard from "./components/McpServerFormCard";
import AdvancedJsonEditor from "./components/AdvancedJsonEditor";
import type { McpConfigResponse, McpServerForm, Scope } from "./types/mcp";
import { EMPTY_CONFIG, REMOTE_TEMPLATE, STDIO_TEMPLATE } from "./utils/constants";
import {
  formFromRaw,
  parseServers,
  stringifyServers,
} from "./utils/mcpServerForm";

type McpServersSectionProps = {
  title?: string;
  projects?: SettingsProject[];
};

export default function McpServersSection({
  title,
  projects = [],
}: McpServersSectionProps) {
  const { t } = useTranslation("settings");
  const projectOptions = useMemo(() => {
    return projects
      .map((project) => ({
        label:
          project.displayName ||
          project.name ||
          project.fullPath ||
          project.path ||
          "",
        value: project.fullPath || project.path || "",
      }))
      .filter((project) => project.value);
  }, [projects]);
  const [projectPath, setProjectPath] = useState(projectOptions[0]?.value ?? "");
  const [scope, setScope] = useState<Scope>("global");
  const [configs, setConfigs] = useState<McpConfigResponse | null>(null);
  const [drafts, setDrafts] = useState<Record<Scope, string>>({
    global: EMPTY_CONFIG,
    project: EMPTY_CONFIG,
  });
  const [serverDrafts, setServerDrafts] = useState<Record<Scope, McpServerForm[]>>({
    global: [],
    project: [],
  });
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!projectPath && projectOptions[0]?.value) {
      setProjectPath(projectOptions[0].value);
    }
  }, [projectOptions, projectPath]);

  const load = async () => {
    setLoading(true);
    setError(null);
    try {
      const query = projectPath
        ? `?projectPath=${encodeURIComponent(projectPath)}`
        : "";
      const response = await authenticatedFetch(`/api/mcp/config${query}`);
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.details || data.error || "Failed to load MCP config");
      setConfigs({ global: data.global, project: data.project });
      setDrafts({ global: data.global.raw, project: data.project.raw });
      setServerDrafts({
        global: parseServers(data.global.raw).servers,
        project: parseServers(data.project.raw).servers,
      });
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to load MCP config");
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath]);

  const activeConfig = configs?.[scope];
  const activeDraft = drafts[scope];
  const activeServers = serverDrafts[scope];
  const parsedError = useMemo(() => parseServers(activeDraft).error, [activeDraft]);
  const serverCount = activeServers.length;

  const save = async () => {
    setSaving(true);
    setError(null);
    setMessage(null);
    try {
      if (activeServers.some((server) => server.name.trim().length === 0)) {
        throw new Error(t("mcpConfig.nameRequired"));
      }
      const raw = stringifyServers(activeServers);
      const response = await authenticatedFetch(`/api/mcp/config/${scope}`, {
        method: "PUT",
        body: JSON.stringify({ raw, projectPath }),
      });
      const data = await response.json();
      if (!response.ok)
        throw new Error(data.details || data.error || "Failed to save MCP config");
      setConfigs((current) => (current ? { ...current, [scope]: data } : current));
      setDrafts((current) => ({ ...current, [scope]: data.raw }));
      setServerDrafts((current) => ({
        ...current,
        [scope]: parseServers(data.raw).servers,
      }));
      setMessage(t("mcpConfig.saved"));
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Failed to save MCP config");
    } finally {
      setSaving(false);
    }
  };

  const updateServers = (servers: McpServerForm[]) => {
    setServerDrafts((current) => ({ ...current, [scope]: servers }));
    setDrafts((current) => ({ ...current, [scope]: stringifyServers(servers) }));
  };

  const updateServer = (serverId: string, patch: Partial<McpServerForm>) => {
    updateServers(
      activeServers.map((server) =>
        server.id === serverId ? { ...server, ...patch } : server,
      ),
    );
  };

  const addTemplate = (kind: "stdio" | "remote") => {
    try {
      const parsed = JSON.parse(activeDraft || EMPTY_CONFIG);
      const mcpServers =
        parsed.mcpServers && typeof parsed.mcpServers === "object"
          ? parsed.mcpServers
          : {};
      const baseName = kind === "stdio" ? "new-stdio-server" : "new-remote-server";
      let candidate = baseName;
      let index = 2;
      while (mcpServers[candidate]) {
        candidate = `${baseName}-${index}`;
        index += 1;
      }
      const nextServer = formFromRaw(
        candidate,
        kind === "stdio" ? STDIO_TEMPLATE : REMOTE_TEMPLATE,
      );
      updateServers([...activeServers, nextServer]);
    } catch {
      setError(t("mcpConfig.fixJsonBeforeTemplate"));
    }
  };

  const removeServer = (serverId: string) => {
    updateServers(activeServers.filter((server) => server.id !== serverId));
  };

  const updateAdvancedJson = (value: string) => {
    setDrafts((current) => ({ ...current, [scope]: value }));
    const parsed = parseServers(value);
    if (!parsed.error) {
      setServerDrafts((current) => ({ ...current, [scope]: parsed.servers }));
    }
  };

  return (
    <div className="space-y-6">
      {title ? <h2 className="text-2xl font-semibold text-foreground">{title}</h2> : null}
      <div className="space-y-5">
        <div className="rounded-lg border border-border bg-card/60 p-4">
          <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
            <div className="flex items-center gap-3">
              <Server className="h-5 w-5 text-muted-foreground" />
              <PageSectionHeader
                title={t("mcpConfig.title")}
                description={t("mcpConfig.description")}
                className="space-y-1"
              />
            </div>
            <Button variant="outline" size="sm" onClick={() => void load()} disabled={loading}>
              <RefreshCw className={cn("h-4 w-4", loading && "animate-spin")} />
              {t("pilotDeckConfig.actions.refresh")}
            </Button>
          </div>
        </div>

        {projectOptions.length > 0 && (
          <label className="block space-y-2">
            <span className="text-sm text-muted-foreground">
              {t("mcpConfig.project")}
            </span>
            <select
              value={projectPath}
              onChange={(event) => setProjectPath(event.target.value)}
              className="h-9 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none focus:ring-1 focus:ring-ring"
            >
              {projectOptions.map((project) => (
                <option key={project.value} value={project.value}>
                  {project.label}
                </option>
              ))}
            </select>
          </label>
        )}

        <div className="flex rounded-lg border border-border bg-muted/40 p-1">
          {(["global", "project"] as Scope[]).map((item) => (
            <button
              key={item}
              type="button"
              onClick={() => setScope(item)}
              disabled={item === "project" && !projectPath}
              className={cn(
                "flex-1 rounded-md px-3 py-2 text-sm font-medium transition-colors",
                scope === item
                  ? "bg-background text-foreground shadow-sm"
                  : "text-muted-foreground hover:text-foreground",
                item === "project" && !projectPath && "cursor-not-allowed opacity-50",
              )}
            >
              {t(`mcpConfig.scopes.${item}`)}
            </button>
          ))}
        </div>

        <div className="rounded-lg border border-border bg-card/60">
          <div className="flex flex-col gap-3 border-b border-border p-4 md:flex-row md:items-center md:justify-between">
            <div className="min-w-0">
              <div className="text-sm font-semibold text-foreground">
                {t("mcpConfig.serverCount", { count: serverCount })}
              </div>
              <div className="truncate text-xs text-muted-foreground">
                {activeConfig?.path || t("mcpConfig.noPath")}
              </div>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button variant="outline" size="sm" onClick={() => addTemplate("stdio")}>
                <Plus className="h-4 w-4" />
                {t("mcpConfig.addStdio")}
              </Button>
              <Button variant="outline" size="sm" onClick={() => addTemplate("remote")}>
                <Plus className="h-4 w-4" />
                {t("mcpConfig.addRemote")}
              </Button>
            </div>
          </div>

          {loading ? (
            <div className="flex h-64 items-center justify-center text-sm text-muted-foreground">
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              {t("pilotDeckConfig.loading")}
            </div>
          ) : parsedError ? (
            <div className="space-y-4 p-4">
              <div className="rounded-lg border border-destructive/40 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                {parsedError}
              </div>
              <AdvancedJsonEditor value={activeDraft} onChange={updateAdvancedJson} />
            </div>
          ) : (
            <div className="space-y-4 p-4">
              {activeServers.length === 0 ? (
                <div className="rounded-lg border border-dashed border-border px-4 py-10 text-center text-sm text-muted-foreground">
                  {t("mcpConfig.empty")}
                </div>
              ) : (
                activeServers.map((server) => (
                  <McpServerFormCard
                    key={server.id}
                    server={server}
                    onChange={(patch) => updateServer(server.id, patch)}
                    onRemove={() => removeServer(server.id)}
                  />
                ))
              )}
              <AdvancedJsonEditor value={activeDraft} onChange={updateAdvancedJson} />
            </div>
          )}
        </div>

        {(error || message) && (
          <div
            className={cn(
              "rounded-lg border px-4 py-3 text-sm",
              error
                ? "border-destructive/40 text-destructive"
                : "border-border text-muted-foreground",
            )}
          >
            {error || message}
          </div>
        )}

        <div className="flex justify-end">
          <Button
            onClick={() => void save()}
            disabled={saving || loading || (scope === "project" && !projectPath)}
          >
            {saving ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Save className="h-4 w-4" />
            )}
            {t("pilotDeckConfig.actions.saveAndReload")}
          </Button>
        </div>
      </div>
    </div>
  );
}
