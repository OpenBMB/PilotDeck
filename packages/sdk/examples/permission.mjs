import { query } from "@pilotdeck/sdk";

const run = query({
  prompt: "检查工作区状态；任何写操作都不要执行。",
  options: {
    gatewayUrl: process.env.PILOTDECK_SDK_GATEWAY_URL,
    authToken: process.env.PILOTDECK_SDK_AUTH_TOKEN,
    canUseTool: async (toolName, input, context) => {
      console.error(`permission request: ${toolName}`, input, context.requestId);
      return toolName === "read_file"
        ? { behavior: "allow", reason: "read-only example" }
        : { behavior: "deny", message: "示例只允许只读工具。" };
    },
  },
});

try {
  for await (const event of run) {
    if (event.type === "permission.requested") console.error("permission event", event.toolName);
  }
  console.log(JSON.stringify(await run.result(), null, 2));
} finally {
  run.close();
}
