import {
  createDomBrowserDialogDriver,
  createBrowserUserDialogHandler,
  query,
} from "@pilotdeck/sdk";

const gatewayUrl = window.PILOTDECK_GATEWAY_URL;
const authToken = window.PILOTDECK_GATEWAY_TOKEN;

if (!gatewayUrl || !authToken) {
  throw new Error("Set window.PILOTDECK_GATEWAY_URL and window.PILOTDECK_GATEWAY_TOKEN before loading this module.");
}

const run = query({
  prompt: "Ask for the deployment settings, then summarize the answer.",
  options: {
    gatewayUrl,
    authToken,
    supportedDialogKinds: ["input", "select", "confirm", "form"],
    onUserDialog: createBrowserUserDialogHandler({
      // The SDK DOM driver renders Gateway's input/select/confirm/form
      // schema as a framework-free modal. Applications can replace it with
      // a React/Web Component driver without changing Gateway ownership.
      driver: createDomBrowserDialogDriver({
        mount: document.getElementById("pilotdeck-dialog-root") ?? document.body,
        className: "pilotdeck-dialog",
      }),
    }),
  },
});

for await (const message of run) {
  if (message.type === "assistant") console.log(message.text);
}

console.log(await run.result());
