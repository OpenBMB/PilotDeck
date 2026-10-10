import { readFileSync, writeFileSync } from "node:fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { CallToolRequestSchema, ListToolsRequestSchema, McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

const server = new Server(
  { name: "desktop-roundtrip-fixture", version: "1.0.0" },
  { capabilities: { tools: {} }, instructions: "Observe the window before acting and verify the result afterwards." },
);
const counterPath = process.argv[2];
const structuredContent = {
  window_id: 17,
  snapshot_id: "fixture:4",
  elements: [{ element_index: 0, element_token: "fixture:4:0", label: "Equals" }],
  window_bounds: { x: 100, y: 100, width: 320, height: 480 },
  screenshot_scale: 2,
};
const image = {
  type: "image", mimeType: "image/png",
  data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jB1sAAAAASUVORK5CYII=",
};
server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: ["observe", "structured_only", "refused", "action_expired", "read_expired", "action_disconnected", "read_disconnected", "slow_observe"].map(name => ({
    name, description: name, inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: !name.startsWith("action_"), idempotentHint: false },
  })),
}));
server.setRequestHandler(CallToolRequestSchema, async ({ params }, { signal }) => {
  if (params.name === "slow_observe") {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(resolve, 500);
      signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true });
    });
  }
  if (params.name.endsWith("_expired") || params.name.endsWith("_disconnected")) {
    let count = 0;
    try { count = Number(readFileSync(counterPath, "utf8")); } catch { /* first call */ }
    writeFileSync(counterPath, String(++count));
    if (count === 1) {
      if (params.name.endsWith("_disconnected")) process.exit(0);
      throw new McpError(ErrorCode.InvalidRequest, "session expired after dispatch");
    }
    return { content: [{ type: "text", text: String(count) }] };
  }
  if (params.name === "refused") {
    return { content: [{ type: "text", text: "Window scope changed." }], isError: true,
      structuredContent: { reason: "stale_snapshot", ...structuredContent } };
  }
  return {
    content: params.name === "structured_only" ? [] : [{ type: "text", text: "Calculator window" }, image],
    structuredContent,
  };
});
await server.connect(new StdioServerTransport());
