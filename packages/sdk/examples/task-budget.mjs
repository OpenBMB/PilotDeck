import { query } from "@pilotdeck/sdk";

const total = Number(process.env.PILOTDECK_SDK_TASK_BUDGET_USD ?? "0.25");
const scope = process.env.PILOTDECK_SDK_TASK_BUDGET_SCOPE === "project"
  ? "project"
  : "session";

const run = query({
  prompt: process.argv.slice(2).join(" ") || "Summarize this project within the configured budget.",
  options: {
    gatewayUrl: process.env.PILOTDECK_SDK_GATEWAY_URL ?? "ws://127.0.0.1:8787",
    authToken: process.env.PILOTDECK_SDK_AUTH_TOKEN,
    taskBudget: { total, scope },
  },
});

for await (const message of run) {
  console.log(message.type, message);
}

console.log(await run.result());
