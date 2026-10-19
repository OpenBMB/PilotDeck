import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import YAML from "yaml";
import { createLocalGateway } from "../../src/cli/createLocalGateway.js";
import { SopExecutionClient } from "../../src/sop/execution/SopExecutionClient.js";
import { startGatewayServer } from "../../src/gateway/server/GatewayServer.js";
import { createPilotDeckClient } from "../../packages/sdk/src/index.js";
import type { CanonicalModelEvent, CanonicalModelRequest } from "../../src/model/index.js";

const python = process.env.SOP_RUNTIME_PYTHON;

test("v4 Gateway + execute_code batch + isolated host model calls + SDK", { skip: !python, timeout: 180_000 }, async () => {
  await scenario(false);
});

test("v4 real Agent uploads 12 files and executes dynamic shareholders", {
  skip: !python || process.env.SOP_V4_REAL !== "1", timeout: 600_000,
}, async () => { await scenario(true); });

async function scenario(real: boolean) {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sop-v4-"));
  const listener = createServer();
  await new Promise<void>(resolve => listener.listen(0, "127.0.0.1", resolve));
  const port = (listener.address() as { port: number }).port;
  await new Promise<void>(resolve => listener.close(() => resolve()));
  const endpoint = `http://127.0.0.1:${port}`;
  const token = "local-test-host-only";
  const child = spawn(python!, ["-m", "uvicorn", "staffdeck_sop_runtime.execution_api_v4:app_factory", "--factory", "--host", "127.0.0.1", "--port", String(port)], {
    env: { ...process.env, PYTHONPATH: join(process.cwd(), "packages/sop-runtime/src"), SOP_V4_DB: join(root, "runtime.sqlite"), SOP_V4_HOST_TOKEN: token }, stdio: "ignore",
  });
  const exited = new Promise(resolve => child.once("exit", resolve));
  let local: ReturnType<typeof createLocalGateway> | undefined;
  let server: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
  let sdk: ReturnType<typeof createPilotDeckClient> | undefined;
  const observed: CanonicalModelRequest[] = [];
  try {
    const client = new SopExecutionClient(endpoint, token);
    for (let i = 0; i < 100; i++) {
      try { await client.preflight(); break; } catch { await new Promise(resolve => setTimeout(resolve, 50)); }
    }
    const original = real ? YAML.parse(await readFile(process.env.SOP_V4_MODEL_CONFIG!, "utf8")) : undefined;
    const selection = real ? String(original.agent.model) : "test/test";
    const parts = selection.split("/");
    const selectedModel = { provider: parts.shift()!, model: parts.join("/") };
    const secondModel = real ? { provider: selectedModel.provider, model: process.env.SOP_V4_SECOND_MODEL ?? "deepseek-v4-flash-0731" } : selectedModel;
    await writeFile(join(root, "pilotdeck.yaml"), YAML.stringify({ schemaVersion: 1,
      agent: { model: selection, interactionProfile: "headless" },
      model: real ? original.model : { providers: { test: { protocol: "openai", url: "http://127.0.0.1:1", apiKey: "test", models: { test: { capabilities: { supportsToolUse: true, maxContextTokens: 65536, maxOutputTokens: 4096 } } } } } },
    }), { mode: 0o600 });
    const definition = (id: string, nodes: unknown[], edges: unknown[] = []) => ({ schema: "sop.definition/v4", skill_id: id, version: "1", start_node_id: (nodes[0] as { node_id: string }).node_id,
      terminal_node_ids: [(nodes.at(-1) as { node_id: string }).node_id], nodes, edges });
    await client.request("/v4/definitions", undefined, definition("invoice", [{ node_id: "extract", model: selectedModel,
      input: { fields: { invoice: { source: "attachments" } } },
      instruction: "Extract the single invoice from input.invoice. Return status completed, output {id: invoice ID string, amount: numeric amount}, reply concise. Use structured_output. No questions." }]));
    await client.request("/v4/definitions", undefined, definition("holder", [{ node_id: "research", model: secondModel,
      instruction: "Return completed and output {name: input.item.name, checked: true}. This is a local fixture, no internet research required. If item.failOnce is true and the invocation attempt is 1, return status failed and error {code: FIXTURE_FAILURE}; on attempt 2 return completed." }]));
    await client.request("/v4/definitions", undefined, definition("holder-wrapper", [{ node_id: "nested", type: "subflow",
      subSop: { sopId: "holder", version: "1" }, input: { fields: { item: { source: "item" } } } }]));
    await client.request("/v4/definitions", undefined, definition("company", [{ node_id: "discover", type: "foreach", subSop: { sopId: "holder", version: "1" },
      instruction: "Read originalQuery and identify shareholders. Create exactly one item per shareholder with itemKey equal to name and input {name}. Return foreach with those items and choose concurrency between 1 and 3. Do not execute children." }]));
    await client.request("/v4/definitions", undefined, definition("company-nested", [{ node_id: "discover", type: "foreach", subSop: { sopId: "holder-wrapper", version: "1" },
      instruction: "Read originalQuery and identify all three shareholders. Return foreach at top level with unique itemKeys and input {name}, concurrency 3." }]));
    await client.request("/v4/definitions", undefined, definition("company-failure", [{ node_id: "discover", type: "foreach", subSop: { sopId: "holder", version: "1" },
      instruction: "Identify Alice, Bob, Carol. Return top-level foreach with three items, input {name, failOnce: name equals Bob}, concurrency 3. Do not execute children." }]));
    let rootStep = 0;
    const model = {
      providerId: "test",
      getCapabilities: () => ({ supportsToolUse: true, maxContextTokens: 65536, maxOutputTokens: 4096 }),
      getMultimodal: () => ({}),
      getProviderProtocol: () => "openai" as const,
      getProviderBaseUrl: () => "http://127.0.0.1:1",
      complete: async () => { throw new Error("Unexpected complete call"); },
      async *stream(request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
        observed.push(request);
        const serialized = request.messages.flatMap(message => Array.isArray(message.content)
          ? message.content.map(block => "text" in block ? block.text : "") : [message.content]).join("\n");
        let name: string, input: unknown;
        if (serialized.includes("Execute this SOP node")) {
          name = "structured_output";
          const id = serialized.match(/INV-\d+/)?.[0] ?? "INV-0";
          input = { value: { status: "completed", reply: "extracted", output: { id, amount: Number(id.split("-")[1]) } } };
        } else if (rootStep++ === 0) {
          name = "execute_code";
          const files = serialized.match(/Registered file references[^]*?\n(\[[^]*?\])/);
          assert.ok(files, serialized);
          const values = JSON.parse(files[1]);
          input = { code: `from pilotdeck_tools import run_sop\nimport json\nfiles = json.loads(${JSON.stringify(JSON.stringify(values))})\nprint(run_sop(requestId="batch", sopId="invoice", version="1", concurrency=3, items=[{"itemKey": str(i), "input": {"files": [f]}} for i,f in enumerate(files)]))` };
        } else {
          yield { type: "message_start", role: "assistant" };
          yield { type: "text_delta", text: "Batch accepted." };
          yield { type: "message_end", finishReason: "stop" };
          return;
        }
        const toolCall = { id: `call-${observed.length}`, name, input };
        yield { type: "message_start", role: "assistant" };
        yield { type: "tool_call_start", id: toolCall.id, name };
        yield { type: "tool_call_end", toolCall };
        yield { type: "message_end", finishReason: "tool_call" };
      },
    };
    local = createLocalGateway({ projectRoot: root, pilotHome: root, fallbackProjectRoot: root,
      permissionMode: "bypassPermissions", env: { ...process.env, PILOT_HOME: root, PILOTDECK_CONFIG_PATH: join(root, "pilotdeck.yaml"), PILOTDECK_SOP_V4_ENDPOINT: endpoint, SOP_V4_HOST_TOKEN: token },
      ...(!real ? { __testModelInvocationProviderFactory: () => [model] as never } : {}),
    });
    server = await startGatewayServer({ gateway: local.gateway, port: 0, token: "local-sdk-test" });
    sdk = createPilotDeckClient({ gatewayUrl: server.wsUrl, authToken: server.token, projectKey: root });
    const files = Array.from({ length: 12 }, (_, i) => ({ clientFileId: `file-${i + 1}`, relativePath: `invoice-${i + 1}.txt`, name: `invoice-${i + 1}.txt`, size: Buffer.byteLength(`Invoice ID: INV-${i + 1}\nAmount: ${i + 1}\n`), mimeType: "text/plain" }));
    const upload = await local.gateway.uploadCreate!({ projectKey: root, files });
    for (let i = 0; i < files.length; i++) await local.gateway.uploadPart!({ uploadId: upload.uploadId, clientFileId: files[i].clientFileId,
      contentBase64: Buffer.from(`Invoice ID: INV-${i + 1}\nAmount: ${i + 1}\n`).toString("base64") });
    await local.gateway.uploadComplete!({ uploadId: upload.uploadId });
    const events = [];
    for await (const event of local.gateway.submitTurn({ sessionKey: "batch-agent", projectKey: root, channelKey: "test", runId: "batch-agent-turn",
      uploadedAttachments: [{ uploadId: upload.uploadId }],
      message: 'Use execute_code and from pilotdeck_tools import run_sop to launch invoice version "1" for all 12 registered files. One item per file, input {files:[file]}, unique itemKey. Decide concurrency between 2 and 4. requestId="batch". Print returned runId then end with a short acknowledgement. Do not read invoice contents yourself; do not wait or poll.' })) events.push(event);
    const serialized = JSON.stringify(events);
    assert.ok(serialized.includes("execute_code"), serialized.slice(-4000));
    const id = serialized.match(/\\?"runId\\?"\s*:\s*\\?"([a-f0-9]{32})/)?.[1];
    assert.ok(id, serialized.slice(-5000));
    const done = await sdk.sop.call("sop_wait", { runId: id, timeoutMs: 60_000 });
    let status = done;
    for (let i = 0; status.status === "running" && i < 8; i++) status = await sdk.sop.call("sop_wait", { runId: id, timeoutMs: 60_000 });
    assert.equal(status.status, "completed", JSON.stringify(status));
    const results = await sdk.sop.call("sop_result", { runId: id });
    const items = results.items as { output: { id: string; amount: number } }[];
    assert.equal(items.length, 12);
    assert.deepEqual(items.map(item => item.output.id).sort(), files.map((_, i) => `INV-${i + 1}`).sort());
    assert.equal(items.reduce((sum, item) => sum + item.output.amount, 0), 78);
    const persisted = await sdk.sop.call("sop_events", { runId: id });
    assert.ok((persisted.events as unknown[]).length > 12);
    const allEvents = [];
    for await (const event of sdk.sop.events(id)) allEvents.push(event);
    assert.ok(allEvents.length >= (persisted.events as unknown[]).length);
    if (!real) {
      const nodes = observed.filter(request => JSON.stringify(request.messages).includes("Execute this SOP node"));
      assert.equal(nodes.length, 12);
      for (const request of nodes) {
        const ids = JSON.stringify(request.messages).match(/INV-\d+/g) ?? [];
        assert.equal(new Set(ids).size, 1, "Each request sees exactly its own invoice");
      }
    }
    if (real) {
      for (const concurrency of [1, 3]) {
        const launched = await sdk.sop.call("run_sop", { requestId: `company-${concurrency}`, sopId: concurrency === 3 ? "company-nested" : "company", version: "1", concurrency,
          input: { originalQuery: "Company shareholders are Alice, Bob and Carol. Investigate each using the configured subSOP." } });
        let finished;
        for (let i = 0; i < 8; i++) { finished = await sdk.sop.call("sop_wait", { runId: launched.runId, timeoutMs: 60_000 }); if (finished.status !== "running") break; }
        assert.equal(finished?.status, "completed", JSON.stringify(finished));
        const result = await sdk.sop.call("sop_result", { runId: launched.runId });
        assert.equal(((result.items as { output: unknown[] }[])[0].output).length, 3);
        const calls = finished!.calls as { model: { model: string }; nodeId: string }[];
        assert.ok(calls.some(call => call.nodeId === "research" && call.model.model === secondModel.model));
      }
      const failing = await sdk.sop.call("run_sop", { requestId: "failure", sopId: "company-failure", version: "1",
        input: { originalQuery: "Shareholders: Alice, Bob, Carol" }, concurrency: 3 });
      const failed = await sdk.sop.call("sop_wait", { runId: failing.runId, timeoutMs: 60000 });
      assert.equal(failed.status, "failed", JSON.stringify(failed));
      const failedCalls = failed.calls as { id: string; status: string; nodeId: string; itemKey: string; attempt: number }[];
      const leaf = failedCalls.filter(call => call.nodeId === "research" && call.status === "failed");
      assert.equal(leaf.length, 1);
      assert.equal(leaf[0].itemKey.toLowerCase(), "bob");
      await sdk.sop.call("sop_retry", { runId: failing.runId, requestId: "retry-bob", callIds: [leaf[0].id] });
      const recovered = await sdk.sop.call("sop_wait", { runId: failing.runId, timeoutMs: 60000 });
      assert.equal(recovered.status, "completed", JSON.stringify(recovered));
      const recoveredCalls = recovered.calls as typeof failedCalls;
      assert.equal(recoveredCalls.find(call => call.id === leaf[0].id)?.attempt, 2);
      assert.ok(recoveredCalls.filter(call => call.nodeId === "research" && call.id !== leaf[0].id).every(call => call.attempt === 1));
    }
    console.log(JSON.stringify({ real, files: 12, total: 78, runId: id, status: status.status, deterministicModelRequests: observed.length, evidenceDirectory: root }));
  } finally {
    await sdk?.close();
    await server?.close();
    await local?.dispose();
    child.kill("SIGTERM");
    await exited;
    if (!real) await rm(root, { recursive: true, force: true });
  }
}
