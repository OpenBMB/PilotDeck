import { isRecord } from "../../model/config/schema.js";
import type {
  PilotAdaptersConfig,
  PilotConfigDiagnostic,
  PilotGatewayConfig,
  PilotPlatformAdapterConfig,
} from "./types.js";

export function parseGatewayConfig(rawGateway: unknown, diagnostics: PilotConfigDiagnostic[]): PilotGatewayConfig | undefined {
  if (rawGateway === undefined) {
    return undefined;
  }
  if (!isRecord(rawGateway)) {
    diagnostics.push({
      code: "GATEWAY_CONFIG_INVALID",
      severity: "fatal",
      message: "gateway config must be an object.",
      path: "gateway",
      recoverable: false,
    });
    return undefined;
  }

  const bindAddress = stringField(rawGateway, "bindAddress", "127.0.0.1");
  if (bindAddress !== "127.0.0.1") {
    diagnostics.push({
      code: "GATEWAY_BIND_ADDRESS_UNSUPPORTED",
      severity: "fatal",
      message: "gateway.bindAddress must be 127.0.0.1 in the first phase.",
      path: "gateway.bindAddress",
      recoverable: false,
    });
  }
  if (rawGateway.tokenPath !== undefined) {
    diagnostics.push({
      code: "GATEWAY_TOKEN_PATH_REMOVED",
      severity: "warning",
      message: "gateway.tokenPath is no longer configurable; the gateway token is stored under PilotHome.",
      path: "gateway.tokenPath",
      recoverable: true,
    });
  }

  const maxMcp = numberField(rawGateway, "maxPerSessionMcpInstances", 5);
  return {
    port: numberField(rawGateway, "port", 18789),
    bindAddress: "127.0.0.1",
    idleSessionTimeoutMinutes: numberField(rawGateway, "idleSessionTimeoutMinutes", 30),
    idleSweepIntervalSeconds: numberField(rawGateway, "idleSweepIntervalSeconds", 60),
    memoryDiagnostics: booleanField(rawGateway, "memoryDiagnostics", false),
    staticAssetsPath: stringField(rawGateway, "staticAssetsPath"),
    maxPerSessionMcpInstances: Math.max(1, maxMcp),
  };
}

export function parseAdaptersConfig(rawAdapters: unknown, diagnostics: PilotConfigDiagnostic[]): PilotAdaptersConfig | undefined {
  if (rawAdapters === undefined) {
    return undefined;
  }
  if (!isRecord(rawAdapters)) {
    diagnostics.push({
      code: "ADAPTERS_CONFIG_INVALID",
      severity: "fatal",
      message: "adapters config must be an object.",
      path: "adapters",
      recoverable: false,
    });
    return undefined;
  }

  const PLATFORM_KEYS = [
    "telegram", "discord", "slack", "matrix", "mattermost",
    "signal", "whatsapp", "bluebubbles",
    "dingtalk", "wecom", "wecomCallback",
    "email", "sms", "homeassistant",
    "apiServer", "webhook",
  ] as const;

  const result: PilotAdaptersConfig = {
    cli: parseAutoConnect(rawAdapters.cli),
    tui: parseAutoConnect(rawAdapters.tui),
    feishu: parseFeishu(rawAdapters.feishu),
    weixin: parseEnabledOnly(rawAdapters.weixin),
    qq: parseQQ(rawAdapters.qq),
  };

  for (const key of PLATFORM_KEYS) {
    const parsed = parsePlatformAdapter(rawAdapters[key]);
    if (parsed) {
      (result as Record<string, unknown>)[key] = parsed;
    }
  }

  return result;
}

function parseEnabledOnly(raw: unknown): { enabled: boolean } | undefined {
  if (!isRecord(raw)) return undefined;
  return { enabled: booleanField(raw, "enabled", false) };
}

function parsePlatformAdapter(raw: unknown): PilotPlatformAdapterConfig | undefined {
  if (!isRecord(raw)) return undefined;
  const extra = isRecord(raw.extra) ? (raw.extra as Record<string, unknown>) : undefined;
  return {
    enabled: booleanField(raw, "enabled", false),
    token: stringField(raw, "token"),
    apiKey: stringField(raw, "apiKey"),
    webhookUrl: stringField(raw, "webhookUrl"),
    extra,
  };
}

function parseAutoConnect(raw: unknown): { autoConnectServer: boolean } | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }
  return { autoConnectServer: booleanField(raw, "autoConnectServer", true) };
}

function parseFeishu(raw: unknown): PilotAdaptersConfig["feishu"] {
  if (!isRecord(raw)) {
    return undefined;
  }
  const mode = stringField(raw, "connectionMode");
  const domain = stringField(raw, "domainName");
  return {
    enabled: booleanField(raw, "enabled", false),
    appId: stringField(raw, "appId"),
    appSecret: stringField(raw, "appSecret"),
    encryptKey: stringField(raw, "encryptKey"),
    verifyToken: stringField(raw, "verifyToken"),
    defaultSessionLabel: stringField(raw, "defaultSessionLabel", "general") ?? "general",
    connectionMode: mode === "stream" || mode === "webhook" ? mode : undefined,
    domainName: domain === "feishu" || domain === "lark" ? domain : undefined,
  };
}

function parseQQ(raw: unknown): PilotAdaptersConfig["qq"] {
  if (!isRecord(raw)) return undefined;
  const groups = Array.isArray(raw.allowGroups)
    ? (raw.allowGroups as unknown[]).filter((v): v is string => typeof v === "string")
    : undefined;
  const prefixes = Array.isArray(raw.triggerPrefixes)
    ? (raw.triggerPrefixes as unknown[]).filter((v): v is string => typeof v === "string")
    : undefined;
  const maxLen = typeof raw.maxMessageLength === "number" && Number.isFinite(raw.maxMessageLength)
    ? raw.maxMessageLength
    : undefined;
  return {
    enabled: booleanField(raw, "enabled", false),
    appId: stringField(raw, "appId"),
    clientSecret: stringField(raw, "clientSecret"),
    allowGroups: groups,
    triggerPrefixes: prefixes,
    maxMessageLength: maxLen,
  };
}

function stringField(record: Record<string, unknown>, key: string, fallback?: string): string | undefined {
  return typeof record[key] === "string" ? record[key] : fallback;
}

function numberField(record: Record<string, unknown>, key: string, fallback: number): number {
  return typeof record[key] === "number" && Number.isFinite(record[key]) ? record[key] : fallback;
}

function booleanField(record: Record<string, unknown>, key: string, fallback: boolean): boolean {
  return typeof record[key] === "boolean" ? record[key] : fallback;
}
