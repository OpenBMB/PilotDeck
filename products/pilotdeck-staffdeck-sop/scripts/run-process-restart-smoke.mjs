import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const scriptPath = fileURLToPath(import.meta.url);
const scriptDir = dirname(scriptPath);
const pilotDeckRoot = join(scriptDir, "../../..");

async function runParent() {
  const sopEndpoint = process.env.STAFFDECK_SOP_E2E_ENDPOINT;
  if (!sopEndpoint) throw new Error("STAFFDECK_SOP_E2E_ENDPOINT is required.");
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sop-process-restart-"));
  const provider = await startProvider();
  try {
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "lifecycle.yaml"), LIFECYCLE_YAML, "utf8");
    await writeFile(join(root, "pilotdeck.yaml"), configFor(sopEndpoint, provider.url), "utf8");
    await runChild("handoff", root);
    const output = await runChild("resume", root);
    const result = JSON.parse(output.trim().split("\n").at(-1));
    assert.deepEqual(result, { status: "passed", sopStatus: "completed", duplicate: true });
    console.log(JSON.stringify({ test: "process-restart-sop-resume", ...result }));
  } finally {
    await provider.close();
    await rm(root, { recursive: true, force: true });
  }
}

async function runWorker(mode, projectRoot) {
  const { createLocalGateway } = await import("../../../dist/src/cli/createLocalGateway.js");
  const local = createLocalGateway({
    projectRoot,
    pilotHome: projectRoot,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
  });
  try {
    if (mode === "handoff") {
      await collect(local.gateway.submitTurn({
        sessionKey: "process-restart-sop",
        channelKey: "test",
        workspaceCwd: projectRoot,
        message: "Request process restart handoff",
        mode: "bypassPermissions",
      }));
      const status = await local.gateway.sopStatus({ sessionKey: "process-restart-sop", projectKey: projectRoot });
      assert.equal(status?.state.status, "handoff");
      return;
    }
    const waiting = await local.gateway.sopStatus({ sessionKey: "process-restart-sop", projectKey: projectRoot });
    assert.equal(waiting?.state.status, "handoff");
    const resumed = await local.gateway.resumeSop({
      sessionKey: "process-restart-sop",
      projectKey: projectRoot,
      requestId: "process-restart-reply",
      waitId: waiting.wait.id,
      source: "human",
      message: "Process restart human approval.",
      expectedRevision: waiting.revision,
    });
    const duplicate = await local.gateway.resumeSop({
      sessionKey: "process-restart-sop",
      projectKey: projectRoot,
      requestId: "process-restart-reply",
      waitId: waiting.wait.id,
      source: "human",
      message: "Process restart human approval.",
    });
    await collect(local.gateway.submitTurn({
      sessionKey: "process-restart-sop",
      channelKey: "test",
      workspaceCwd: projectRoot,
      message: resumed.message,
      mode: "bypassPermissions",
    }));
    const completed = await local.gateway.sopStatus({ sessionKey: "process-restart-sop", projectKey: projectRoot });
    console.log(JSON.stringify({ status: "passed", sopStatus: completed?.state.status, duplicate: duplicate.duplicate }));
  } finally {
    await local.dispose();
  }
}

function runChild(mode, projectRoot) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scriptPath, "--worker", mode, projectRoot], {
      cwd: pilotDeckRoot,
      env: process.env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.once("error", reject);
    child.once("exit", (code) => code === 0
      ? resolve(stdout)
      : reject(new Error(`SOP restart worker '${mode}' exited ${code}: ${stderr || stdout}`)));
  });
}

async function collect(events) {
  const values = [];
  for await (const event of events) values.push(event);
  const error = values.find((event) => event.type === "error");
  assert.equal(error, undefined, error ? JSON.stringify(error) : "unexpected Gateway error");
  return values;
}

async function startProvider() {
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (body.stream !== true) {
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: '{"title":"Restart SOP"}' }, finish_reason: "stop" }] }));
      return;
    }
    const messages = JSON.stringify(body.messages ?? []);
    const resumed = messages.includes("Process restart human approval");
    response.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    response.write(`data: ${JSON.stringify({ choices: [{
      delta: { tool_calls: [{
        index: 0,
        id: resumed ? "restart-complete" : "restart-handoff",
        type: "function",
        function: {
          name: "submit_step_result",
          arguments: JSON.stringify({
            status: resumed ? "completed" : "handoff",
            replyFragment: resumed ? "Restarted SOP completed." : "Waiting across process restart.",
          }),
        },
      }] },
      finish_reason: "tool_calls",
    }] })}\n\n`);
    response.end("data: [DONE]\n\n");
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Restart mock provider did not bind.");
  return {
    url: `http://127.0.0.1:${address.port}`,
    close: () => new Promise((resolve, reject) => server.close((error) => error ? reject(error) : resolve())),
  };
}

function configFor(sopEndpoint, modelEndpoint) {
  return `schemaVersion: 1
agent:
  model: test/test
  maxContextTokens: 65536
  maxOutputTokens: 8192
model:
  providers:
    test:
      protocol: openai
      url: ${modelEndpoint}
      apiKey: test-only
      models:
        test:
          capabilities:
            supportsToolUse: true
            maxContextTokens: 32768
            maxOutputTokens: 8192
modules:
  agentLoop: { enabled: true, provider: pilotdeck }
  modelProvider: { enabled: true, provider: pilotdeck }
  tools: { enabled: true, provider: pilotdeck }
  sop:
    enabled: true
    provider: staffdeck
    endpoint: ${sopEndpoint}
    definitionsPath: lifecycle.yaml
    defaultSopId: lifecycle
`;
}

const LIFECYCLE_YAML = `sops:
  - id: lifecycle
    version: "1"
    name: Process restart lifecycle
    content:
      start_node_id: approval
      nodes:
        - node_id: approval
          type: handoff
          instruction: Resume this step only after the host receives human approval.
      terminal_node_ids: [approval]
`;

if (process.argv[2] === "--worker") {
  await runWorker(process.argv[3], process.argv[4]);
} else {
  await runParent();
}
