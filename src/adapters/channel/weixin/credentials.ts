import { readConfiguration, writeConfiguration, resolveConfigHome } from "@pilotdeck/config";
import { dirname, join } from "node:path";
import { mkdirSync, writeFileSync } from "node:fs";

export type WeixinCredentials = { baseUrl: string; botToken: string; accountId: string; cursor?: string };
export function weixinCredentialsPath(): string { return join(resolveConfigHome(), "credentials", "weixin.yaml"); }
export function readWeixinCredentials(file = weixinCredentialsPath()): WeixinCredentials | null {
  const data = readConfiguration(file, {
    defaults: { baseUrl: "", botToken: "", accountId: "" },
    legacyPaths: file === weixinCredentialsPath() ? [join(resolveConfigHome(), "weixin-credentials.json")] : [],
    create: false,
    repair: !file.endsWith(".json"),
  }).value;
  return data.baseUrl && data.botToken && data.accountId ? data : null;
}
export function writeWeixinCredentials(value: WeixinCredentials, file = weixinCredentialsPath()): void {
  // Explicit legacy paths remain supported for integrations that consume JSON.
  if (file.endsWith(".json")) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    writeFileSync(file, JSON.stringify(value, null, 2), { mode: 0o600 });
  } else writeConfiguration(file, value);
}
