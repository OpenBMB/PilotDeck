import { isAbsolute } from "node:path";
import { query } from "@pilotdeck/sdk";

const pluginPath = process.env.PILOTDECK_SDK_PLUGIN_PATH;
if (!pluginPath || !isAbsolute(pluginPath)) {
  throw new Error("Set PILOTDECK_SDK_PLUGIN_PATH to an absolute plugin directory path visible to the Gateway host.");
}

const run = query({
  prompt: process.argv.slice(2).join(" ") || "Use the session plugin's available capabilities.",
  options: {
    gatewayUrl: process.env.PILOTDECK_SDK_GATEWAY_URL,
    authToken: process.env.PILOTDECK_SDK_AUTH_TOKEN,
    plugins: [{ type: "local", path: pluginPath }],
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
