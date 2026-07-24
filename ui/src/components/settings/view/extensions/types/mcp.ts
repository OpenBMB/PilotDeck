export type Scope = "global" | "project";

export type McpConfigFile = {
  exists: boolean;
  path: string;
  raw: string;
  config: { mcpServers?: Record<string, unknown> };
};

export type McpConfigResponse = {
  global: McpConfigFile;
  project: McpConfigFile;
};

export type KeyValueRow = {
  id: string;
  key: string;
  value: string;
};

export type McpServerForm = {
  id: string;
  name: string;
  transport: "stdio" | "http";
  command: string;
  args: string[];
  env: KeyValueRow[];
  envPassThrough: string[];
  perSession: boolean;
  url: string;
  headers: KeyValueRow[];
};
