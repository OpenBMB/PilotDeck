import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac, randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolvePilotHome } from "../pilot/paths.js";

/** Diagnostic attribution only. Never use these values for authorization. */
export type RequestContext = {
  userId?: string;
  deviceId?: string;
  clientVersion?: string;
  projectPath?: string;
  sessionId?: string;
  turnId?: string;
  parentRequestId?: string;
  operationId?: string;
  purpose?: string;
};

const contextStorage = new AsyncLocalStorage<RequestContext>();
const identities = new Map<string, string>();
const instanceId = randomUUID();
let packageVersion: string | undefined;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export type RequestHeadersMode = "full" | "basic" | "off";
export function requestHeadersMode(providerMode?: RequestHeadersMode): RequestHeadersMode {
  if (process.env.PILOTDECK_REQUEST_HEADERS === "off") return "off";
  const mode = providerMode ?? process.env.PILOTDECK_REQUEST_HEADERS;
  return mode === "off" || mode === "basic" ? mode : "full";
}

export function currentRequestContext(): RequestContext {
  return contextStorage.getStore() ?? {};
}

export function withRequestContext<T>(context: RequestContext, callback: () => T): T {
  return contextStorage.run({ ...currentRequestContext(), ...context }, callback);
}

export function safeHeaderValue(value: unknown): string | undefined {
  return typeof value === "string" && /^[\x21-\x7e]{1,160}$/.test(value) ? value : undefined;
}

/** Shared by the gateway and Web server; independent of credentials and hardware. */
function identitySeed(pilotHome = resolvePilotHome()): string {
  const home = resolve(pilotHome);
  const cached = identities.get(home);
  if (cached) return cached;
  const path = join(home, "request-identity");
  let id: string;
  try {
    id = readFileSync(path, "utf8").trim();
    if (!UUID.test(id)) throw new Error("Invalid request identity");
  } catch {
    id = randomUUID();
    try {
      mkdirSync(home, { recursive: true });
      writeFileSync(path, id, { flag: "wx", mode: 0o600 });
    } catch {
      // Another process may have won creation. A read-only/corrupt profile uses
      // a process-local identity instead of failing a user's model request.
      try {
        const winner = readFileSync(path, "utf8").trim();
        if (UUID.test(winner)) id = winner;
      } catch { /* ephemeral fallback */ }
    }
  }
  identities.set(home, id);
  return id;
}

export function anonymousRequestId(kind: string, value: string, pilotHome?: string): string {
  return createHmac("sha256", identitySeed(pilotHome)).update(`${kind}\0${value}`).digest("hex").slice(0, 32);
}

export function installationId(pilotHome?: string): string {
  return anonymousRequestId("installation", "local", pilotHome);
}

export function requestAppVersion(env: NodeJS.ProcessEnv = process.env): string {
  const configured = /^[a-zA-Z0-9][a-zA-Z0-9.+_-]{0,79}$/.test(env.PILOTDECK_VERSION ?? "") ? env.PILOTDECK_VERSION : undefined;
  if (configured) return configured;
  if (packageVersion) return packageVersion;
  // Works from both src/network and dist/src/network, without using the user's cwd.
  let directory = dirname(fileURLToPath(import.meta.url));
  for (let depth = 0; depth < 5; depth++, directory = dirname(directory)) {
    try {
      const pkg = JSON.parse(readFileSync(join(directory, "package.json"), "utf8"));
      if (pkg.name === "pilotdeck" && safeHeaderValue(pkg.version)) return packageVersion = pkg.version;
    } catch { /* continue towards the application root */ }
  }
  return packageVersion = "0.0.0";
}

function opaqueId(kind: string, value: string | undefined): string | undefined {
  if (typeof value !== "string" || !value || value.length > 4096) return undefined;
  return UUID.test(value) ? value : anonymousRequestId(kind, value);
}

export function requestContextHeaders(context: RequestContext = {}, options: {
  requestId?: string;
  userAgent?: boolean;
  mode?: RequestHeadersMode;
} = {}): Record<string, string> {
  const mode = requestHeadersMode(options.mode);
  if (mode === "off") return {};
  const version = requestAppVersion();
  const headers: Record<string, string> = {
    "x-pilotdeck-client": "pilotdeck",
    "x-pilotdeck-version": version,
    "x-pilotdeck-platform": process.platform,
    "x-pilotdeck-arch": process.arch,
    "x-pilotdeck-schema-version": "1",
    "x-pilotdeck-request-id": safeHeaderValue(options.requestId) ?? randomUUID(),
  };
  if (options.userAgent !== false) headers["user-agent"] = `PilotDeck/${version} (${process.platform}; ${process.arch})`;
  const build = safeHeaderValue(process.env.PILOTDECK_GIT_SHA);
  if (build) headers["x-pilotdeck-build"] = build;
  if (mode === "basic") return headers;
  const ctx = { ...currentRequestContext(), ...context };
  headers["x-pilotdeck-installation-id"] = installationId();
  headers["x-pilotdeck-instance-id"] = instanceId;
  headers["x-pilotdeck-device-id"] = ctx.deviceId && UUID.test(ctx.deviceId) ? ctx.deviceId : installationId();
  headers["x-pilotdeck-user-id"] = /^[0-9a-f]{32}$/.test(ctx.userId ?? "") ? ctx.userId! : anonymousRequestId("user", "local-profile");
  const project = typeof ctx.projectPath === "string" && ctx.projectPath.length > 0 && ctx.projectPath.length <= 4096 ? resolve(ctx.projectPath) : undefined;
  const values = {
    "x-pilotdeck-project-id": project ? anonymousRequestId("project", process.platform === "win32" ? project.toLowerCase() : project) : undefined,
    "x-pilotdeck-session-id": opaqueId("session", ctx.sessionId),
    "x-pilotdeck-turn-id": opaqueId("turn", ctx.turnId),
    "x-pilotdeck-operation-id": safeHeaderValue(ctx.operationId),
    "x-pilotdeck-parent-request-id": safeHeaderValue(ctx.parentRequestId),
    "x-pilotdeck-client-version": safeHeaderValue(ctx.clientVersion),
    "x-pilotdeck-purpose": safeHeaderValue(ctx.purpose),
  };
  for (const [name, value] of Object.entries(values)) if (value) headers[name] = value;
  return headers;
}

/** Case-insensitive, explicit configured headers take precedence. */
export function mergeRequestHeaders(defaults: Record<string, string>, overrides: HeadersInit = {}): Record<string, string> {
  const headers = new Headers(defaults);
  new Headers(overrides).forEach((value, name) => headers.set(name, value));
  return Object.fromEntries(headers);
}
