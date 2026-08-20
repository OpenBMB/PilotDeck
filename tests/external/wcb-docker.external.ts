import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createLocalGateway } from "../../src/cli/createLocalGateway.js";
import { externalModel } from "./helpers.js";

test("nightly Docker image exists and can execute the built PilotDeck runtime", { timeout: 60_000 }, () => {
  const image = process.env.PILOTDECK_EXTERNAL_DOCKER_IMAGE;
  assert.ok(image, "PILOTDECK_EXTERNAL_DOCKER_IMAGE is required.");

  const inspected = docker(["image", "inspect", image]);
  assert.equal(inspected.status, 0, inspected.output);

  const executed = docker([
    "run",
    "--rm",
    "--entrypoint",
    "node",
    image,
    "-e",
    "import('/app/dist/src/gateway/index.js').then(() => console.log('pilotdeck-docker-ok'))",
  ]);
  assert.equal(executed.status, 0, executed.output);
  assert.match(executed.output, /pilotdeck-docker-ok/);
});

test("WCB-style smoke completes a real Gateway file task", { timeout: 300_000 }, async () => {
  externalModel();
  const workspace = await mkdtemp(path.join(tmpdir(), "pilotdeck-external-wcb-"));
  const marker = "WCB-PILOTDECK-CANARY-73";
  await writeFile(path.join(workspace, "input.txt"), `${marker}\n`, "utf8");
  const stack = createLocalGateway({
    projectRoot: workspace,
    pilotHome: process.env.PILOT_HOME,
    permissionMode: "bypassPermissions",
  });
  try {
    const { sessionKey } = await stack.gateway.newSession({ channelKey: "test", projectKey: workspace });
    const events = [];
    for await (const event of stack.gateway.submitTurn({
      sessionKey,
      channelKey: "test",
      projectKey: workspace,
      message: "Read input.txt with the file tool and reply with only its exact contents.",
      maxTurns: 5,
    })) events.push(event);
    const text = events.flatMap(event => event.type === "assistant_text_delta" ? [event.text] : []).join("");
    assert.match(text, new RegExp(marker));
    assert.ok(events.some(event => event.type === "turn_completed"));
  } finally {
    stack.dispose();
    await rm(workspace, { recursive: true, force: true });
  }
});

function docker(args: string[]): { status: number | null; output: string } {
  const result = spawnSync("docker", args, {
    encoding: "utf8",
    maxBuffer: 10 * 1024 * 1024,
  });
  assert.ifError(result.error);
  return {
    status: result.status,
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}
