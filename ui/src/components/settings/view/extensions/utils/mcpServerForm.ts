import type { KeyValueRow, McpServerForm } from "../types/mcp";
import { EMPTY_CONFIG } from "./constants";

export function newId() {
  return Math.random().toString(36).slice(2);
}

export function toKeyValueRows(value: unknown): KeyValueRow[] {
  if (!value || typeof value !== "object" || Array.isArray(value)) return [];
  return Object.entries(value).map(([key, rowValue]) => ({
    id: newId(),
    key,
    value: typeof rowValue === "string" ? rowValue : String(rowValue ?? ""),
  }));
}

export function formFromRaw(name: string, value: unknown, id = newId()): McpServerForm {
  const raw =
    value && typeof value === "object" && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {};
  const env = toKeyValueRows(raw.env);
  const envPassThrough = env
    .filter((row) => row.value === `\${env:${row.key}}`)
    .map((row) => row.key);

  return {
    id,
    name,
    transport: typeof raw.command === "string" ? "stdio" : "http",
    command: typeof raw.command === "string" ? raw.command : "",
    args: Array.isArray(raw.args)
      ? raw.args.filter((arg): arg is string => typeof arg === "string")
      : [],
    env: env.filter((row) => row.value !== `\${env:${row.key}}`),
    envPassThrough,
    perSession: raw.perSession === true,
    url:
      typeof raw.url === "string"
        ? raw.url
        : typeof raw.httpUrl === "string"
          ? raw.httpUrl
          : "",
    headers: toKeyValueRows(raw.headers),
  };
}

export function parseServers(raw: string): { servers: McpServerForm[]; error?: string } {
  try {
    const parsed = JSON.parse(raw || EMPTY_CONFIG);
    const mcpServers =
      parsed?.mcpServers &&
      typeof parsed.mcpServers === "object" &&
      !Array.isArray(parsed.mcpServers)
        ? (parsed.mcpServers as Record<string, unknown>)
        : {};
    return {
      servers: Object.entries(mcpServers).map(([name, value], index) =>
        formFromRaw(name, value, String(index)),
      ),
    };
  } catch (error) {
    return {
      servers: [],
      error: error instanceof Error ? error.message : "Invalid JSON",
    };
  }
}

export function stringifyServers(servers: McpServerForm[]): string {
  const mcpServers: Record<string, unknown> = {};
  for (const server of servers) {
    const name = server.name.trim();
    if (!name) continue;
    if (server.transport === "stdio") {
      const env = Object.fromEntries([
        ...server.env
          .filter((row) => row.key.trim())
          .map((row) => [row.key.trim(), row.value]),
        ...server.envPassThrough
          .filter(Boolean)
          .map((key) => [key.trim(), `\${env:${key.trim()}}`]),
      ]);
      mcpServers[name] = {
        command: server.command,
        ...(server.args.filter(Boolean).length > 0
          ? { args: server.args.filter(Boolean) }
          : {}),
        ...(Object.keys(env).length > 0 ? { env } : {}),
        ...(server.perSession ? { perSession: true } : {}),
      };
    } else {
      const headers = Object.fromEntries(
        server.headers
          .filter((row) => row.key.trim())
          .map((row) => [row.key.trim(), row.value]),
      );
      mcpServers[name] = {
        url: server.url,
        ...(Object.keys(headers).length > 0 ? { headers } : {}),
      };
    }
  }
  return JSON.stringify({ mcpServers }, null, 2);
}
