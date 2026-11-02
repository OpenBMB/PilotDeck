import { randomBytes } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { readConfiguration, updateConfiguration, resolveConfigHome } from "@pilotdeck/config";

export type GatewayAuthTokenOptions = { pilotHome?: string; env?: Record<string, string | undefined> };
function home(options: GatewayAuthTokenOptions) { return options.pilotHome ?? resolveConfigHome(options.env); }
export function resolveGatewayTokenPath(options: GatewayAuthTokenOptions = {}): string {
  return resolve(home(options), "credentials", "gateway.yaml");
}
function readOptions(options: GatewayAuthTokenOptions) {
  const legacy = resolve(home(options), "server-token");
  let token = "";
  if (!existsSync(resolveGatewayTokenPath(options))) {
    try { token = readFileSync(legacy, "utf8").trim(); } catch { /* First installation. */ }
  }
  return { defaults: { token }, legacyPaths: [legacy], create: false };
}
export function readGatewayAuthTokenSync(options: GatewayAuthTokenOptions = {}): string | undefined {
  return readConfiguration(resolveGatewayTokenPath(options), readOptions(options)).value.token || undefined;
}
export async function readGatewayAuthToken(options: GatewayAuthTokenOptions = {}): Promise<string | undefined> {
  return readGatewayAuthTokenSync(options);
}
export async function ensureGatewayAuthToken(options: GatewayAuthTokenOptions = {}): Promise<{ token: string; tokenPath: string }> {
  const tokenPath = resolveGatewayTokenPath(options);
  const existing = readGatewayAuthTokenSync(options);
  if (existing) return { token: existing, tokenPath };
  const value = updateConfiguration(tokenPath, current => ({ ...current, token: current.token || randomBytes(32).toString("base64url") }), { defaults: { token: "" } });
  return { token: value.token, tokenPath };
}
