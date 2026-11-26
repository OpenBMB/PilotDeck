import express from 'express';
import { McpOAuthManager } from '../../../src/mcp/oauth/manager.js';
import { resolvePilotHome } from '../utils/pilotPaths.js';
import { readMcpConfigFile, writeMcpConfigFile } from '../services/mcpConfig.js';
import { getPilotDeckGateway } from '../pilotdeck-bridge.js';

const router = express.Router();
const manager = new McpOAuthManager(resolvePilotHome(process.env));
async function configured(req) {
  const { scope, name, projectPath } = req.body ?? {};
  if (!['global', 'project'].includes(scope) || typeof name !== 'string') throw new Error('Invalid MCP server selection');
  const file = await readMcpConfigFile(scope, projectPath);
  const server = file.config.mcpServers?.[name];
  const url = server?.url ?? server?.httpUrl;
  if (server?.command || typeof url !== 'string') throw new Error('Save an HTTP MCP server first.');
  return { scope, name, projectPath, file, server, url };
}
async function reload(file) {
  const gateway = await getPilotDeckGateway();
  await gateway.reloadExtensions?.({ changedPaths: [file.path] });
}
router.post('/:action', async (req, res) => {
  try {
    const config = await configured(req);
    const { server, url, file, scope, projectPath } = config;
    let id = server.oauth?.credentialId;
    switch (req.params.action) {
      case 'start': {
        // Loopback callback belongs to this machine, not to a remote browser's machine.
        if (!['localhost', '127.0.0.1', '[::1]'].includes(req.hostname)) throw new Error('Open this PilotDeck instance on its own computer to authorize. Remote web OAuth callbacks are not supported yet.');
        if (Object.keys(server.headers ?? {}).some(key => key.toLowerCase() === 'authorization')) throw new Error('Remove the static Authorization header before using OAuth.');
        if (!id) {
          id = await manager.create(url);
          server.oauth = { credentialId: id };
          await writeMcpConfigFile(scope, JSON.stringify(file.config), projectPath);
        }
        return res.json(await manager.begin(id, url));
      }
      case 'status': return res.json(id ? await manager.status(id, url) : { status: 'needs-auth' });
      case 'complete':
        if (!id || (await manager.status(id, url)).status !== 'authorized') throw new Error('Authorization is not complete.');
        await reload(file);
        return res.json({ status: 'authorized' });
      case 'cancel':
        if (id) await manager.cancel(id, url);
        return res.json({ status: 'cancelled' });
      case 'disconnect': {
        const result = id ? await manager.disconnect(id, url) : { revoked: false };
        delete server.oauth;
        await writeMcpConfigFile(scope, JSON.stringify(file.config), projectPath);
        await reload(file);
        return res.json({ status: 'needs-auth', ...result });
      }
      default: return res.status(404).json({ error: 'Unknown OAuth action' });
    }
  } catch (error) {
    // Never return token endpoint responses or authorization codes to the UI/logs.
    res.status(400).json({ error: error instanceof Error && /^(Save |Invalid MCP|Remove |Open this)/.test(error.message) ? error.message : 'MCP OAuth operation failed. Check the configuration and retry.' });
  }
});
export default router;
