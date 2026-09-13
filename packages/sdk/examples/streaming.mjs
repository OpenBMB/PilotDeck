import { query } from "@pilotdeck/sdk";

const run = query({
  prompt: "逐步解释如何安全地处理一个失败的测试。",
  options: {
    gatewayUrl: process.env.PILOTDECK_SDK_GATEWAY_URL,
    authToken: process.env.PILOTDECK_SDK_AUTH_TOKEN,
    includePartialMessages: true,
  },
});

try {
  for await (const event of run) {
    if (event.type === "assistant.message") process.stdout.write(String(event.text ?? ""));
    if (event.type === "result") process.stdout.write(`\n终态：${event.status}\n`);
  }
} finally {
  run.close();
}
