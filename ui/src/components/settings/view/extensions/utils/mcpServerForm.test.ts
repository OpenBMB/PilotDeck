import { describe, expect, it } from 'vitest';
import { parse as parseYaml } from 'yaml';
import { parseServers, stringifyServers } from './mcpServerForm';

describe('MCP YAML editing', () => {
  it('reads legacy JSON and serializes YAML without losing headers or arguments', () => {
    const legacy = JSON.stringify({ mcpServers: { local: { command: 'node', args: ['server.js'], env: { TOKEN: 'test-token' } } } });
    const forms = parseServers(legacy);
    expect(forms.error).toBeUndefined();
    const raw = stringifyServers(forms.servers);
    expect(raw).toContain('mcpServers:');
    expect(parseYaml(raw).mcpServers.local).toEqual({ command: 'node', args: ['server.js'], env: { TOKEN: 'test-token' } });
    expect(parseServers(raw).servers[0].command).toBe('node');
  });
});
