import { useCallback, useEffect, useState } from "react";
import { Check, Copy, LogOut, RefreshCw, Server, Shield, Trash2, UserPlus } from "lucide-react";
import { useAuth } from "../../../auth/context/AuthContext";
import { api } from "../../../../utils/api";
import SettingsCard from "../../shared/view/SettingsCard";
import SettingsSection from "../../shared/view/SettingsSection";

type UserRecord = {
  id: number;
  username: string;
  displayName: string;
  systemRole: "owner" | "admin" | "member";
  mustChangePassword: boolean;
  isActive: boolean;
};

type DeviceSession = {
  id: string;
  current: boolean;
  userAgent?: string;
  lastSeenAt?: string;
  revokedAt?: string | null;
};

type InstanceRecord = {
  id: string;
  ownerDisplayName?: string;
  name: string;
  kind: "local" | "remote";
  endpoint?: string;
  status: "pending" | "approved" | "rejected";
  isDefault: boolean;
  hasCredential?: boolean;
  projectBindings?: Array<{ project_path: string; workspace_key: string }>;
};

type ProjectRecord = {
  name: string;
  displayName?: string;
  fullPath: string;
  projectRole?: "owner" | "editor" | "viewer";
};

const fieldClass = "h-9 w-full rounded-md border border-border bg-background px-3 text-sm outline-none focus:border-primary";
const buttonClass = "inline-flex h-9 items-center justify-center gap-2 rounded-md border border-border px-3 text-sm font-medium transition-colors hover:bg-muted disabled:cursor-not-allowed disabled:opacity-50";

async function readPayload(response: Response) {
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(payload.error || `Request failed (${response.status})`);
  return payload;
}

