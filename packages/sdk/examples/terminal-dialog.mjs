import { createTerminalUserDialogHandler, query } from "@pilotdeck/sdk";

const gatewayUrl = process.env.PILOTDECK_SDK_GATEWAY_URL;
const authToken = process.env.PILOTDECK_SDK_AUTH_TOKEN;

if (!gatewayUrl || !authToken) {
  throw new Error("Set PILOTDECK_SDK_GATEWAY_URL and PILOTDECK_SDK_AUTH_TOKEN before running this example.");
}

const run = query({
  prompt: "Ask for the deployment target and a small release form before continuing.",
  options: {
    gatewayUrl,
    authToken,
    supportedDialogKinds: ["input", "select", "confirm", "form"],
    onUserDialog: createTerminalUserDialogHandler(),
  },
});

for await (const message of run) {
  if (message.type === "assistant.message") process.stdout.write(String(message.text ?? ""));
}

console.log(await run.result());
