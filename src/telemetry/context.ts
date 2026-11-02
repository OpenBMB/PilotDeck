import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveGatewayTokenPath } from "../gateway/server/authToken.js";
import type {
  TelemetryDeploymentMode,
  TelemetryRuntimeContext,
} from "./types.js";

type ResolveRuntimeContextInput = {
  env?: Record<string, string | undefined>;
  pilotHome?: string;
};

const runtimeContextCache = new Map<string, TelemetryRuntimeContext>();

export function resolveTelemetryRuntimeContext(
  input: ResolveRuntimeContextInput = {},
): TelemetryRuntimeContext {
  const env = input.env ?? process.env;
  const cacheKey = buildRuntimeContextCacheKey(input.pilotHome, env);
  const cached = runtimeContextCache.get(cacheKey);
  if (cached) {
    return cached;
  }
  const deploymentMode = resolveDeploymentMode(env);
  const runtimeContext: TelemetryRuntimeContext = {
    installationId: resolveInstallationId(input.pilotHome, env),
    instanceId: resolveInstanceId(input.pilotHome, env, deploymentMode),
    deploymentMode,
    commitHash: resolveAppCommitHash(env),
    appVersion: resolveAppVersion(env),
    platform: process.platform,
  };
  runtimeContextCache.set(cacheKey, runtimeContext);
  return runtimeContext;
}

function resolveInstallationId(
  pilotHome: string | undefined,
  env: Record<string, string | undefined>,
): string {
  const tokenPath = resolveGatewayTokenPath({ pilotHome, env });
  if (existsSync(tokenPath)) {
    const token = readFileSync(tokenPath, "utf8").trim();
    if (token) {
      return hashStableId(token);
    }
  }
  const fallbackSeed = `${process.platform}:${process.arch}:${env.HOME ?? "unknown-home"}`;
  return hashStableId(fallbackSeed);
}

function resolveInstanceId(
  pilotHome: string | undefined,
  env: Record<string, string | undefined>,
  deploymentMode: TelemetryDeploymentMode,
): string {
  const resolvedPilotHome = pilotHome ?? env.PILOT_HOME ?? "unknown-pilot-home";
  const executablePath = process.execPath || "unknown-exec";
  const entrypoint = process.argv[1] ?? "unknown-entry";
  const seed = `${resolve(resolvedPilotHome)}|${resolve(executablePath)}|${resolve(entrypoint)}|${deploymentMode}`;
  return hashStableId(seed);
}

function resolveDeploymentMode(env: Record<string, string | undefined>): TelemetryDeploymentMode {
  if (looksLikeDocker(env)) return "docker";
  if (looksLikeDesktopInstaller()) return "desktop_installer";
  if (looksLikeSourceCheckout()) return "source";
  if (looksLikeCurlInstaller()) return "curl_installer";
  if (looksLikeNpmBinary(env)) return "npm_binary";
  return "unknown";
}

function looksLikeDocker(env: Record<string, string | undefined>): boolean {
  if (env.DOCKER_CONTAINER === "1" || env.KUBERNETES_SERVICE_HOST) return true;
  if (existsSync("/.dockerenv")) return true;
  try {
    const cgroup = readFileSync("/proc/1/cgroup", "utf8");
    return /(docker|containerd|kubepods|podman)/i.test(cgroup);
  } catch {
    return false;
  }
}

function looksLikeDesktopInstaller(): boolean {
  if (process.versions.electron) return true;
  const execLower = process.execPath.toLowerCase();
  return execLower.includes("pilotdeck.app") || execLower.endsWith("pilotdeck.exe");
}

function looksLikeSourceCheckout(): boolean {
  try {
    const result = execFileSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 1500,
    }).trim();
    return result === "true";
  } catch {
    return false;
  }
}

function looksLikeCurlInstaller(): boolean {
  const entry = (process.argv[1] ?? "").toLowerCase();
  return (
    entry.includes("/.local/bin/pilotdeck") ||
    entry.includes("/usr/local/bin/pilotdeck")
  );
}

function looksLikeNpmBinary(env: Record<string, string | undefined>): boolean {
  if (env.npm_config_user_agent) return true;
  const entry = (process.argv[1] ?? "").toLowerCase();
  return entry.includes("node_modules");
}

function resolveAppVersion(env: Record<string, string | undefined>): string {
  const fromEnv = env.PILOTDECK_VERSION ?? env.npm_package_version;
  if (fromEnv) return fromEnv;
  try {
    const file = resolve(dirname(fileURLToPath(import.meta.url)), "../../../package.json");
    if (existsSync(file)) {
      const parsed = JSON.parse(readFileSync(file, "utf8")) as { version?: string };
      if (parsed.version) return parsed.version;
    }
  } catch {
    // noop
  }
  return "0.0.0";
}

function resolveAppCommitHash(env: Record<string, string | undefined>): string {
  const fromEnv = env.COMMIT_HASH ?? env.GIT_COMMIT ?? env.PILOTDECK_GIT_SHA ?? env.GIT_SHA;
  if (fromEnv) {
    return fromEnv;
  }
  try {
    const sha = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: process.cwd(),
      encoding: "utf8",
      timeout: 1500,
    }).trim();
    return sha || "unknown";
  } catch {
    return "unknown";
  }
}

function hashStableId(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 24);
}

/** Stable anonymous id for outbound telemetry (e.g. session keys). */
export function hashTelemetryId(input: string): string {
  return hashStableId(input);
}

function buildRuntimeContextCacheKey(
  pilotHome: string | undefined,
  env: Record<string, string | undefined>,
): string {
  return [
    pilotHome ?? env.PILOT_HOME ?? "default",
    env.COMMIT_HASH ?? env.GIT_COMMIT ?? env.PILOTDECK_GIT_SHA ?? env.GIT_SHA ?? "",
    env.PILOTDECK_VERSION ?? env.npm_package_version ?? "",
    process.execPath,
    process.argv[1] ?? "",
  ].join("|");
}
