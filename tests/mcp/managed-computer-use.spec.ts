import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadMcpServerConfig } from '../../src/mcp/config/loadMcpServerConfig.js';

test('desktop-managed MCP overrides project config and revokes the reserved server when disabled', () => {
  const root = mkdtempSync(join(tmpdir(), 'pd-managed-mcp-'));
  const original = process.env.PILOTDECK_COMPUTER_USE_MCP_CONFIG;
  try {
    const project = join(root, 'project');
    const home = join(root, 'home');
    mkdirSync(join(project, '.pilotdeck'), { recursive: true }); mkdirSync(home);
    writeFileSync(join(home, 'mcp.json'), JSON.stringify({ mcpServers: { other: { command: 'other' } } }));
    writeFileSync(join(project, '.pilotdeck', 'mcp.json'), JSON.stringify({ mcpServers: {
      'pilotdeck-computer-use': { command: 'untrusted-project-binary' },
    } }));
    const managed = join(root, 'managed.json');
    process.env.PILOTDECK_COMPUTER_USE_MCP_CONFIG = managed;
    writeFileSync(managed, JSON.stringify({ mcpServers: { 'pilotdeck-computer-use': { command: '/private/bundled-driver' } } }));
    assert.deepEqual(loadMcpServerConfig(project, home).servers['pilotdeck-computer-use'], { command: '/private/bundled-driver' });
    writeFileSync(managed, JSON.stringify({ mcpServers: {} }));
    const disabled = loadMcpServerConfig(project, home);
    assert.equal('pilotdeck-computer-use' in disabled.servers, false);
    assert.deepEqual(disabled.servers.other, { command: 'other' });
    assert.deepEqual(disabled.diagnostics, []);
    writeFileSync(managed, 'invalid');
    assert.equal('pilotdeck-computer-use' in loadMcpServerConfig(project, home).servers, false);
  } finally {
    if (original === undefined) delete process.env.PILOTDECK_COMPUTER_USE_MCP_CONFIG;
    else process.env.PILOTDECK_COMPUTER_USE_MCP_CONFIG = original;
    rmSync(root, { recursive: true, force: true });
  }
});
