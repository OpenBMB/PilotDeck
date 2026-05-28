type EnvLike = Record<string, string | undefined>;

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
 * Install a global undici ProxyAgent so that all native `fetch()` calls
 * in the process are routed through the configured HTTP/HTTPS proxy.
 *
 * Node.js native fetch (backed by undici) does NOT respect the standard
 * HTTPS_PROXY / HTTP_PROXY env vars — unlike curl or Python requests.
 * This function bridges that gap by calling `setGlobalDispatcher`.
 *
 * Safe to call multiple times; only the first effective call installs.
 * Returns the proxy URL that was activated, or undefined if none.
 */
let installed = false;

export function installGlobalProxy(explicitUrl?: string): string | undefined {
  if (installed) return undefined;

  const proxyUrl = explicitUrl ?? getProxyUrl();
  if (!proxyUrl) return undefined;

  try {
    const { ProxyAgent, setGlobalDispatcher } = require("undici") as typeof import("undici");
    const agent = new ProxyAgent(proxyUrl);
    setGlobalDispatcher(agent);
    installed = true;
    console.log(`[proxy] Global fetch proxy → ${proxyUrl}`);
    return proxyUrl;
  } catch (error) {
    console.warn(
      `[proxy] Failed to install global proxy (${proxyUrl}):`,
      error instanceof Error ? error.message : String(error),
    );
    return undefined;
  }
}
