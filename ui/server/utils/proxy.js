/**
 * Pure-JS port of `src/cli/proxy.ts` — installs a global undici
 * ProxyAgent so Node native `fetch()` honors `PILOTDECK_PROXY` /
 * `HTTPS_PROXY` / `HTTP_PROXY`. Node's native fetch does NOT respect
 * those env vars by default; this closes the gap.
 *
 * Living in `ui/server/utils/` lets the express bridge run from
 * source without depending on `dist/src/cli/proxy.js`.
 */
import { ProxyAgent, setGlobalDispatcher } from 'undici';

function getProxyUrl(env = process.env) {
    return (
        env.PILOTDECK_PROXY ||
        env.https_proxy ||
        env.HTTPS_PROXY ||
        env.http_proxy ||
        env.HTTP_PROXY
    );
}

let installed = false;

/**
 * Install a global undici ProxyAgent. Safe to call multiple times —
 * only the first effective call wins. Returns the proxy URL that was
 * activated, or undefined if no proxy is configured.
 *
 * @param {string} [explicitUrl] Override the env-driven proxy URL.
 * @returns {string | undefined} The activated proxy URL.
 */
export function installGlobalProxy(explicitUrl) {
    if (installed) return undefined;
    const proxyUrl = explicitUrl ?? getProxyUrl();
    if (!proxyUrl) return undefined;
    try {
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
