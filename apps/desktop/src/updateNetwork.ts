import type { Session, AuthInfo, ClientRequest } from "electron";
import { CancellationToken } from "electron-updater";
import { ElectronHttpExecutor } from "electron-updater/out/electronHttpExecutor";

type ProxyConfig = { url?: string; noProxy?: string } | string | undefined;
export function resolveUpdateProxy(config: ProxyConfig, env: NodeJS.ProcessEnv = process.env) {
  const url = env.PILOTDECK_PROXY || env.https_proxy || env.HTTPS_PROXY || env.http_proxy || env.HTTP_PROXY
    || (typeof config === "string" ? config : config?.url);
  if (!url?.trim()) return { settings: { mode: "system" as const }, credentials: null };
  const proxy = new URL(url.trim());
  if (!["http:", "https:", "socks4:", "socks5:"].includes(proxy.protocol)) throw new Error("Unsupported update proxy protocol");
  const noProxy = [env.no_proxy || env.NO_PROXY, typeof config === "object" ? config.noProxy : "", "localhost,127.0.0.1,[::1]"]
    .filter(Boolean).join(",").split(/[,;]/).map(rule => rule.trim()).filter(Boolean)
    .flatMap(rule => rule.startsWith(".") ? [rule.slice(1), `*${rule}`] : [rule]);
  return {
    settings: { mode: "fixed_servers" as const, proxyRules: `${proxy.protocol}//${proxy.host}`, proxyBypassRules: noProxy.join(";") },
    credentials: proxy.username ? { host: proxy.hostname, port: Number(proxy.port || (proxy.protocol === "https:" ? 443 : proxy.protocol === "http:" ? 80 : 1080)),
      username: decodeURIComponent(proxy.username), password: decodeURIComponent(proxy.password) } : null,
  };
}

// Discovery, feeds and payload downloads share electron-updater's own session.
// Refresh only before discovery; the controller freezes it during installation.
export function createUpdateNetwork(session: Pick<Session, "setProxy" | "closeAllConnections" | "clearAuthCache">, readConfig: () => ProxyConfig, env: NodeJS.ProcessEnv = process.env,
  executorFactory = (login: ConstructorParameters<typeof ElectronHttpExecutor>[0]): Pick<ElectronHttpExecutor, "request"> => new ElectronHttpExecutor(login)) {
  let applied: string | undefined;
  let credentials: ReturnType<typeof resolveUpdateProxy>["credentials"] = null;
  const credentialsFor = (auth: Pick<AuthInfo, "isProxy" | "host" | "port">) =>
    credentials && auth.isProxy && auth.host === credentials.host && auth.port === credentials.port ? credentials : null;
  const login: NonNullable<ConstructorParameters<typeof ElectronHttpExecutor>[0]> = (auth, callback) => {
    const value = credentialsFor(auth);
    callback(value?.username || "", value?.password || "");
  };
  // net.fetch does not handle proxy authentication challenges. Reuse the
  // updater's net.request transport, session and redirect/auth behavior for GETs.
  const executor = executorFactory(login);
  const probeExecutor = new ElectronHttpExecutor(login);
  return {
    probe: (url: string, signal?: AbortSignal) => probeUpdateDownload(probeExecutor, url, signal),
    async prepare() {
      const config = resolveUpdateProxy(readConfig(), env);
      const key = JSON.stringify(config);
      if (key === applied) return;
      await session.setProxy(config.settings);
      await session.closeAllConnections();
      await session.clearAuthCache();
      credentials = config.credentials;
      applied = key;
    },
    async fetch(url: string, init?: RequestInit) {
      init?.signal?.throwIfAborted();
      const token = new CancellationToken();
      const abort = () => token.cancel();
      init?.signal?.addEventListener("abort", abort, { once: true });
      try {
        const target = new URL(url);
        // ElectronHttpExecutor rebuilds these fields after a release-asset
        // redirect. Passing URL.href/pathname leaves the original URL attached
        // and Electron repeatedly requests it instead of the redirect target.
        const result = await executor.request({ protocol: target.protocol, hostname: target.hostname,
          port: target.port || undefined, path: `${target.pathname}${target.search}`,
          headers: Object.fromEntries(new Headers(init?.headers).entries()), timeout: 15_000 }, token);
        // Non-success HTTP statuses reject in ElectronHttpExecutor. Discovery
        // only needs the successful JSON body and propagates those failures.
        return new Response(result);
      } finally { init?.signal?.removeEventListener("abort", abort); token.dispose(); }
    },
    credentialsFor,
    login,
  };
}

// Read at most 256 KiB, even when a server ignores Range. Abort the transport
// after sampling; never buffer an installer merely to measure its speed.
export function probeUpdateDownload(executor: Pick<ElectronHttpExecutor, "createRequest">, url: string, signal?: AbortSignal): Promise<number> {
  return new Promise((resolve, reject) => {
    signal?.throwIfAborted();
    const started = Date.now();
    let request: ClientRequest | undefined;
    let settled = false;
    let bytes = 0;
    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
      request?.abort();
      if (error) reject(error);
      else resolve(Math.max(1, Date.now() - started));
    };
    const abort = () => finish(new Error("cancelled"));
    const timer = setTimeout(() => finish(new Error("probeTimeout")), 5000);
    signal?.addEventListener("abort", abort, { once: true });
    try {
      const target = new URL(url);
      request = executor.createRequest({ protocol: target.protocol, hostname: target.hostname,
        port: target.port || undefined, path: `${target.pathname}${target.search}`, redirect: "follow",
        headers: { Range: "bytes=0-262143", "Cache-Control": "no-cache", "User-Agent": "PilotDeck-Updater" } }, response => {
        if (response.statusCode !== 200 && response.statusCode !== 206) { finish(new Error("probeFailed")); return; }
        response.on("data", (chunk: Buffer) => { bytes += chunk.length; if (bytes >= 262144) finish(); });
        response.on("end", () => finish(bytes ? undefined : new Error("emptyProbe")));
        response.on("error", finish);
        response.on("aborted", () => finish(new Error("probeAborted")));
      });
      request.on("error", finish);
      request.end();
    } catch (error) { finish(error instanceof Error ? error : new Error("probeFailed")); }
  });
}
