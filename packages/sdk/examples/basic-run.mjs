import { query } from "@pilotdeck/sdk";

const run = query({
  prompt: process.argv.slice(2).join(" ") || "请用一句话介绍 PilotDeck。",
  options: {
    gatewayUrl: process.env.PILOTDECK_SDK_GATEWAY_URL,
    authToken: process.env.PILOTDECK_SDK_AUTH_TOKEN,
    permissionMode: "bypassPermissions",
  },
});

try {
  for await (const event of run) {
    if (event.type === "assistant.message") process.stdout.write(String(event.text ?? ""));
  }
  process.stdout.write(`\n${JSON.stringify(await run.result())}\n`);
} finally {
  run.close();
}
