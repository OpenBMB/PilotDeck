import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse, stringify } from "yaml";
import { createLocalGateway } from "../../../dist/src/cli/createLocalGateway.js";
import { FeishuChannel } from "../../../dist/src/adapters/channel/feishu/FeishuChannel.js";
import { PortableSopRuntimeClient } from "../../../dist/src/sop/staffdeck/PortableSopRuntimeClient.js";

const root = process.env.SOP_ACCEPTANCE_ROOT;
assert.ok(root, "Set SOP_ACCEPTANCE_ROOT to a private evidence directory");
await mkdir(root, { recursive: true, mode: 0o700 });
const dotenv = parseEnv(await readFile(process.env.SOP_ACCEPTANCE_DOTENV ?? "/Users/a1/Desktop/.env", "utf8"));
const source = parse(await readFile(process.env.SOP_ACCEPTANCE_MODEL_CONFIG ?? "/Users/a1/.pilotdeck/pilotdeck.yaml", "utf8"));
const model = process.env.SOP_ACCEPTANCE_MODEL ?? "provider1/qwen3.6-flash-distill";
const providerId = model.split("/")[0];
const endpoint = process.env.SOP_RUNTIME_ENDPOINT ?? "http://127.0.0.1:26391";
const marker = process.env.SOP_ACCEPTANCE_MARKER ?? "SOP1014";
const project = join(root, "feishu-project");
await mkdir(project, { recursive: true, mode: 0o700 });
await writeFile(join(project, "approval-context.txt"), "SOP1014 release requires owner approval.\n");
const definition = { id: `feishu_acceptance_${Date.now()}`, version: "1", name: "Feishu release approval",
  content: { start_node_id: "approval", terminal_node_ids: ["approval"], nodes: [{ node_id: "approval", type: "handoff",
    assignee_user_id: "sop-reviewer", allowed_actions: ["call_tool:read_file"],
    instruction: "Call read_file for approval-context.txt, then submit_step_result status handoff and ask for operator approval. After human approval, submit completed with replyFragment FEISHU_SOP_COMPLETE." }] } };
const runtime = new PortableSopRuntimeClient(endpoint);
await runtime.publishDefinition({ sop_id: definition.id, version: definition.version, name: definition.name, content: definition.content });
await writeFile(join(project, "definitions.json"), JSON.stringify({ sops: [definition] }));
await writeFile(join(project, "pilotdeck.yaml"), stringify({ schemaVersion: 1, agent: { model },
  model: { providers: { [providerId]: source.model.providers[providerId] } }, memory: { enabled: false },
  modules: { sop: { enabled: true, implementationId: "portable-sop", contract: "sop.lifecycle/v3", transport: "sop-http-v3",
    endpoint, manifestPath: "/healthz", definitionsPath: "definitions.json", defaultSopId: definition.id } } }), { mode: 0o600 });
const local = createLocalGateway({ projectRoot: project, pilotHome: project, fallbackProjectRoot: project, permissionMode: "bypassPermissions" });
const evidence = { marker, status: "AWAITING_REAL_INPUT", host: "pilotdeck", sessions: [], events: [] };
const save = () => writeFile(join(root, "feishu.json"), JSON.stringify(evidence, null, 2), { mode: 0o600 });
const channel = new FeishuChannel({ appId: dotenv.FEISHU_APP_ID, appSecret: dotenv.FEISHU_APP_SECRET, permissionMode: "bypassPermissions" });
let targetChat;
const originalInbound = channel.handleStreamEvent.bind(channel);
channel.handleStreamEvent = async data => {
  const message = data?.message ?? data?.event?.message;
  if (!message?.chat_id || typeof message.content !== "string") return;
  let text;
  try { text = JSON.parse(message.content).text; } catch { return; }
  if (!targetChat && !text?.includes(marker)) return;
  if (targetChat && message.chat_id !== targetChat) return;
  targetChat = message.chat_id;
  evidence.inbound = { chatId: targetChat, messageId: message.message_id, eventId: data?.header?.event_id };
  evidence.status = "REAL_INPUT_RECEIVED";
  await save();
  await originalInbound(data);
};
const gateway = new Proxy(local.gateway, { get(target, key) {
  if (key !== "submitTurn") {
    const value = Reflect.get(target, key);
    return typeof value === "function" ? value.bind(target) : value;
  }
  return async function* (input) {
    evidence.sessions.push(input.sessionKey);
    for await (const event of target.submitTurn(input)) {
      evidence.events.push(event);
      await save();
      yield event;
    }
    const state = await runtime.session(input.sessionKey);
    evidence.runtime = state;
    evidence.status = state.state.status === "completed" ? "COMPLETED_PENDING_DELIVERY" : "REAL_INPUT_WAITING_APPROVAL";
    await save();
  };
} });
const handle = await channel.start({ gateway, pilotHome: project, logger: {
  info: message => console.log(message), warn: message => console.log(message), error: message => console.log(message),
} });
console.log(`Ready for a real Feishu message containing ${marker}`);
await save();
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await handle.stop();
  await local.dispose();
  process.exit(0);
}
process.on("SIGTERM", close);
process.on("SIGINT", close);
setInterval(async () => {
  const command = join(root, "feishu-resume.json");
  try {
    const input = JSON.parse(await readFile(command, "utf8"));
    if (evidence.resumed) return;
    const sessionKey = evidence.sessions.at(-1);
    const status = await local.sopControl.status({ sessionKey, projectKey: project });
    assert.ok(status?.wait);
    await local.sopControl.resume({ sessionKey, projectKey: project, requestId: "feishu-operator-resume",
      waitId: status.wait.id, expectedRevision: status.revision, source: "human", message: input.message,
      authority: { tenantId: "sop-acceptance", sessionId: sessionKey, subject: {
        tenantId: "sop-acceptance", userId: "sop-reviewer", source: "web", role: "admin", disabled: false } } });
    evidence.resumed = true;
    await save();
    const events = [];
    for await (const event of gateway.submitTurn({ sessionKey, channelKey: "feishu", workspaceCwd: project,
      message: input.message, mode: "bypassPermissions" })) events.push(event);
    const reply = events.filter(event => event.type === "assistant_text_delta").map(event => event.text ?? event.delta ?? "").join("");
    const messageId = await channel.sendTextMessage({ chatId: targetChat, text: reply || "FEISHU_SOP_COMPLETE" });
    evidence.outboundMessageId = messageId;
    if (messageId && evidence.runtime?.state.status === "completed") evidence.status = "PASS_HOST_CONTROL";
    await save();
  } catch (error) {
    if (error.code !== "ENOENT") console.log(`Approval continuation: ${error.message}`);
  }
}, 1000);

function parseEnv(text) {
  return Object.fromEntries(text.split(/\r?\n/u).filter(line => /^[A-Za-z_][A-Za-z0-9_]*=/u.test(line))
    .map(line => { const index = line.indexOf("="); return [line.slice(0, index), line.slice(index + 1).trim().replace(/^(['"])(.*)\1$/u, "$2")]; }));
}
