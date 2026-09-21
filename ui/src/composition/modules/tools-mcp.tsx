import type { FrontendModule, SurfaceProps } from '../contracts';
import type { SettingsProject } from '../../components/settings/shared/types';
import McpServersSection from '../../components/settings/view/extensions';

const module: FrontendModule = {
  id: 'tools.mcp', businessModuleId: 'tools.mcp', contract: 'pilotdeck.business/v1', source: 'pilotdeck', frontendApiVersion: 'frontend-module/v1', requires: ['tools'],
  settings: [{ id: 'mcp-servers', settingsSection: 'mcp-servers', label: 'MCP servers', component: ({ host }: SurfaceProps) => <McpServersSection title="MCP servers" projects={(host?.projects ?? []) as SettingsProject[]} /> }],
};
export default module;
