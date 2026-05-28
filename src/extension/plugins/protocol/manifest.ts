import type { PilotDeckHooksSettings } from "../../hooks/protocol/settings.js";

export type PilotDeckPluginManifest = {
  name: string;
  version?: string;
  description?: string;
  commands?: string | string[];
  agents?: string | string[];
  skills?: string | string[];
  hooks?: string | PilotDeckHooksSettings;
  mcpServers?: Record<string, unknown>;
  lspServers?: Record<string, unknown>;
  outputStyles?: string | string[];
  marketplace?: PilotDeckMarketplaceReference;
  mcpb?: string;
  settings?: Record<string, unknown>;
};

export type PilotDeckMarketplaceReference = {
  name: string;
  plugin: string;
  version?: string;
  source?: "marketplace" | "git" | "zip" | "mcpb";
  url?: string;
};
