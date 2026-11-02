export const EMPTY_CONFIG = JSON.stringify({ mcpServers: {} }, null, 2);

export const INPUT_CLASS =
  "h-9 w-full rounded-lg border border-border bg-background px-3 text-sm text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-ring focus:ring-1 focus:ring-ring";

export const STDIO_TEMPLATE = {
  command: "npx",
  args: ["-y", "some-mcp-server"],
  env: {
    API_KEY: "${env:API_KEY}",
  },
};

export const REMOTE_TEMPLATE = {
  url: "https://example.com/mcp",
  headers: {
    Authorization: "Bearer ${env:MCP_TOKEN}",
  },
};
