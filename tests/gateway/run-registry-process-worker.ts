import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { FileRunRegistry } from "../../src/gateway/run/RunRegistry.js";

const [path, runId, barrier] = process.argv.slice(2);
if (!path || !runId || !barrier) throw new Error("Usage: run-registry-process-worker <path> <runId> <barrier>");

const registry = new FileRunRegistry(path);
const input = {
  projectKey: path,
  sessionKey: "session",
  runId,
  requestMaterial: `request-${runId}`,
};

await registry.get(input);
await mkdir(barrier, { recursive: true });
await writeFile(join(barrier, `${runId}.ready`), "ready", "utf8");
while (true) {
  try {
    await Promise.all([
      import("node:fs/promises").then(({ access }) => access(join(barrier, "run-process-a.ready"))),
      import("node:fs/promises").then(({ access }) => access(join(barrier, "run-process-b.ready"))),
    ]);
    break;
  } catch {
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
}

await registry.accept(input);
await registry.append({
  ...input,
  event: { type: "input_accepted", runId },
});
await registry.append({
  ...input,
  event: { type: "turn_completed", runId, usage: {}, finishReason: "completed" },
});
process.stdout.write(`${runId}\n`);