export default function AccountSections({ title }: { title: string }) {
  const { user, logout } = useAuth();
  const [authEnabled, setAuthEnabled] = useState<boolean | null>(null);
  const [ownerDisplayName, setOwnerDisplayName] = useState("Owner");
  const [ownerPassword, setOwnerPassword] = useState("");
  const [enableError, setEnableError] = useState("");
  const [saving, setSaving] = useState(false);
  const [sessions, setSessions] = useState<DeviceSession[]>([]);
  const [users, setUsers] = useState<UserRecord[]>([]);
  const [auditEvents, setAuditEvents] = useState<any[]>([]);
  const [instances, setInstances] = useState<InstanceRecord[]>([]);
  const [adminInstances, setAdminInstances] = useState<InstanceRecord[]>([]);
  const [projects, setProjects] = useState<ProjectRecord[]>([]);
  const [selectedProject, setSelectedProject] = useState("");
  const [projectMembers, setProjectMembers] = useState<any[]>([]);
  const [projectCandidates, setProjectCandidates] = useState<any[]>([]);
  const [newUsername, setNewUsername] = useState("");
  const [newDisplayName, setNewDisplayName] = useState("");
  const [newRole, setNewRole] = useState<"admin" | "member">("member");
  const [temporaryPassword, setTemporaryPassword] = useState("");
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [profileDisplayName, setProfileDisplayName] = useState(user?.displayName || "");
  const [message, setMessage] = useState("");
  const [instanceName, setInstanceName] = useState("");
  const [instanceEndpoint, setInstanceEndpoint] = useState("");
  const [instanceApiKey, setInstanceApiKey] = useState("");
  const [mappingProject, setMappingProject] = useState("");
  const [workspaceKey, setWorkspaceKey] = useState("");
  const [projectUserId, setProjectUserId] = useState("");
  const [projectRole, setProjectRole] = useState<"owner" | "editor" | "viewer">("editor");

  const isAdmin = user?.systemRole === "owner" || user?.systemRole === "admin";

  const refresh = useCallback(async () => {
    const status = await readPayload(await api.auth.status());
    setAuthEnabled(Boolean(status.authEnabled));
    if (!status.authEnabled) return;
    const [devicePayload, instancePayload, projectPayload] = await Promise.all([
      readPayload(await api.account.sessions()),
      readPayload(await api.instances.list()),
      readPayload(await api.projects()),
    ]);
    setSessions(devicePayload.sessions || []);
    setInstances(instancePayload.instances || []);
    setProjects(Array.isArray(projectPayload) ? projectPayload : []);
    if (isAdmin) {
      const [userPayload, auditPayload, adminInstancePayload] = await Promise.all([
        readPayload(await api.admin.users()),
        readPayload(await api.admin.auditEvents(30)),
        readPayload(await api.admin.instances()),
      ]);
      setUsers(userPayload.users || []);
      setAuditEvents(auditPayload.events || []);
      setAdminInstances(adminInstancePayload.instances || []);
    }
  }, [isAdmin]);

  useEffect(() => {
    void refresh().catch((error) => setMessage(error.message));
  }, [refresh]);

  useEffect(() => {
    setProfileDisplayName(user?.displayName || user?.username || "");
  }, [user?.displayName, user?.username]);

  const enableLogin = async () => {
    setSaving(true);
    setEnableError("");
    try {
      await readPayload(await api.auth.enable(ownerDisplayName, ownerPassword));
      window.location.reload();
    } catch (error: any) {
      setEnableError(error.message);
    } finally {
      setSaving(false);
    }
  };

  const changePassword = async () => {
    setSaving(true);
    setMessage("");
    try {
      await readPayload(await api.auth.changePassword(currentPassword, newPassword));
      setCurrentPassword("");
      setNewPassword("");
      setMessage("密码已更新，其他设备的登录已撤销。");
      await refresh();
    } catch (error: any) {
      setMessage(error.message);
    } finally {
      setSaving(false);
    }
  };

  const createUser = async () => {
    setSaving(true);
    setMessage("");
    try {
      const payload = await readPayload(await api.admin.createUser({
        username: newUsername,
        displayName: newDisplayName || newUsername,
        systemRole: newRole,
      }));
      setTemporaryPassword(payload.temporaryPassword);
      setNewUsername("");
      setNewDisplayName("");
      await refresh();
    } catch (error: any) {
      setMessage(error.message);
    } finally {
      setSaving(false);
    }
  };

  const registerInstance = async () => {
    setSaving(true);
    setMessage("");
    try {
      const project = projects.find((item) => item.name === mappingProject);
      await readPayload(await api.instances.create({
        name: instanceName,
        endpoint: instanceEndpoint,
        apiKey: instanceApiKey || undefined,
        projectMappings: project && workspaceKey
          ? [{ projectPath: project.fullPath, workspaceKey }]
          : [],
      }));
      setInstanceName("");
      setInstanceEndpoint("");
      setInstanceApiKey("");
      setWorkspaceKey("");
      setMessage("远端实例已登记，管理员批准前不会主动连接。");
      await refresh();
    } catch (error: any) {
      setMessage(error.message);
    } finally {
      setSaving(false);
    }
  };

  const loadProjectMembers = async (projectName: string) => {
    setSelectedProject(projectName);
    setProjectMembers([]);
    setProjectCandidates([]);
    if (!projectName) return;
    try {
      const [memberPayload, candidatePayload] = await Promise.all([
        readPayload(await api.projectMembers(projectName)),
        readPayload(await api.projectMemberCandidates(projectName)),
      ]);
      setProjectMembers(memberPayload.members || []);
      setProjectCandidates(candidatePayload.candidates || []);
    } catch (error: any) {
      setMessage(error.message);
    }
  };

  const grantProjectAccess = async () => {
    if (!selectedProject || !projectUserId) return;
    setSaving(true);
    try {
      const payload = await readPayload(await api.setProjectMember(selectedProject, Number(projectUserId), projectRole));
      setProjectMembers(payload.members || []);
      setProjectUserId("");
      await loadProjectMembers(selectedProject);
    } catch (error: any) {
      setMessage(error.message);
    } finally {
      setSaving(false);
    }
  };

  if (authEnabled === null) {
    return <div className="text-sm text-muted-foreground">正在读取账号设置…</div>;
  }

  if (!authEnabled) {
    return (
      <>
        <h2 className="text-2xl font-semibold text-foreground">{title}</h2>
        <SettingsSection
          className="mt-6"
          title="启用多人登录"
          description="默认保持本地免登录。启用后会创建固定 owner 账号，并立即要求所有浏览器登录，无需重启。"
        >
          <SettingsCard className="space-y-4 p-5">
            <div className="flex items-start gap-3 rounded-lg bg-muted/40 p-3 text-sm">
              <Shield className="mt-0.5 h-4 w-4 shrink-0 text-primary" />
              <span>此操作只能从本机回环地址执行。Cookie 为 HttpOnly，会话可在服务端撤销。</span>
            </div>
            <label className="block space-y-1.5 text-sm">
              <span>Owner 显示名</span>
              <input className={fieldClass} value={ownerDisplayName} onChange={(event) => setOwnerDisplayName(event.target.value)} />
            </label>
            <label className="block space-y-1.5 text-sm">
              <span>Owner 密码（至少 10 位）</span>
              <input className={fieldClass} type="password" value={ownerPassword} onChange={(event) => setOwnerPassword(event.target.value)} />
            </label>
            {enableError ? <p className="text-sm text-destructive">{enableError}</p> : null}
            <button className={`${buttonClass} border-primary bg-primary text-primary-foreground hover:bg-primary/90`} disabled={saving || ownerPassword.length < 10} onClick={enableLogin}>
              {saving ? <RefreshCw className="h-4 w-4 animate-spin" /> : <Shield className="h-4 w-4" />}
              启用多人登录
            </button>
          </SettingsCard>
        </SettingsSection>
      </>
    );
  }

  return (
    <>
      <h2 className="text-2xl font-semibold text-foreground">{title}</h2>
      {message ? <div className="mt-4 rounded-md border border-border bg-muted/30 px-3 py-2 text-sm">{message}</div> : null}

      <SettingsSection className="mt-6" title="我的账号" description={`当前以 ${user?.displayName || user?.username}（${user?.systemRole || "member"}）登录。`}>
        <SettingsCard className="space-y-4 p-5">
          <div className="flex gap-2">
            <input className={fieldClass} placeholder="显示名" value={profileDisplayName} onChange={(event) => setProfileDisplayName(event.target.value)} />
            <button className={buttonClass} disabled={!profileDisplayName.trim()} onClick={async () => { await readPayload(await api.account.update({ displayName: profileDisplayName.trim() })); window.location.reload(); }}>保存资料</button>
          </div>
          <div className="grid gap-3 md:grid-cols-2">
            <input className={fieldClass} type="password" placeholder="当前密码" value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} />
            <input className={fieldClass} type="password" placeholder="新密码（至少 10 位）" value={newPassword} onChange={(event) => setNewPassword(event.target.value)} />
          </div>
          <div className="flex gap-2">
            <button className={buttonClass} disabled={saving || newPassword.length < 10} onClick={changePassword}>修改密码</button>
            <button className={buttonClass} onClick={logout}><LogOut className="h-4 w-4" />退出登录</button>
          </div>
        </SettingsCard>
      </SettingsSection>

      <SettingsSection className="mt-6" title="我的登录设备" description="撤销后该设备的下一次请求会立即失效。">
        <SettingsCard divided>
          {sessions.map((session) => (
            <div key={session.id} className="flex items-center justify-between gap-4 p-4 text-sm">
              <div className="min-w-0">
                <p className="truncate font-medium">{session.userAgent || "未知浏览器"} {session.current ? "· 当前设备" : ""}</p>
                <p className="text-xs text-muted-foreground">最近活动：{session.lastSeenAt || "未知"}</p>
              </div>
              {!session.revokedAt ? <button className={buttonClass} onClick={async () => { await api.account.revokeSession(session.id); if (session.current) logout(); else await refresh(); }}>退出</button> : <span className="text-xs text-muted-foreground">已撤销</span>}
            </div>
          ))}
        </SettingsCard>
      </SettingsSection>

      <SettingsSection className="mt-6" title="我的 PilotDeck 实例" description="本地逻辑实例自动创建；远端实例保存后需由管理员测试并批准。">
        <SettingsCard divided>
          {instances.map((instance) => (
            <div key={instance.id} className="flex flex-wrap items-center justify-between gap-3 p-4 text-sm">
              <div className="min-w-0">
                <p className="flex items-center gap-2 font-medium"><Server className="h-4 w-4" />{instance.name}{instance.isDefault ? " · 默认" : ""}</p>
                <p className="truncate text-xs text-muted-foreground">{instance.kind} · {instance.status}{instance.endpoint ? ` · ${instance.endpoint}` : ""}</p>
              </div>
              <div className="flex gap-2">
                {!instance.isDefault && instance.status === "approved" ? <button className={buttonClass} onClick={async () => { await readPayload(await api.instances.setDefault(instance.id)); await refresh(); }}>设为默认</button> : null}
                {instance.kind === "remote" && !instance.isDefault ? <button className={buttonClass} onClick={async () => { await api.instances.remove(instance.id); await refresh(); }}><Trash2 className="h-4 w-4" />移除</button> : null}
              </div>
            </div>
          ))}
        </SettingsCard>
        <SettingsCard className="mt-3 space-y-3 p-5">
          <div className="grid gap-3 md:grid-cols-2">
            <input className={fieldClass} placeholder="实例名称" value={instanceName} onChange={(event) => setInstanceName(event.target.value)} />
            <input className={fieldClass} placeholder="Endpoint，例如 http://127.0.0.1:8642" value={instanceEndpoint} onChange={(event) => setInstanceEndpoint(event.target.value)} />
            <input className={fieldClass} type="password" placeholder="API Key（加密保存，可选）" value={instanceApiKey} onChange={(event) => setInstanceApiKey(event.target.value)} />
            <select className={fieldClass} value={mappingProject} onChange={(event) => setMappingProject(event.target.value)}>
              <option value="">暂不绑定工作空间</option>
              {projects.map((project) => <option key={project.name} value={project.name}>{project.displayName || project.name}</option>)}
            </select>
            <input className={fieldClass} placeholder="远端 workspace key" value={workspaceKey} onChange={(event) => setWorkspaceKey(event.target.value)} disabled={!mappingProject} />
          </div>
          <button className={buttonClass} disabled={saving || !instanceName.trim() || !instanceEndpoint.trim()} onClick={registerInstance}><Server className="h-4 w-4" />登记远端实例</button>
        </SettingsCard>
      </SettingsSection>

      {projects.some((project) => project.projectRole === "owner") ? (
        <SettingsSection className="mt-6" title="项目成员权限" description="只有项目 owner 可以管理该项目的 ACL；普通一对一会话不会随项目共享。">
          <SettingsCard className="space-y-4 p-5">
            <select className={fieldClass} value={selectedProject} onChange={(event) => void loadProjectMembers(event.target.value)}>
              <option value="">选择由你管理的项目</option>
              {projects.filter((project) => project.projectRole === "owner").map((project) => <option key={project.name} value={project.name}>{project.displayName || project.name}</option>)}
            </select>
            {selectedProject ? (
              <>
                <div className="grid gap-3 md:grid-cols-[1fr_140px_auto]">
                  <select className={fieldClass} value={projectUserId} onChange={(event) => setProjectUserId(event.target.value)}>
                    <option value="">选择用户</option>
                    {projectCandidates.map((candidate) => <option key={candidate.id} value={candidate.id}>{candidate.displayName} (@{candidate.username})</option>)}
                  </select>
                  <select className={fieldClass} value={projectRole} onChange={(event) => setProjectRole(event.target.value as "owner" | "editor" | "viewer")}>
                    <option value="owner">Owner</option><option value="editor">Editor</option><option value="viewer">Viewer</option>
                  </select>
                  <button className={buttonClass} disabled={!projectUserId || saving} onClick={grantProjectAccess}>授权</button>
                </div>
                <div className="divide-y divide-border rounded-lg border border-border">
                  {projectMembers.map((member) => (
                    <div key={member.user_id} className="flex items-center justify-between gap-3 p-3 text-sm">
                      <span>{member.display_name || member.username} <span className="text-muted-foreground">· {member.role}</span></span>
                      <button className={buttonClass} disabled={member.role === "owner" && projectMembers.filter((item) => item.role === "owner").length <= 1} onClick={async () => { await readPayload(await api.removeProjectMember(selectedProject, member.user_id)); await loadProjectMembers(selectedProject); }}>移除</button>
                    </div>
                  ))}
                </div>
              </>
            ) : null}
          </SettingsCard>
        </SettingsSection>
      ) : null}

      {isAdmin ? (
        <>
          <SettingsSection className="mt-6" title="用户管理" description="临时密码只显示一次，用户首次登录必须修改。">
            <SettingsCard className="space-y-4 p-5">
              <div className="grid gap-3 md:grid-cols-[1fr_1fr_140px_auto]">
                <input className={fieldClass} placeholder="用户名" value={newUsername} onChange={(event) => setNewUsername(event.target.value)} />
                <input className={fieldClass} placeholder="显示名" value={newDisplayName} onChange={(event) => setNewDisplayName(event.target.value)} />
                <select className={fieldClass} value={newRole} onChange={(event) => setNewRole(event.target.value as "admin" | "member")} disabled={user?.systemRole !== "owner"}>
                  <option value="member">Member</option>
                  <option value="admin">Admin</option>
                </select>
                <button className={buttonClass} disabled={!newUsername || saving} onClick={createUser}><UserPlus className="h-4 w-4" />创建</button>
              </div>
              {temporaryPassword ? (
                <div className="flex items-center justify-between gap-3 rounded-lg border border-amber-500/40 bg-amber-500/10 p-3 text-sm">
                  <span className="break-all font-mono">{temporaryPassword}</span>
                  <button className={buttonClass} onClick={async () => navigator.clipboard.writeText(temporaryPassword)}><Copy className="h-4 w-4" />复制</button>
                </div>
              ) : null}
            </SettingsCard>
            <SettingsCard className="mt-3" divided>
              {users.map((managedUser) => (
                <div key={managedUser.id} className="flex flex-wrap items-center justify-between gap-3 p-4 text-sm">
                  <div>
                    <p className="font-medium">{managedUser.displayName} <span className="text-muted-foreground">@{managedUser.username}</span></p>
                    <p className="text-xs text-muted-foreground">{managedUser.systemRole} · {managedUser.isActive ? "已启用" : "已停用"}{managedUser.mustChangePassword ? " · 待首次改密" : ""}</p>
                  </div>
                  {managedUser.systemRole !== "owner" ? (
                    <div className="flex gap-2">
                      {user?.systemRole === "owner" ? <select className="h-9 rounded-md border border-border bg-background px-2 text-xs" value={managedUser.systemRole} onChange={async (event) => { await readPayload(await api.admin.updateUser(managedUser.id, { systemRole: event.target.value })); await refresh(); }}><option value="member">Member</option><option value="admin">Admin</option></select> : null}
                      <button className={buttonClass} onClick={async () => { const payload = await readPayload(await api.admin.resetPassword(managedUser.id)); setTemporaryPassword(payload.temporaryPassword); }}>重置密码</button>
                      <button className={buttonClass} onClick={async () => { await readPayload(await api.admin.updateUser(managedUser.id, { isActive: !managedUser.isActive })); await refresh(); }}>{managedUser.isActive ? "停用" : "启用"}</button>
                    </div>
                  ) : <span className="inline-flex items-center gap-1 text-xs text-primary"><Check className="h-3.5 w-3.5" />Owner</span>}
                </div>
              ))}
            </SettingsCard>
          </SettingsSection>

          <SettingsSection className="mt-6" title="实例审批" description="测试会验证认证、版本、group-turn 能力和已登记的工作区映射；地址变化后需重新批准。">
            <SettingsCard divided>
              {adminInstances.length === 0 ? <div className="p-4 text-sm text-muted-foreground">暂无远端实例。</div> : null}
              {adminInstances.map((instance) => (
                <div key={instance.id} className="flex flex-wrap items-center justify-between gap-3 p-4 text-sm">
                  <div className="min-w-0"><p className="font-medium">{instance.name} · {instance.ownerDisplayName || "未知用户"}</p><p className="truncate text-xs text-muted-foreground">{instance.endpoint} · {instance.status}</p></div>
                  <div className="flex gap-2">
                    <button className={buttonClass} disabled={saving} onClick={async () => { setSaving(true); try { await readPayload(await api.admin.approveInstance(instance.id)); setMessage("实例测试并批准成功。"); await refresh(); } catch (error: any) { setMessage(error.message); } finally { setSaving(false); } }}><RefreshCw className="h-4 w-4" />测试并批准</button>
                    <button className={buttonClass} onClick={async () => { await readPayload(await api.admin.rejectInstance(instance.id)); await refresh(); }}>拒绝</button>
                  </div>
                </div>
              ))}
            </SettingsCard>
          </SettingsSection>

          <SettingsSection className="mt-6" title="最近审计记录">
            <SettingsCard divided>
              {auditEvents.map((event) => (
                <div key={event.id} className="flex items-center justify-between gap-3 p-3 text-xs">
                  <span>{event.event_type} · {event.actor_display_name || event.actor_username || "系统"}</span>
                  <span className="text-muted-foreground">{event.created_at}</span>
                </div>
              ))}
            </SettingsCard>
          </SettingsSection>
        </>
      ) : null}
    </>
  );
}
