import { readGatewayAuthToken } from "../server/authToken.js";
import { createRemoteGateway, RemoteGateway } from "./RemoteGateway.js";

export type ProbeGatewayServerOptions = {
  url?: string;
  token?: string;
  timeoutMs?: number;
};

export async function probeGatewayServer(options: ProbeGatewayServerOptions = {}): Promise<{
  ok: boolean;
  url: string;
  wsUrl: string;
  token?: string;
}> {
  const url = options.url ?? "http://127.0.0.1:18789";
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs ?? 200);
  try {
    const response = await fetch(`${url}/health`, { signal: controller.signal });
    if (!response.ok) {
      return { ok: false, url, wsUrl: toWsUrl(url) };
    }
    const token = options.token ?? (await readGatewayAuthToken());
    return { ok: Boolean(token), url, wsUrl: toWsUrl(url), token };
  } catch {
    return { ok: false, url, wsUrl: toWsUrl(url) };
  } finally {
    clearTimeout(timeout);
  }
}

export async function connectRemoteGatewayIfAvailable(
  options: ProbeGatewayServerOptions = {},
): Promise<RemoteGateway | undefined> {
  const probe = await probeGatewayServer(options);
  if (!probe.ok || !probe.token) {
    return undefined;
  }
  try {
    return await createRemoteGateway({ url: probe.wsUrl, token: probe.token, clientName: "cli" });
  } catch {
    return undefined;
  }
}

function toWsUrl(url: string): string {
  const parsed = new URL(url);
  parsed.protocol = parsed.protocol === "https:" ? "wss:" : "ws:";
  parsed.pathname = "/ws";
  return parsed.toString();
}
