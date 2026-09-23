import { access, readFile, writeFile } from "node:fs/promises";

import { FileRunRegistry } from "../../src/gateway/run/RunRegistry.js";

const [mode, path, markerPath, releasePath] = process.argv.slice(2);
if ((mode !== "hold" && mode !== "observe") || !path || !markerPath || !releasePath) {
  throw new Error("Usage: run-registry-owner-worker <hold|observe> <path> <marker> <release>");
}

const registry = new FileRunRegistry(path);
const input = { projectKey: "project", sessionKey: "session", runId: "run-owner", requestMaterial: "request-owner" };

if (mode === "hold") {
  await registry.accept(input);
  await registry.append({ ...input, event: { type: "input_accepted", runId: input.runId } });
  await writeFile(markerPath, "ready", "utf8");
  while (true) {
    try {
      await access(releasePath);
      break;
    } catch {
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
    }
  }
} else {
  const record = await registry.get(input);
  await writeFile(markerPath, JSON.stringify({ state: record?.state }), "utf8");
}
