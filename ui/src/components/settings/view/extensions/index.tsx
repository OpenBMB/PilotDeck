import { useEffect, useMemo, useState } from "react";
import {
  Cloud,
  Code2,
  FileText,
  Folder,
  Globe2,
  Loader2,
  Plus,
  Search,
  TerminalSquare,
  X,
} from "lucide-react";
import { useTranslation } from "react-i18next";
import { authenticatedFetch } from "../../../../utils/api";
import { cn } from "../../../../lib/utils";
import type { SettingsProject } from "../../shared/types";
import { showSettingsSuccess } from "../../shared/SettingsSuccessToast";
import McpServerFormCard from "./components/McpServerFormCard";
import AdvancedJsonEditor, {
  McpCodeIcon,
} from "./components/AdvancedJsonEditor";
import type { McpConfigResponse, McpServerForm, Scope } from "./types/mcp";
import {
  EMPTY_CONFIG,
  REMOTE_TEMPLATE,
  STDIO_TEMPLATE,
} from "./utils/constants";
import {
  formFromRaw,
  parseServers,
  stringifyServers,
} from "./utils/mcpServerForm";

type McpServersSectionProps = {
  title?: string;
  projects?: SettingsProject[];
};

type ScopeState<T> = Record<Scope, T>;

function cloneServer(server: McpServerForm): McpServerForm {
  return {
    ...server,
    args: [...server.args],
    env: server.env.map((row) => ({ ...row })),
    envPassThrough: [...server.envPassThrough],
    headers: server.headers.map((row) => ({ ...row })),
  };
}

