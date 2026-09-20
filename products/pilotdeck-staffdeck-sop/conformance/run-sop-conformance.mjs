#!/usr/bin/env node

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const root = dirname(fileURLToPath(import.meta.url));
const pilotdeckRoot = join(root, "../../..");
const python = process.env.PYTHON_BIN ?? "python3";
const port = await freePort();
const child = spawn(python, [join(root, "example_sop_runtime.py"), "--port", String(port)], {
  stdio: ["ignore", "pipe", "pipe"],
});
let stderr = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (chunk) => { stderr += chunk; });

try {
  await waitForHealth(`http://127.0.0.1:${port}/module-manifest`);
  const [{ StaffDeckSopClient, StaffDeckSopClientError }, { parseModulesConfig }] = await Promise.all([
    import(join(pilotdeckRoot, "dist/src/sop/staffdeck/StaffDeckSopClient.js")),
    import(join(pilotdeckRoot, "dist/src/pilot/config/parseModulesConfig.js")),
  ]);
  const diagnostics = [];
  const modules = parseModulesConfig({
    agentLoop: { enabled: true, provider: "pilotdeck" },
    modelProvider: { enabled: true, provider: "pilotdeck" },
    tools: { enabled: true, provider: "pilotdeck" },
    sop: {
      enabled: true,
      implementationId: "example.approval",
      contract: "sop.lifecycle/v2",
      transport: "sop-http-v2",
      endpoint: `http://127.0.0.1:${port}`,
      manifestPath: "/module-manifest",
      definitionsPath: join(root, "fixture.yaml"),
      defaultSopId: "approval",
    },
  }, "/tmp/example-sop-home", diagnostics);
  assert.equal(diagnostics.filter((item) => item.severity === "fatal").length, 0, JSON.stringify(diagnostics));
  assert.equal(modules.sop.implementationId, "example.approval");

  const client = new StaffDeckSopClient(modules.sop.endpoint, {
    manifestPath: modules.sop.manifestPath,
    expectedManifest: {
      implementationId: modules.sop.implementationId,
      contract: modules.sop.contract,
      transport: modules.sop.transport,
    },
  });
  const bundle = { sops: [{ id: "approval", version: "1", name: "Example approval", content: {
    start_node_id: "approve", nodes: [{ node_id: "approve", type: "handoff", instruction: "Approve this request." }],
  } }] };
  const prepared = await client.prepare({ bundle, state: { selected_skill_id: "approval" }, context: context("prepare") });
  assert.equal(prepared.step.nodeId, "approve");
  assert.equal(prepared.state.status, "awaiting_user");
  const submitted = await client.submit({
    bundle,
    state: prepared.state,
    proposal: { status: "completed", replyFragment: "Approved." },
    successfulToolNames: [],
    context: context("submit"),
  });
  assert.equal(submitted.result.status, "completed");
  assert.equal(submitted.state.status, "completed");
  await assert.rejects(
    () => client.submit({
      bundle,
      state: prepared.state,
      proposal: { status: "awaiting_user", replyFragment: "Wait." },
      successfulToolNames: [],
      context: context("reject"),
    }),
    (error) => error instanceof StaffDeckSopClientError
      && error.code === "EXAMPLE_SOP_REJECTED"
      && error.retryability === "unsafe",
  );
  console.log(JSON.stringify({ status: "PASS", implementationId: "example.approval", operations: ["prepare", "submit", "rejection"] }));
} finally {
  child.kill("SIGTERM");
  await new Promise((resolve) => child.once("exit", resolve));
  if (child.exitCode && child.exitCode !== 0 && stderr) process.stderr.write(stderr);
}

function context(operation) {
  return {
    runId: `conformance:${operation}`,
    operationId: `conformance.${operation}`,
    requestId: `conformance.${operation}`,
    sessionId: "conformance-session",
    turnId: "conformance-turn",
    expectedRevision: 1,
  };
}

async function freePort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForHealth(url) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // The child may still be starting.
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${url}`);
}
