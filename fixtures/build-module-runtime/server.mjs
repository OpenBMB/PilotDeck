import { createServer } from "node:http";
import { createServer as createTcpServer } from "node:net";

const slot = process.env.MODULE_SLOT ?? "module";
const implementationId = process.env.MODULE_IMPLEMENTATION_ID ?? `fixture.${slot}`;
const port = Number(process.env.MODULE_PORT ?? 9000);
const contract = {
  skills: "pilotdeck.skills/v1",
  tools: "pilotdeck.tools/v1",
  context: "pilotdeck.context/v1",
  modelProvider: "pilotdeck.model/v1",
  knowledge: "staffdeck.knowledge/v1",
  sop: "sop.lifecycle/v2",
  agentLoop: "pilotdeck.agent-loop/v1",
}[slot] ?? "pilotdeck.module/v1";
const methods = {
  skills: ["list", "read"],
  tools: ["execute"],
  context: ["prepare_for_model", "apply_tool_results", "recover_from_model_error", "capture_turn", "try_auto_compact"],
  modelProvider: ["prepare", "stream"],
  knowledge: ["list_bases", "create_base", "delete_base", "list_versions", "publish_version", "list_documents", "import_document", "update_document", "delete_document", "get_job", "cancel_job", "query", "resolve_citation"],
  sop: ["prepare", "submit", "status", "resume"],
}[slot] ?? [];

const manifest = {
  protocolVersion: "2.0",
  implementationId,
  contract,
  transport: slot === "agentLoop" ? "module-tcp-v2" : "module-http-v2",
  methods,
  state: { ownership: "module", persistence: "fixture-volume" },
};

const http = createServer(async (request, response) => {
  if (request.url === "/healthz" || request.url === "/module-manifest") {
    return json(response, 200, request.url === "/healthz" ? { status: "ok", ...manifest } : manifest);
  }
  if (request.method !== "POST") return json(response, 405, { error: "method_not_allowed" });
  const body = await readJson(request);
  const operation = body?.payload?.operation ?? body?.operation ?? "unknown";
  return json(response, 200, {
    kind: "response",
    messageId: `response-${String(body?.messageId ?? "unknown")}`,
    inReplyTo: body?.messageId,
    requestId: body?.requestId,
    ok: true,
    payload: { result: fixtureResult(operation, body?.payload?.input ?? {}) },
  });
});
http.listen(port, "0.0.0.0");

if (slot === "agentLoop") {
  const tcp = createTcpServer((socket) => {
    let buffer = "";
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => {
      buffer += chunk;
      while (buffer.includes("\n")) {
        const index = buffer.indexOf("\n");
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        if (!line.trim()) continue;
        let message;
        try { message = JSON.parse(line); } catch { continue; }
        for (const response of handleTcp(message)) socket.write(`${JSON.stringify(response)}\n`);
      }
    });
  });
  tcp.listen(port, "0.0.0.0");
}

function handleTcp(message) {
  if (message.kind !== "request") return [];
  const binding = {
    kind: "response",
    messageId: `fixture-${message.method}`,
    inReplyTo: message.messageId,
    ok: true,
    protocolVersion: "2.0",
    moduleId: implementationId,
    moduleInstanceId: `${implementationId}-instance-1`,
    connectionGeneration: `${implementationId}-generation-1`,
    capabilitiesVersion: "1",
    payload: message.method === "capabilities"
      ? { capabilitiesVersion: "1", methods: [
          { name: "execute", enabled: true, profiles: ["streaming"], resumeSupport: "none" },
          { name: "cancel", enabled: true }, { name: "status", enabled: true },
          { name: "resume", enabled: false }, { name: "ack", enabled: false },
        ] }
      : {},
  };
  if (message.method !== "execute") return [binding];
  const request = message;
  return [
    { ...binding, streamId: `stream-${request.operationId}`, cursor: 0 },
    {
      kind: "event", messageId: `fixture-event-${request.operationId}`, eventType: "agent.execute.completed",
      streamId: `stream-${request.operationId}`, sequence: 0, runId: request.runId,
      operationId: request.operationId, requestId: request.requestId, final: true, outcome: "completed",
      payload: { result: { type: "success", sessionId: request.sessionId, turnId: request.turnId, stopReason: "completed", usage: {}, permissionDenials: [], turns: 1, startedAt: new Date().toISOString(), completedAt: new Date().toISOString() }, messages: [] },
    },
  ];
}

function fixtureResult(operation, input) {
  if (operation === "prepare_for_model") return { messages: input.messages ?? [], systemPromptParts: ["fixture context"], tools: input.tools ?? [], diagnostics: [], boundaries: [] };
  if (operation === "prepare") return { prepared: { request: input.request ?? {} } };
  if (operation === "stream") return { events: [{ type: "message_end", finishReason: "stop" }] };
  return { operation, accepted: true, input };
}

async function readJson(request) {
  let data = "";
  for await (const chunk of request) data += chunk;
  try { return JSON.parse(data); } catch { return {}; }
}

function json(response, status, body) {
  response.writeHead(status, { "content-type": "application/json" });
  response.end(JSON.stringify(body));
}