export default function McpServersSection({
  projects = [],
}: McpServersSectionProps) {
  const { t } = useTranslation("settings");
  const projectOptions = useMemo(
    () =>
      projects
        .map((project) => ({
          label:
            project.displayName ||
            project.name ||
            project.fullPath ||
            project.path ||
            "",
          value: project.fullPath || project.path || "",
        }))
        .filter((project) => project.value),
    [projects],
  );
  const [projectPath, setProjectPath] = useState(
    projectOptions[0]?.value ?? "",
  );
  const [configs, setConfigs] = useState<McpConfigResponse | null>(null);
  const [drafts, setDrafts] = useState<ScopeState<string>>({
    global: EMPTY_CONFIG,
    project: EMPTY_CONFIG,
  });
  const [serverDrafts, setServerDrafts] = useState<ScopeState<McpServerForm[]>>(
    {
      global: [],
      project: [],
    },
  );
  const [selectedIds, setSelectedIds] = useState<ScopeState<string | null>>({
    global: null,
    project: null,
  });
  const [editingIds, setEditingIds] = useState<ScopeState<string | null>>({
    global: null,
    project: null,
  });
  const [editBackups, setEditBackups] = useState<
    ScopeState<McpServerForm | null>
  >({
    global: null,
    project: null,
  });
  const [serverSearch, setServerSearch] = useState<ScopeState<string>>({
    global: "",
    project: "",
  });
  const [projectSearch, setProjectSearch] = useState("");
  const [pendingRemoval, setPendingRemoval] = useState<{
    scope: Scope;
    server: McpServerForm;
  } | null>(null);
  const [loading, setLoading] = useState(true);
  const [savingScope, setSavingScope] = useState<Scope | null>(null);
  const [error, setError] = useState<string | null>(null);

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
      if (!response.ok) {
        throw new Error(
          data.details || data.error || "Failed to load MCP config",
        );
      }
      const nextServers: ScopeState<McpServerForm[]> = {
        global: parseServers(data.global.raw).servers,
        project: parseServers(data.project.raw).servers,
      };
      setConfigs({ global: data.global, project: data.project });
      setDrafts({ global: data.global.raw, project: data.project.raw });
      setServerDrafts(nextServers);
      setSelectedIds((current) => ({
        global:
          nextServers.global.find((server) => server.id === current.global)
            ?.id ??
          nextServers.global[0]?.id ??
          null,
        project:
          nextServers.project.find((server) => server.id === current.project)
            ?.id ??
          nextServers.project[0]?.id ??
          null,
      }));
      setEditingIds({ global: null, project: null });
      setEditBackups({ global: null, project: null });
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Failed to load MCP config",
      );
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [projectPath]);

  const updateServers = (scope: Scope, servers: McpServerForm[]) => {
    setServerDrafts((current) => ({ ...current, [scope]: servers }));
    setDrafts((current) => ({
      ...current,
      [scope]: stringifyServers(servers),
    }));
  };

  const updateServer = (
    scope: Scope,
    serverId: string,
    patch: Partial<McpServerForm>,
  ) => {
    updateServers(
      scope,
      serverDrafts[scope].map((server) =>
        server.id === serverId ? { ...server, ...patch } : server,
      ),
    );
  };

  const save = async (scope: Scope) => {
    setSavingScope(scope);
    setError(null);
    try {
      if (
        serverDrafts[scope].some((server) => server.name.trim().length === 0)
      ) {
        throw new Error(t("mcpConfig.nameRequired"));
      }
      const raw = drafts[scope];
      const parsed = parseServers(raw);
      if (parsed.error) throw new Error(parsed.error);
      const response = await authenticatedFetch(`/api/mcp/config/${scope}`, {
        method: "PUT",
        body: JSON.stringify({ raw, projectPath }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(
          data.details || data.error || "Failed to save MCP config",
        );
      }
      await load();
      showSettingsSuccess(t("mcpConfig.saved"));
    } catch (caught) {
      setError(
        caught instanceof Error ? caught.message : "Failed to save MCP config",
      );
    } finally {
      setSavingScope(null);
    }
  };

  const addTemplate = (scope: Scope, kind: "stdio" | "remote") => {
    const parsed = parseServers(drafts[scope]);
    if (parsed.error) {
      setError(t("mcpConfig.fixJsonBeforeTemplate"));
      return;
    }
    const existingNames = new Set(
      serverDrafts[scope].map((server) => server.name),
    );
    const baseName =
      kind === "stdio" ? "new-stdio-server" : "new-remote-server";
    let candidate = baseName;
    let index = 2;
    while (existingNames.has(candidate)) {
      candidate = `${baseName}-${index}`;
      index += 1;
    }
    const server = formFromRaw(
      candidate,
      kind === "stdio" ? STDIO_TEMPLATE : REMOTE_TEMPLATE,
    );
    updateServers(scope, [...serverDrafts[scope], server]);
    setSelectedIds((current) => ({ ...current, [scope]: server.id }));
    setEditingIds((current) => ({ ...current, [scope]: server.id }));
    setEditBackups((current) => ({ ...current, [scope]: null }));
  };

  const removeServer = (scope: Scope, serverId: string) => {
    const remaining = serverDrafts[scope].filter(
      (server) => server.id !== serverId,
    );
    updateServers(scope, remaining);
    setSelectedIds((current) => ({
      ...current,
      [scope]: remaining[0]?.id ?? null,
    }));
    setEditingIds((current) => ({ ...current, [scope]: null }));
  };

  const confirmRemoval = async () => {
    if (!pendingRemoval) return;
    const { scope, server } = pendingRemoval;
    const remaining = serverDrafts[scope].filter((item) => item.id !== server.id);
    setSavingScope(scope);
    setError(null);
    try {
      const response = await authenticatedFetch(`/api/mcp/config/${scope}`, {
        method: "PUT",
        body: JSON.stringify({
          raw: stringifyServers(remaining),
          projectPath,
        }),
      });
      const data = await response.json();
      if (!response.ok) {
        throw new Error(
          data.details || data.error || "Failed to remove MCP server",
        );
      }
      removeServer(scope, server.id);
      setPendingRemoval(null);
      await load();
      showSettingsSuccess(t("mcpConfig.removed"));
    } catch (caught) {
      setError(
        caught instanceof Error
          ? caught.message
          : "Failed to remove MCP server",
      );
    } finally {
      setSavingScope(null);
    }
  };

  const selectedServer = (scope: Scope) =>
    serverDrafts[scope].find((server) => server.id === selectedIds[scope]) ??
    null;

  const beginEdit = (scope: Scope, server: McpServerForm) => {
    setEditBackups((current) => ({ ...current, [scope]: cloneServer(server) }));
    setEditingIds((current) => ({ ...current, [scope]: server.id }));
  };

  const cancelEdit = (scope: Scope) => {
    const backup = editBackups[scope];
    if (backup) {
      updateServers(
        scope,
        serverDrafts[scope].map((server) =>
          server.id === backup.id ? cloneServer(backup) : server,
        ),
      );
    }
    setEditingIds((current) => ({ ...current, [scope]: null }));
    setEditBackups((current) => ({ ...current, [scope]: null }));
  };

  const updateAdvancedJson = (scope: Scope, value: string) => {
    setDrafts((current) => ({ ...current, [scope]: value }));
    const parsed = parseServers(value);
    if (!parsed.error) {
      setServerDrafts((current) => ({ ...current, [scope]: parsed.servers }));
      setSelectedIds((current) => ({
        ...current,
        [scope]: parsed.servers[0]?.id ?? null,
      }));
    }
  };

  const filteredProjects = projectOptions.filter((project) =>
    project.label
      .toLocaleLowerCase()
      .includes(projectSearch.toLocaleLowerCase()),
  );
  const parseErrors: ScopeState<string | undefined> = {
    global: parseServers(drafts.global).error,
    project: parseServers(drafts.project).error,
  };

  const renderServerRail = (scope: Scope) => {
    const query = serverSearch[scope].trim().toLocaleLowerCase();
    const servers = serverDrafts[scope].filter((server) =>
      server.name.toLocaleLowerCase().includes(query),
    );
    return (
      <aside
        className={cn(
          "mcp-server-rail",
          scope === "project" && "mcp-project-server-rail",
        )}
      >
        <header>
          <span>{t("mcpConfig.servers")}</span>
          <small>{serverDrafts[scope].length}</small>
        </header>
        <label className="mcp-server-search">
          <Search size={14} />
          <input
            placeholder={t("mcpConfig.searchServer")}
            aria-label={t("mcpConfig.searchServer")}
            value={serverSearch[scope]}
            onChange={(event) =>
              setServerSearch((current) => ({
                ...current,
                [scope]: event.target.value,
              }))
            }
          />
        </label>
        <div className="mcp-server-options">
          {servers.map((server) => (
            <button
              className={cn(
                "mcp-server-option",
                selectedIds[scope] === server.id && "selected",
              )}
              type="button"
              key={server.id}
              onClick={() =>
                setSelectedIds((current) => ({
                  ...current,
                  [scope]: server.id,
                }))
              }
            >
              <span className={cn("mcp-rail-icon", server.transport)}>
                {server.transport === "stdio" ? (
                  <TerminalSquare size={16} />
                ) : (
                  <Globe2 size={16} />
                )}
              </span>
              <span>
                <strong>{server.name || t("mcpConfig.unnamed")}</strong>
                <small>
                  {server.transport === "stdio"
                    ? server.command || t("mcpConfig.noSummary")
                    : server.url || t("mcpConfig.addressPending")}
                </small>
              </span>
              <em>{server.transport === "stdio" ? "STDIO" : "HTTP"}</em>
            </button>
          ))}
          {servers.length === 0 ? (
            <p className="mcp-server-search-empty">{t("mcpConfig.empty")}</p>
          ) : null}
        </div>
        <footer>
          <button
            type="button"
            onClick={() => addTemplate(scope, "stdio")}
            disabled={scope === "project" && !projectPath}
          >
            <Plus size={16} />
            STDIO
          </button>
          <button
            type="button"
            onClick={() => addTemplate(scope, "remote")}
            disabled={scope === "project" && !projectPath}
          >
            <Plus size={16} />
            {t("mcpConfig.remoteTemplate")}
          </button>
        </footer>
      </aside>
    );
  };

  const renderDetail = (scope: Scope) => {
    if (parseErrors[scope]) {
      return (
        <div className="mcp-detail-empty mcp-detail-invalid">
          <span>
            <Code2 size={21} />
          </span>
          <strong>{t("mcpConfig.invalidJson")}</strong>
          <p>{parseErrors[scope]}</p>
          <small>{t("mcpConfig.invalidJsonHelp")}</small>
        </div>
      );
    }
    const server = selectedServer(scope);
    if (!server) {
      return (
        <div className="mcp-detail-panel">
          <div className="mcp-detail-empty">
            <span>
              <Cloud size={26} />
            </span>
            <strong>{t("mcpConfig.selectOrAddServer")}</strong>
            <p>{t("mcpConfig.selectOrAddServerHelp")}</p>
            <button
              className="button primary compact"
              type="button"
              onClick={() => addTemplate(scope, "stdio")}
              disabled={scope === "project" && !projectPath}
            >
              <Plus size={15} />
              {t("mcpConfig.addStdioServer")}
            </button>
          </div>
        </div>
      );
    }
    return (
      <McpServerFormCard
        server={server}
        editing={editingIds[scope] === server.id}
        saving={savingScope === scope}
        onChange={(patch) => updateServer(scope, server.id, patch)}
        onEdit={() => beginEdit(scope, server)}
        onCancel={() => cancelEdit(scope)}
        onSave={() => void save(scope)}
        onRemove={() => setPendingRemoval({ scope, server })}
      />
    );
  };

  return (
    <div className="mcp-page-content">
      {error ? <div className="mcp-page-error">{error}</div> : null}

      <div className="mcp-card-stack">
        <section
          className="mcp-config-card global"
          aria-label={t("mcpConfig.globalTitle")}
        >
          <header className="mcp-config-card-header">
            <span className="mcp-config-card-icon">
              <Cloud size={21} />
            </span>
            <div>
              <strong>{t("mcpConfig.globalTitle")}</strong>
              <p className="mcp-header-location">
                <FileText size={13} />
                <span>{t("mcpConfig.globalLocation")}</span>
              </p>
            </div>
            <span className="mcp-config-count">
              {t("mcpConfig.serverUnit", { count: serverDrafts.global.length })}
            </span>
          </header>
          <div className="mcp-workbench">
            {renderServerRail("global")}
            {loading ? (
              <div className="mcp-detail-empty">
                <Loader2 className="spin" size={20} />
              </div>
            ) : (
              renderDetail("global")
            )}
          </div>
        </section>

        <section
          className="mcp-config-card project"
          aria-label={t("mcpConfig.projectTitle")}
        >
          <header className="mcp-config-card-header">
            <span className="mcp-config-card-icon">
              <Folder size={21} />
            </span>
            <div>
              <strong>{t("mcpConfig.projectTitle")}</strong>
              <p className="mcp-header-location">
                <FileText size={13} />
                <span>{t("mcpConfig.projectLocation")} </span>
              </p>
            </div>
          </header>
          <div className="mcp-project-workbench">
            <aside className="mcp-project-rail">
              <header>
                <span>{t("mcpConfig.projects")}</span>
                <small>{projectOptions.length}</small>
              </header>
              <label className="mcp-project-search">
                <Search size={15} />
                <input
                  placeholder={t("mcpConfig.searchProject")}
                  aria-label={t("mcpConfig.searchProject")}
                  value={projectSearch}
                  onChange={(event) => setProjectSearch(event.target.value)}
                />
              </label>
              <div className="mcp-project-options">
                {filteredProjects.map((project) => (
                  <button
                    type="button"
                    className={cn(project.value === projectPath && "selected")}
                    key={project.value}
                    onClick={() => setProjectPath(project.value)}
                  >
                    <span>{project.label}</span>
                    <small>
                      {project.value === projectPath
                        ? serverDrafts.project.length
                        : "—"}
                    </small>
                  </button>
                ))}
                {filteredProjects.length === 0 ? (
                  <p>{t("mcpConfig.noProjects")}</p>
                ) : null}
              </div>
            </aside>
            <header className="mcp-selected-project-header">
              <span>
                <Folder size={16} />
              </span>
              <strong>
                {projectOptions.find((project) => project.value === projectPath)
                  ?.label || t("mcpConfig.noProjectSelected")}
              </strong>
              <small>
                {t("mcpConfig.serverUnit", {
                  count: serverDrafts.project.length,
                })}
              </small>
            </header>
            {renderServerRail("project")}
            {loading ? (
              <div className="mcp-detail-empty">
                <Loader2 className="spin" size={20} />
              </div>
            ) : (
              renderDetail("project")
            )}
          </div>
        </section>

        <section
          className="mcp-raw-config-card"
          aria-label={t("mcpConfig.advanced")}
        >
          <header className="mcp-raw-config-header">
            <span>
              <McpCodeIcon />
            </span>
            <div>
              <strong>{t("mcpConfig.advanced")}</strong>
              <p>{t("mcpConfig.advancedDescription")}</p>
            </div>
          </header>
          <div className="mcp-raw-scope-list">
            <AdvancedJsonEditor
              label={t("mcpConfig.globalRaw")}
              path={configs?.global.path}
              value={drafts.global}
              resetValue={configs?.global.raw ?? EMPTY_CONFIG}
              onChange={(value) => updateAdvancedJson("global", value)}
              onSave={() => void save("global")}
              saving={savingScope === "global"}
            />
            <AdvancedJsonEditor
              label={t("mcpConfig.projectRaw", {
                project:
                  projectOptions.find(
                    (project) => project.value === projectPath,
                  )?.label || "",
              })}
              path={configs?.project.path}
              value={drafts.project}
              resetValue={configs?.project.raw ?? EMPTY_CONFIG}
              onChange={(value) => updateAdvancedJson("project", value)}
              onSave={() => void save("project")}
              saving={savingScope === "project"}
              disabled={!projectPath}
            />
          </div>
        </section>
      </div>

      {pendingRemoval ? (
        <div
          className="modal-backdrop"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget && !savingScope) {
              setPendingRemoval(null);
            }
          }}
        >
          <section
            className="modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="mcp-remove-modal-title"
          >
            <header className="modal-header">
              <div>
                <h2 id="mcp-remove-modal-title">{t("mcpConfig.removeTitle")}</h2>
                <p>
                  {t(
                    pendingRemoval.scope === "global"
                      ? "mcpConfig.removeGlobalDescription"
                      : "mcpConfig.removeProjectDescription",
                    {
                      server: pendingRemoval.server.name,
                      project:
                        projectOptions.find(
                          (project) => project.value === projectPath,
                        )?.label || t("mcpConfig.noProjectSelected"),
                    },
                  )}
                </p>
              </div>
              <button
                className="icon-button"
                type="button"
                aria-label={t("mcpConfig.close")}
                onClick={() => setPendingRemoval(null)}
                disabled={Boolean(savingScope)}
              >
                <X size={18} />
              </button>
            </header>
            <footer className="modal-actions">
              <button
                className="button secondary"
                type="button"
                onClick={() => setPendingRemoval(null)}
                disabled={Boolean(savingScope)}
              >
                {t("settingsPage.actions.cancel")}
              </button>
              <button
                className="button danger"
                type="button"
                onClick={() => void confirmRemoval()}
                disabled={Boolean(savingScope)}
              >
                {t("pilotDeckConfig.actions.remove")}
              </button>
            </footer>
          </section>
        </div>
      ) : null}
    </div>
  );
}
