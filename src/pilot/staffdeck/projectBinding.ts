import { existsSync, readFileSync, statSync } from "node:fs";
import { mkdir, rename, writeFile, open, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { basename, join, resolve } from "node:path";
import { resolvePilotHome } from "../paths.js";
import { parse as parseYaml } from 'yaml';

export type ProjectBinding = {
  projectRoot: string; bindingId: string; agentName: string; origin: string; tenantId: string;
  agentId?: string; status: "pending" | "binding" | "bound" | "failed";
  runtimeReady?: boolean;
  error?: { code: string; message: string }; updatedAt: string;
};
type Store = { version: 1; installationId: string; projects: ProjectBinding[] };
const queues = new Map<string, Promise<unknown>>();
const pending = new Map<string, Promise<any>>();
const verifiedAt = new Map<string, number>();
const file = (env: NodeJS.ProcessEnv) => join(resolvePilotHome(env), "staffdeck", "project-bindings.json");
const enabled = (env: NodeJS.ProcessEnv) => env.STAFFDECK_PROJECT_BINDING_ENABLED === "true";
const failure = (code: string, message: string, status = 409) => Object.assign(new Error(message), { code, status });
async function lock(env: NodeJS.ProcessEnv) {
  await mkdir(join(resolvePilotHome(env), 'staffdeck'), { recursive: true, mode: 0o700 });
  const path = file(env) + '.lock';
  for (let attempt = 0; attempt < 200; attempt++) {
    try {
      const handle = await open(path, 'wx', 0o600);
      await handle.writeFile(String(process.pid));
      return async () => { await handle.close(); await unlink(path); };
    } catch (error: any) {
      if (error.code !== 'EEXIST') throw error;
      try {
        const pid = Number(readFileSync(path, 'utf8'));
        if (Number.isSafeInteger(pid) && pid > 0) {
          try { process.kill(pid, 0); }
          catch (cause: any) { if (cause.code === 'ESRCH') await unlink(path).catch(() => {}); }
        }
        else if (Date.now() - statSync(path).mtimeMs > 30000) await unlink(path).catch(() => {});
      } catch {}
      await new Promise(done => setTimeout(done, 100));
    }
  }
  throw failure('PROJECT_BINDING_BUSY', 'Another process is updating StaffDeck bindings. Retry shortly.');
}

function load(env: NodeJS.ProcessEnv): Store | undefined {
  if (!existsSync(file(env))) return undefined;
  let value: Store;
  try { value = JSON.parse(readFileSync(file(env), "utf8")) as Store; }
  catch { throw failure("PROJECT_BINDING_STORE_INVALID", "StaffDeck binding storage is invalid."); }
  if (value.version !== 1 || !value.installationId || !Array.isArray(value.projects)) {
    throw failure("PROJECT_BINDING_STORE_INVALID", "StaffDeck binding storage is invalid.");
  }
  return value;
}
async function save(store: Store, env: NodeJS.ProcessEnv) {
  await mkdir(join(resolvePilotHome(env), "staffdeck"), { recursive: true, mode: 0o700 });
  const temp = `${file(env)}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify(store, null, 2) + "\n", { flag: "wx", mode: 0o600 });
  await rename(temp, file(env));
}
export function readProjectBinding(projectRoot: string, env = process.env): ProjectBinding | undefined {
  return load(env)?.projects.find(row => row.projectRoot === resolve(projectRoot));
}
export function isProjectBindingEnabled(env = process.env) { return enabled(env); }
function bindingLockIsLive(env: NodeJS.ProcessEnv) {
  try {
    const pid = Number(readFileSync(file(env) + '.lock', 'utf8'));
    if (!Number.isSafeInteger(pid) || pid <= 0) return false;
    process.kill(pid, 0);
    return true;
  } catch { return false; }
}
function runtimeCanLoad(binding: ProjectBinding | undefined, env: NodeJS.ProcessEnv) {
  return binding?.status === 'bound' || (binding?.status === 'binding' && binding.runtimeReady && bindingLockIsLive(env));
}
export function projectBindingSummary(projectRoot: string, env = process.env) {
  if (!enabled(env)) return { status: "disabled" };
  const binding = readProjectBinding(projectRoot, env);
  if (binding?.status === 'binding') {
    if (!bindingLockIsLive(env)) return { ...binding, status: 'pending' as const };
  }
  return binding ?? { status: "pending" };
}
export async function refreshProjectBinding(projectRoot: string, options: {
  env?: NodeJS.ProcessEnv; request?: typeof fetch; activate?: () => Promise<void>;
} = {}) {
  const env = options.env ?? process.env;
  const current = projectBindingSummary(projectRoot, env);
  const key = `${file(env)}:${resolve(projectRoot)}`;
  if (current.status !== 'bound' || Date.now() - (verifiedAt.get(key) ?? 0) < 30000) return current;
  // An existing target is always revalidated; status reads never provision agents.
  const refreshed = await ensureProjectBinding(projectRoot, { ...options, revalidate: true });
  verifiedAt.set(key, Date.now());
  return refreshed;
}
function connectionMatches(binding: ProjectBinding, env: NodeJS.ProcessEnv) {
  return binding.tenantId === env.STAFFDECK_COPY_TENANT_ID
    && binding.origin === env.STAFFDECK_FORMAL_API_ORIGIN?.replace(/\/$/, '');
}
export function projectBindingEnvironment(projectRoot: string, env = process.env): NodeJS.ProcessEnv {
  if (!enabled(env)) return env;
  const binding = readProjectBinding(projectRoot, env);
  return { ...env, STAFFDECK_COPY_TARGET_AGENT_ID: runtimeCanLoad(binding, env) && binding && connectionMatches(binding, env) ? binding.agentId : undefined };
}
export function projectForStaffDeckPrincipal(principal: {
  tenantId: string; actorUserId: string; pilotDeckUserId: string; agentId?: string;
}, env = process.env): string | undefined {
  if (!enabled(env)) return undefined;
  if (principal.tenantId !== env.STAFFDECK_COPY_TENANT_ID
    || principal.actorUserId !== env.STAFFDECK_COPY_ACTOR_USER_ID
    || principal.pilotDeckUserId !== env.STAFFDECK_COPY_PILOTDECK_USER_ID) {
    throw failure("PROJECT_BINDING_PRINCIPAL_MISMATCH", "The StaffDeck identity is not bound.", 403);
  }
  const rows = load(env)?.projects.filter(row => row.status === "bound"
    && row.agentId === principal.agentId && row.tenantId === principal.tenantId && connectionMatches(row, env)) ?? [];
  if (rows.length !== 1) throw failure("PROJECT_BINDING_NOT_FOUND", "No unique bound project exists.", 403);
  return rows[0]!.projectRoot;
}

/** Project identities override deployment targets without writing credentials into a workspace. */
export function applyProjectBinding(config: any, projectRoot: string | undefined, env = process.env, runtime = false): any {
  if (!enabled(env)) return config;
  const binding = projectRoot ? readProjectBinding(projectRoot, env) : undefined;
  const next = structuredClone(config);
  next.modules ??= {};
  if (!binding || !runtimeCanLoad(binding, env) || !connectionMatches(binding, env)) {
    next.modules.knowledge = { enabled: false };
    next.modules.sop = { enabled: false };
    next.webui = { ...next.webui, staffdeckCopy: { enabled: false } };
    return next;
  }
  const agentId = binding.agentId!;
  const endpoint = `${binding.origin}/api/v1`;
  const definitionsPath = join(resolvePilotHome(env), "staffdeck", binding.bindingId, "sops.json");
  const bundle = existsSync(definitionsPath) ? parseYaml(readFileSync(definitionsPath, "utf8")) : { sops: [] };
  const defaultSopId = bundle.sops?.[0]?.id ?? bundle.sops?.[0]?.skill_id;
  const sopTimeouts = Object.fromEntries(["timeoutMs", "discoveryTimeoutMs"].flatMap(key => {
    const value = next.modules.sop?.[key];
    return Number.isSafeInteger(value) && value > 0 ? [[key, value]] : [];
  }));
  next.modules.knowledge = {
    enabled: true, implementationId: "staffdeck.knowledge", contract: "staffdeck.knowledge/v1",
    transport: "module-http-v2", endpoint: binding.origin,
    manifestPath: "/api/v1/knowledge-module/module-manifest",
    callPath: `/api/v1/agents/${encodeURIComponent(agentId)}/knowledge-${runtime ? 'module' : 'management'}/v2/module/call`,
    methods: ["list_bases", "create_base", "get_base", "update_base", "delete_base", "list_versions", "sync_base",
      "publish_version", "rollback_version", "list_documents", "get_document", "import_document", "import_okf",
      "update_document", "delete_document", "list_document_buckets", "update_bucket", "list_bucket_chunks", "update_chunk",
      "get_job", "list_jobs", "cancel_job", "list_okf_concepts", "get_okf_concept", "upsert_okf_concept", "export_okf",
      "lint_okf", "list_discoveries", "confirm_discovery", "reject_discovery", "query", "resolve_citation"],
    agentId, tenantId: binding.tenantId, actorUserId: env.STAFFDECK_COPY_ACTOR_USER_ID,
    credentialEnv: "STAFFDECK_SOP_MANAGEMENT_API_KEY",
  };
  next.webui = { ...next.webui, staffdeckCopy: {
    enabled: true, contract: "staffdeck.enterprise-copy/v1",
    methods: ["list_agents", "list_knowledge_bases", "list_skills", "import_resources"],
    endpoint: binding.origin, tenantId: binding.tenantId, actorUserId: env.STAFFDECK_COPY_ACTOR_USER_ID,
    targetAgentId: agentId, pilotDeckUserId: env.STAFFDECK_COPY_PILOTDECK_USER_ID,
    userTokenEnv: "STAFFDECK_COPY_USER_TOKEN",
  } };
  next.modules.sop = {
    enabled: true, provider: "staffdeck", endpoint: env.STAFFDECK_SOP_RUNTIME_ORIGIN,
    definitionsPath, defaultSopId, discoveryEndpoint: endpoint, discoveryAgentId: agentId,
    discoveryApiKey: "${STAFFDECK_SOP_MANAGEMENT_API_KEY}", timeoutMs: 30000, discoveryTimeoutMs: 90000, ...sopTimeouts,
    management: { enabled: true, endpoint, apiKeyEnv: "STAFFDECK_SOP_MANAGEMENT_API_KEY",
      credentialIdEnv: "STAFFDECK_SOP_MANAGEMENT_CREDENTIAL_ID", agentId,
      methods: ["list", "create", "get_draft", "replace_draft", "validate", "publish", "archive", "list_versions", "get_version", "rollback"] },
  };
  if (runtime && !defaultSopId) next.modules.sop = { enabled: false };
  if (runtime) {
    next.modules.knowledge.methods = ['query'];
    delete next.modules.knowledge.tenantId;
    delete next.modules.knowledge.actorUserId;
  }
  return next;
}

export async function ensureProjectBinding(projectRoot: string, options: {
  env?: NodeJS.ProcessEnv; request?: typeof fetch; explicitAgentId?: string;
  activate?: () => Promise<void>;
  revalidate?: boolean;
} = {}): Promise<ReturnType<typeof projectBindingSummary>> {
  const env = options.env ?? process.env;
  if (!enabled(env)) return { status: "disabled" };
  const key = file(env);
  const projectKey = `${key}:${resolve(projectRoot)}`;
  if (pending.has(projectKey)) return pending.get(projectKey)!;
  const previous = queues.get(key) ?? Promise.resolve();
  const action = previous.catch(() => {}).then(async () => {
    let release: () => Promise<void>;
    try { release = await lock(env); }
    catch (error: any) { return { status: 'failed', error: { code: error.code ?? 'PROJECT_BINDING_UNAVAILABLE',
      message: 'StaffDeck binding storage is busy or unavailable. Retry shortly.' } }; }
    try {
    const store = load(env) ?? { version: 1 as const, installationId: randomUUID(), projects: [] };
    const root = resolve(projectRoot);
    let binding = store.projects.find(row => row.projectRoot === root);
    if (!binding) {
      const bindingId = randomUUID();
      binding = { projectRoot: root, bindingId, agentName: `${basename(root).slice(0, 100)}-${bindingId.slice(0, 8)}`,
        origin: env.STAFFDECK_FORMAL_API_ORIGIN ?? "", tenantId: env.STAFFDECK_COPY_TENANT_ID ?? "",
        status: "pending", updatedAt: new Date().toISOString() };
      store.projects.push(binding);
      await save(store, env);
    }
    try {
      const localPath = join(root, '.pilotdeck', 'pilotdeck.yaml');
      const explicit = existsSync(localPath) ? parseYaml(readFileSync(localPath, 'utf8')) : {};
      const ids = [options.explicitAgentId, explicit?.modules?.knowledge?.agentId,
        explicit?.modules?.sop?.discoveryAgentId, explicit?.modules?.sop?.management?.agentId].filter(Boolean);
      if (new Set(ids).size > 1) throw failure('PROJECT_BINDING_IDENTITY_CONFLICT', 'Existing project StaffDeck identities conflict.');
      const explicitAgentId = ids[0];
      const required = ["STAFFDECK_FORMAL_API_ORIGIN", "STAFFDECK_COPY_TENANT_ID", "STAFFDECK_COPY_ACTOR_USER_ID",
        "STAFFDECK_COPY_PILOTDECK_USER_ID", "STAFFDECK_COPY_USER_TOKEN", "STAFFDECK_SOP_MANAGEMENT_API_KEY",
        "STAFFDECK_SOP_MANAGEMENT_CREDENTIAL_ID", "STAFFDECK_SOP_RUNTIME_ORIGIN"];
      if (required.some(name => !env[name]?.trim())) throw failure("PROJECT_BINDING_CONFIG_REQUIRED", "StaffDeck connection configuration is incomplete.");
      const origin = new URL(env.STAFFDECK_FORMAL_API_ORIGIN!);
      if (!["http:", "https:"].includes(origin.protocol) || origin.username || origin.password
        || origin.pathname !== "/" || origin.search || origin.hash) throw failure("PROJECT_BINDING_ORIGIN_INVALID", "StaffDeck address is invalid.");
      if (binding.agentId && (binding.origin !== origin.origin || binding.tenantId !== env.STAFFDECK_COPY_TENANT_ID)) {
        throw failure("PROJECT_BINDING_IDENTITY_CONFLICT", "This project belongs to another StaffDeck connection.");
      }
      binding.origin = origin.origin; binding.tenantId = env.STAFFDECK_COPY_TENANT_ID!;
      if (!options.revalidate || binding.status !== 'bound') binding.status = "binding";
      delete binding.runtimeReady;
      delete binding.error;
      await save(store, env);
      const request = options.request ?? fetch;
      const call = async (path: string, token: string, body?: unknown) => {
        const response = await request(new URL(path, origin), { method: body ? "POST" : "GET",
          headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
          body: body ? JSON.stringify(body) : undefined, redirect: "error", signal: AbortSignal.timeout(10000) });
        const result = await response.json();
        if (!response.ok) throw failure("PROJECT_BINDING_UPSTREAM_REJECTED", `StaffDeck request failed (${response.status}).`);
        return result;
      };
      const actor = await call("/api/auth/me", env.STAFFDECK_COPY_USER_TOKEN!);
      if (actor.id !== env.STAFFDECK_COPY_ACTOR_USER_ID || actor.tenant_id !== binding.tenantId || actor.disabled) {
        throw failure("PROJECT_BINDING_ACTOR_MISMATCH", "StaffDeck authenticated another account.");
      }
      const credentials = await call('/api/auth/me/api-credentials', env.STAFFDECK_COPY_USER_TOKEN!);
      const credential = Array.isArray(credentials) ? credentials.find(row => row.id === env.STAFFDECK_SOP_MANAGEMENT_CREDENTIAL_ID) : undefined;
      const prefix = typeof credential?.key_prefix === 'string' ? credential.key_prefix.replace(/…$/u, '') : '';
      if (!credential || credential.user_id !== actor.id || credential.status !== 'active' || credential.revoked_at
        || credential.access !== 'user_full_access' || prefix.length !== 20 || !env.STAFFDECK_SOP_MANAGEMENT_API_KEY!.startsWith(prefix)
        || (credential.expires_at && !(Date.parse(credential.expires_at) > Date.now()))
        || !['agents:read', 'agents:write', 'knowledge:read', 'knowledge:write', 'sops:read', 'sops:write', 'sops:publish']
          .every(scope => credential.scopes?.includes(scope))) {
        throw failure('PROJECT_BINDING_CREDENTIAL_INVALID', 'StaffDeck account credential is inactive or lacks the required access.');
      }
      if (explicitAgentId && binding.agentId && binding.agentId !== explicitAgentId) {
        throw failure("PROJECT_BINDING_IDENTITY_CONFLICT", "An existing binding cannot be replaced.");
      }
      let targetId = binding.agentId ?? explicitAgentId;
      if (targetId && store.projects.some(row => row !== binding && row.agentId === targetId)) {
        throw failure("PROJECT_BINDING_TARGET_OCCUPIED", "This StaffDeck agent is already bound to another project.");
      }
      if (!targetId) {
        const result = await call("/api/v1/agents:ensure-project-binding", env.STAFFDECK_SOP_MANAGEMENT_API_KEY!, {
          installation_id: store.installationId, project_binding_id: binding.bindingId, name: binding.agentName, source_mode: 'blank',
        });
        if (result.installation_id !== store.installationId || result.project_binding_id !== binding.bindingId) {
          throw failure("PROJECT_BINDING_RESPONSE_INVALID", "StaffDeck returned another project binding.");
        }
        targetId = result.agent?.id;
      }
      if (!targetId) throw failure("PROJECT_BINDING_RESPONSE_INVALID", "StaffDeck did not return an agent.");
      // Save the target before activation so failures always retry the original agent.
      binding.agentId = targetId;
      await save(store, env);
      const agent = await call(`/api/v1/agents/${encodeURIComponent(targetId)}`, env.STAFFDECK_SOP_MANAGEMENT_API_KEY!);
      if (agent.id !== targetId || agent.is_overall !== false || agent.status !== "active") {
        throw failure("PROJECT_BINDING_TARGET_UNAVAILABLE", "The bound StaffDeck agent is unavailable or archived.");
      }
      binding.agentName = agent.name;
      const directory = join(resolvePilotHome(env), "staffdeck", binding.bindingId);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      try { await writeFile(join(directory, "sops.json"), '{"sops":[]}\n', { flag: "wx", mode: 0o600 }); }
      catch (error: any) { if (error.code !== "EEXIST") throw error; }
      // The Gateway can load the verified target while the public state remains binding.
      binding.runtimeReady = true; await save(store, env);
      const { loadPilotConfig } = await import('../config/loadPilotConfig.js');
      if (options.activate) loadPilotConfig({ projectRoot: root, env });
      if (options.activate) await options.activate();
      binding.status = "bound";
      delete binding.runtimeReady;
    } catch (error: any) {
      binding.status = "failed";
      delete binding.runtimeReady;
      binding.error = { code: error.code ?? "PROJECT_BINDING_UNAVAILABLE", message: error.code ? error.message : "StaffDeck connection is unavailable. Retry to recover the binding." };
      await save(store, env);
      if (options.activate) await options.activate().catch(() => {});
    }
    binding.updatedAt = new Date().toISOString();
    await save(store, env);
    return structuredClone(binding);
    } catch (error: any) {
      return { status: 'failed', error: { code: error.code ?? 'PROJECT_BINDING_UNAVAILABLE',
        message: error.code ? error.message : 'StaffDeck binding storage is unavailable. Retry after restoring storage.' } };
    } finally { await release(); }
  });
  queues.set(key, action);
  pending.set(projectKey, action);
  try { return await action; }
  finally { if (queues.get(key) === action) queues.delete(key); if (pending.get(projectKey) === action) pending.delete(projectKey); }
}
