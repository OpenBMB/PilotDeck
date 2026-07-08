import {
  LITELLM_COMPLETION_HTTP_FALLBACK_MS,
  LITELLM_HTTP_CONNECTOR_LIMIT,
  LITELLM_HTTP_KEEPALIVE_TIMEOUT_MS,
} from "../model/streaming/streamModel.js";

type EnvLike = Record<string, string | undefined>;

export const UNDICI_TRANSPORT_TIMEOUT_MS = LITELLM_COMPLETION_HTTP_FALLBACK_MS;

type ProxyInstallSource = "env" | "config";
type DispatcherState =
  | { mode: "direct" }
  | { mode: "proxy"; source: ProxyInstallSource; proxyUrl: string; noProxy: string };

/**
 * Read the active proxy URL from environment variables.
 * Priority: PILOTDECK_PROXY > https_proxy > HTTPS_PROXY > http_proxy > HTTP_PROXY
 */
export function getProxyUrl(env: EnvLike = process.env): string | undefined {
  return (
    env.PILOTDECK_PROXY ||
    env.https_proxy ||
    env.HTTPS_PROXY ||
    env.http_proxy ||
    env.HTTP_PROXY
  );
}

/**
 * Install a global undici EnvHttpProxyAgent so that all native
 * `fetch()` and `WebSocket` calls in the process are routed through
 * the configured HTTP/HTTPS proxy, while respecting `NO_PROXY`.
 *
 * `127.0.0.1` and `localhost` are always excluded — the gateway
 * WebSocket lives on loopback and must never be routed through an
 * external proxy.
 *
 * Node.js native fetch (backed by undici) does NOT respect the
 * standard HTTPS_PROXY / HTTP_PROXY env vars — unlike curl or Python
 * requests. This function bridges that gap via `setGlobalDispatcher`.
 *
 * Safe to call multiple times. Env-based proxy settings keep precedence over
 * the first config-based proxy install during startup; hot reload paths should
 * use {@link reinstallGlobalProxy}.
 * Use {@link reinstallGlobalProxy} when the proxy URL changes at runtime.
 * Returns the proxy URL that was activated, or undefined if none.
 */
let dispatcherState: DispatcherState | undefined;
let pendingInstall: Promise<string | undefined> | null = null;

export async function installGlobalProxy(explicitUrl?: string, extraNoProxy?: string): Promise<string | undefined> {
  if (pendingInstall) return pendingInstall;

  const proxyUrl = explicitUrl ?? getProxyUrl();
  if (!proxyUrl) {
    pendingInstall = applyDirectDispatcher().finally(() => {
      pendingInstall = null;
    });
    return pendingInstall;
  }

  const source: ProxyInstallSource = explicitUrl ? "config" : "env";
  if (
    source === "config" &&
    dispatcherState?.mode === "proxy" &&
    dispatcherState.source === "env"
  ) {
    return undefined;
  }

  if (
    dispatcherState?.mode === "proxy" &&
    dispatcherState.source === source &&
    dispatcherState.proxyUrl === proxyUrl
  ) {
    return undefined;
  }

  pendingInstall = applyGlobalProxy(proxyUrl, source, extraNoProxy).finally(() => {
    pendingInstall = null;
  });
  return pendingInstall;
}

/**
 * Unconditionally (re-)install the global proxy dispatcher.
 * Called by hot-reload paths when `proxy.*` config changes at runtime.
 * Passing `undefined` or empty string removes the proxy but keeps the
 * long-timeout undici transport agent for direct outbound requests.
 */
export async function reinstallGlobalProxy(
  proxyUrl: string | undefined,
  extraNoProxy?: string,
): Promise<string | undefined> {
  if (pendingInstall) await pendingInstall;

  if (!proxyUrl) {
    return applyDirectDispatcher(true);
  }
  return applyGlobalProxy(proxyUrl, "config", extraNoProxy);
}

export function getGlobalProxyStateForTesting(): DispatcherState | undefined {
  return dispatcherState ? { ...dispatcherState } : undefined;
}

async function applyDirectDispatcher(logRemoval = false): Promise<string | undefined> {
  try {
    const { Agent, setGlobalDispatcher } = await import("undici");
    setGlobalDispatcher(new Agent(createLongTimeoutOptions()));
    dispatcherState = { mode: "direct" };
    if (logRemoval) {
      console.log("[proxy] Global fetch proxy removed");
    }
  } catch {
    // best effort
  }
  return undefined;
}

async function applyGlobalProxy(
  proxyUrl: string,
  source: ProxyInstallSource,
  extraNoProxy?: string,
): Promise<string | undefined> {
  try {
    const { EnvHttpProxyAgent, setGlobalDispatcher } = await import("undici");
    const noProxy = buildNoProxy(extraNoProxy);
    const agent = new EnvHttpProxyAgent({
      httpProxy: proxyUrl,
      httpsProxy: proxyUrl,
      noProxy,
      ...createLongTimeoutOptions(),
    });
    setGlobalDispatcher(agent);
    dispatcherState = { mode: "proxy", source, proxyUrl, noProxy };
    console.log(`[proxy] Global fetch proxy → ${proxyUrl} (noProxy: ${noProxy})`);
    return proxyUrl;
  } catch (error) {
    console.warn(
      `[proxy] Failed to install global proxy (${proxyUrl}):`,
      error instanceof Error ? error.message : String(error),
    );
    return undefined;
  }
}

export function createLongTimeoutOptions(): {
  headersTimeout: number;
  bodyTimeout: number;
  connections: number;
  keepAliveTimeout: number;
} {
  return {
    headersTimeout: UNDICI_TRANSPORT_TIMEOUT_MS,
    bodyTimeout: UNDICI_TRANSPORT_TIMEOUT_MS,
    connections: LITELLM_HTTP_CONNECTOR_LIMIT,
    keepAliveTimeout: LITELLM_HTTP_KEEPALIVE_TIMEOUT_MS,
  };
}

function buildNoProxy(extraNoProxy?: string): string {
  const userNoProxy = process.env.no_proxy || process.env.NO_PROXY || "";
  return [userNoProxy, extraNoProxy, "127.0.0.1", "localhost"]
    .filter(Boolean)
    .join(",");
}
