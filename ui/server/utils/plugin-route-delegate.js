import http from 'http';
import { scanPlugins } from './plugin-loader.js';
import { getPluginPort, startPluginServer } from './plugin-process-manager.js';

/**
 * Generic delegation of core API routes to plugin server subprocesses.
 *
 * A plugin declares `"server": "server.js"` and `"serverRoutes": ["/api/..."]`
 * in plugin.json. When a core route cannot serve a request (e.g. a module is
 * not configured for a remote backend), it may call `delegateToPluginRoute`
 * so an enabled plugin that claimed the path prefix can answer instead.
 *
 * The delegate only fires for paths NOT otherwise handled by the caller —
 * core configuration always wins over plugin fallback.
 */

/** Find the first enabled plugin claiming `path` via serverRoutes. */
export function findPluginRouteClaim(path) {
  for (const plugin of scanPlugins()) {
    if (!plugin.server || plugin.enabled === false) continue;
    if (!Array.isArray(plugin.serverRoutes)) continue;
    for (const prefix of plugin.serverRoutes) {
      if (path === prefix || path.startsWith(prefix.endsWith('/') ? prefix : `${prefix}/`)) {
        return plugin;
      }
    }
  }
  return null;
}

/**
 * Proxy the current request to the claiming plugin's server subprocess.
 * Returns true when a plugin claimed the path (response handled), false when
 * no plugin claims it — the caller should then send its own error response.
 */
export async function delegateToPluginRoute(req, res) {
  const plugin = findPluginRouteClaim(req.baseUrl ? `${req.baseUrl}${req.path}` : req.path);
  if (!plugin) return false;

  let port = getPluginPort(plugin.name);
  if (!port) {
    try {
      port = await startPluginServer(plugin.name, plugin.dir, plugin.server);
    } catch (err) {
      res.status(503).json({ error: { code: 'PLUGIN_SERVER_UNAVAILABLE', message: `Plugin "${plugin.name}" server failed to start: ${err.message}` } });
      return true;
    }
  }

  const headers = { 'content-type': req.headers['content-type'] || 'application/json' };
  if (req.user?.id !== undefined) headers['x-pilotdeck-user-id'] = String(req.user.id);

  // Rebuild the full path the plugin server should see: the original API path
  // (the plugin implements core-shaped routes, not rpc-relative ones).
  const fullPath = req.originalUrl.split('?')[0];
  const qs = req.originalUrl.includes('?') ? req.originalUrl.slice(req.originalUrl.indexOf('?')) : '';

  const proxyReq = http.request({
    hostname: '127.0.0.1',
    port,
    path: `${fullPath}${qs}`,
    method: req.method,
    headers,
  }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });
  proxyReq.on('error', (err) => {
    if (!res.headersSent) {
      res.status(502).json({ error: { code: 'PLUGIN_SERVER_ERROR', message: err.message } });
    } else {
      res.end();
    }
  });
  const body = req.body && Object.keys(req.body).length > 0 ? JSON.stringify(req.body) : null;
  if (body) proxyReq.write(body);
  proxyReq.end();
  return true;
}
