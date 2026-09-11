import { query } from "@pilotdeck/sdk";

const controller = new AbortController();
const run = query({
  prompt: "执行一个可能较长的分析；收到 SIGINT 时安全停止。",
  options: {
    gatewayUrl: process.env.PILOTDECK_SDK_GATEWAY_URL,
    authToken: process.env.PILOTDECK_SDK_AUTH_TOKEN,
    abortController: controller,
  },
});
process.once("SIGINT", () => controller.abort());

try {
  for await (const _event of run) { /* consume */ }
  console.log(JSON.stringify(await run.result(), null, 2));
} finally {
  run.close();
}
