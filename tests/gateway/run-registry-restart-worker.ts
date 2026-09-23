import { FileRunRegistry } from "../../src/gateway/run/RunRegistry.js";

const [path] = process.argv.slice(2);
if (!path) throw new Error("Usage: run-registry-restart-worker <path>");

const registry = new FileRunRegistry(path);
const input = { projectKey: "project", sessionKey: "session", runId: "run-1", requestMaterial: "request" };
await registry.accept(input);
await registry.append({
  projectKey: input.projectKey,
  sessionKey: input.sessionKey,
  runId: input.runId,
  event: { type: "input_accepted", runId: input.runId },
});
