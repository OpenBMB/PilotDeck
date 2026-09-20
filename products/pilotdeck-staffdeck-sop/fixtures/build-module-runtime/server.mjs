import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";

const slot = process.env.MODULE_SLOT ?? "module";
const implementationId = process.env.MODULE_IMPLEMENTATION_ID ?? `fixture.${slot}`;
const port = Number(process.env.MODULE_PORT ?? 9000);
const contracts = { agentLoop: "pilotdeck.agent-loop/v1", skills: "pilotdeck.skills/v1", tools: "pilotdeck.tools/v1", context: "pilotdeck.context/v1", modelProvider: "pilotdeck.model/v1", knowledge: "staffdeck.knowledge/v1", sop: "sop.lifecycle/v2" };
const methodMap = {
  agentLoop: ["execute", "cancel", "status", "resume", "ack"], skills: ["list", "read"], tools: ["execute"],
  context: ["prepare_for_model", "apply_tool_results", "recover_from_model_error", "capture_turn", "try_auto_compact"],
  modelProvider: ["prepare", "stream"], knowledge: ["list_bases", "create_base", "get_base", "update_base", "delete_base", "list_versions", "sync_base", "publish_version", "rollback_version", "list_documents", "get_document", "import_document", "import_okf", "update_document", "delete_document", "list_document_buckets", "update_bucket", "list_bucket_chunks", "update_chunk", "get_job", "list_jobs", "cancel_job", "list_okf_concepts", "get_okf_concept", "upsert_okf_concept", "export_okf", "lint_okf", "list_discoveries", "confirm_discovery", "reject_discovery", "query", "resolve_citation"], sop: ["prepare", "submit", "status", "resume"],
};
const manifest = { protocolVersion: "2.0", implementationId, contract: contracts[slot], transport: slot === "agentLoop" ? "module-tcp-v2" : slot === "sop" ? "sop-http-v2" : "module-http-v2", methods: methodMap[slot] ?? [], state: { ownership: "module", persistence: "fixture-volume" } };

const http = createServer(async (request, response) => {
  if (request.url === "/healthz" || request.url === "/module-manifest") return send(response, 200, request.url === "/healthz" ? { status: "ok", ...manifest } : manifest);
  if (request.method !== "POST") return send(response, 405, { error: "method_not_allowed" });
  const body = await readJson(request);
  const operation = body?.payload?.operation ?? body?.operation ?? "unknown";
  return send(response, 200, { kind: "response", messageId: `response-${String(body?.messageId ?? "unknown")}`, inReplyTo: body?.messageId, requestId: body?.requestId, ok: true, payload: { result: { operation, accepted: true, input: body?.payload?.input ?? {} } } });
});

if (slot === "agentLoop") {
  createTcpServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      while (buffer.includes("\n")) {
        const index = buffer.indexOf("\n");
        const line = buffer.slice(0, index); buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        let message; try { message = JSON.parse(line); } catch { continue; }
        for (const reply of replies(message)) socket.write(`${JSON.stringify(reply)}\n`);
      }
    });
  }).listen(port, "0.0.0.0");
} else http.listen(port, "0.0.0.0");

function replies(message) {
  if (message.kind !== "request") return [];
  const binding = { kind: "response", messageId: `fixture-${message.method}`, inReplyTo: message.messageId, ok: true, protocolVersion: "2.0", moduleId: implementationId, moduleInstanceId: `${implementationId}-instance-1`, connectionGeneration: `${implementationId}-generation-1`, capabilitiesVersion: "1", payload: message.method === "capabilities" ? { capabilitiesVersion: "1", methods: [{ name: "execute", enabled: true, profiles: ["streaming"], resumeSupport: "none" }, { name: "cancel", enabled: true }, { name: "status", enabled: true }, { name: "resume", enabled: false }, { name: "ack", enabled: false }] } : {} };
  if (message.method !== "execute") return [binding];
  return [
    { ...binding, streamId: `stream-${message.operationId}`, cursor: 0 },
    { kind: "event", messageId: `event-${message.operationId}`, eventType: "agent.execute.completed", streamId: `stream-${message.operationId}`, sequence: 0, runId: message.runId, operationId: message.operationId, requestId: message.requestId, final: true, outcome: "completed", payload: { result: { type: "success", sessionId: message.sessionId, turnId: message.turnId, stopReason: "completed", usage: {}, permissionDenials: [], turns: 1, startedAt: new Date().toISOString(), completedAt: new Date().toISOString() }, messages: [] } },
  ];
}

async function readJson(request) { let data = ""; for await (const chunk of request) data += chunk; try { return JSON.parse(data); } catch { return {}; } }
function send(response, status, body) { response.writeHead(status, { "content-type": "application/json" }); response.end(JSON.stringify(body)); }
