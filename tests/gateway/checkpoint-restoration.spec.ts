import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createLocalGateway } from "../../src/cli/createLocalGateway.js";
import { createModelRuntime, type CanonicalModelEvent, type CanonicalModelRequest } from "../../src/model/index.js";
import type { PilotConfigSnapshot } from "../../src/pilot/config/types.js";
import { createAgentProjectSessionStorage, readTranscript, replayTranscriptEntries } from "../../src/session/index.js";
import { activeTranscriptEntries } from "../../src/session/transcript/CompactSnapshot.js";
import { readWebSessionMessages } from "../../src/web/server/readSessionMessages.js";
import type { CheckpointSummary, RestorePlan, RestoreOperation } from "../../src/session/checkpoints/types.js";
import { createProjectId } from "../../src/pilot/index.js";
import { replaceLastWebSessionTurn, finalizeLastWebSessionTurnReplacement } from "../../src/web/server/replaceLastTurn.js";

async function fixture(t: test.TestContext) {
  const base = await mkdtemp(join(tmpdir(), "pilotdeck-gateway-checkpoints-")), home = join(base, "home"), workspace = join(base, "workspace");
  await mkdir(home); await mkdir(workspace); await mkdir(join(home, "skills"));
  const registration = join(home, "projects", createProjectId(workspace));
  await mkdir(registration, { recursive: true }); await writeFile(join(registration, ".cwd"), workspace);
  await writeFile(join(home, "pilotdeck.yaml"), `schemaVersion: 1
agent: { model: test/model, maxContextTokens: 32768, maxOutputTokens: 4096 }
extension:
  builtinPluginsEnabled: { windows-skills: false, browser-use: false, funasr: false }
memory: { enabled: false }
telemetry: { enabled: false }
model:
  providers:
    test:
      protocol: openai
      url: https://example.test/v1
      apiKey: test-key
      models: { model: {} }
`);
  const requests: CanonicalModelRequest[] = [];
  const options = {
    pilotHome: home, projectRoot: workspace, builtinSkillsRoot: join(home, "skills"),
    env: { ...process.env, PILOT_HOME: home, PILOT_AGENT_MODEL: undefined, PILOTDECK_CONFIG_PATH: undefined },
    __testModelFactory: (snapshot: PilotConfigSnapshot) => ({
      ...createModelRuntime(snapshot.config.model),
      async *stream(request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
        requests.push(request);
        const text = request.messages.at(-1)?.content.filter(item => item.type === "text").map(item => item.type === "text" ? item.text : "").join("");
        if (text === "first" || text === "second") await writeFile(join(workspace, "demo.txt"), text);
        yield { type: "request_started", provider: request.provider, model: request.model };
        yield { type: "message_start", role: "assistant" };
        yield { type: "text_delta", text: `reply ${text}` };
        yield { type: "message_end", finishReason: "stop" };
      },
      async complete() { return { role: "assistant" as const, content: [{ type: "text" as const, text: "Checkpoint QA" }], finishReason: "stop" as const }; },
    }),
  };
  let local = createLocalGateway(options);
  t.after(async () => { local.dispose(); await rm(base, { recursive: true, force: true }); });
  const sessionKey = "web:checkpoint-qa", input = { projectKey: workspace, sessionKey };
  return {
    home, workspace, sessionKey, requests, input,
    get gateway() { return local.gateway; },
    restart() { local.dispose(); local = createLocalGateway(options); },
    async submit(message: string) { for await (const _event of local.gateway.submitTurn({ ...input, channelKey: "web", message })) { /* consume */ } },
    async list() { return await local.gateway.manageCheckpoints!({ ...input, action: "list" }) as { checkpoints: CheckpointSummary[]; sessionChanges: CheckpointSummary["changes"]; sessionRevision: string }; },
    async history() {
      const storage = createAgentProjectSessionStorage({ projectRoot: workspace, pilotHome: home, sessionId: sessionKey });
      return (await readTranscript(storage.transcriptPath)).entries;
    },
  };
}

test("restoration changes persisted model context and UI history, survives restart, and preserves later conversation on undo", async t => {
  const f = await fixture(t);
  await writeFile(join(f.workspace, "demo.txt"), "baseline");
  await f.submit("first"); await f.submit("second");
  const checkpoints = (await f.list()).checkpoints.filter(item => item.phase === "after");
  assert.equal(checkpoints.length, 2); assert.equal(checkpoints[0].changes.length, 1);
  const plan = await f.gateway.manageCheckpoints!({ ...f.input, action: "preview", checkpointId: checkpoints[0].id, scope: "since", mode: "both" }) as RestorePlan;
  assert.equal(plan.files[0].status, "ready");
  const operation = await f.gateway.manageCheckpoints!({ ...f.input, action: "restore", planId: plan.id }) as RestoreOperation;
  assert.equal(await readFile(join(f.workspace, "demo.txt"), "utf8"), "baseline");
  const raw = await f.history();
  assert.equal(raw.filter(entry => entry.type === "accepted_input").length, 2);
  assert.equal(activeTranscriptEntries(raw).filter(entry => entry.type === "accepted_input").length, 0);
  const ui = await readWebSessionMessages({ sessionKey: f.sessionKey }, { projectRoot: f.workspace, pilotHome: f.home });
  assert.ok(!ui.messages.some(message => message.text === "first" || message.text === "second"));
  assert.equal((await f.list()).sessionChanges.length, 0);
  f.restart(); await f.submit("continue");
  const latest = f.requests.at(-1)!;
  const contextText = JSON.stringify(latest.messages);
  assert.ok(contextText.includes("continue")); assert.ok(!contextText.includes('"text":"first"')); assert.ok(!contextText.includes('"text":"second"'));
  assert.ok(contextText.includes("current filesystem is authoritative"));
  const undo = await f.gateway.manageCheckpoints!({ ...f.input, action: "undo", operationId: operation.id }) as RestorePlan;
  assert.equal(undo.mode, "files");
  await f.gateway.manageCheckpoints!({ ...f.input, action: "restore", planId: undo.id });
  assert.equal(await readFile(join(f.workspace, "demo.txt"), "utf8"), "second");
  assert.ok(JSON.stringify(replayTranscriptEntries(await f.history()).messages).includes('"text":"continue"'));
});

test("partial file/conversation rewind keeps the remaining session diff restorable, including undo and conversation-only branches", async t => {
  const f = await fixture(t); await writeFile(join(f.workspace, "demo.txt"), "baseline");
  await f.submit("first"); await f.submit("second");
  const original = await f.list(), rounds = original.checkpoints.filter(item => item.phase === "after");
  const plan = await f.gateway.manageCheckpoints!({ ...f.input, action: "preview", checkpointId: rounds[1].id, mode: "both" }) as RestorePlan;
  const operation = await f.gateway.manageCheckpoints!({ ...f.input, action: "restore", planId: plan.id }) as RestoreOperation;
  assert.equal(await readFile(join(f.workspace, "demo.txt"), "utf8"), "first");
  const restored = await f.list(); assert.equal(restored.sessionChanges[0].restorable, true);
  assert.notEqual(restored.sessionRevision, original.sessionRevision);
  const diff = await f.gateway.manageCheckpoints!({ ...f.input, action: "diff", checkpointId: rounds[0].id, filePath: "demo.txt", scope: "session" }) as { oldContent: string; newContent: string };
  assert.equal(diff.oldContent, "baseline"); assert.equal(diff.newContent, "first");
  const sessionPlan = await f.gateway.manageCheckpoints!({ ...f.input, action: "preview", checkpointId: rounds[0].id, scope: "session" }) as RestorePlan;
  assert.equal(sessionPlan.files[0].status, "ready");
  await f.gateway.manageCheckpoints!({ ...f.input, action: "restore", planId: sessionPlan.id });
  assert.equal(await readFile(join(f.workspace, "demo.txt"), "utf8"), "baseline");
  const undo = await f.gateway.manageCheckpoints!({ ...f.input, action: "undo", operationId: operation.id }) as RestorePlan;
  assert.equal(undo.files[0].status, "conflict"); // A later session restore is protected.

  const g = await fixture(t); await writeFile(join(g.workspace, "demo.txt"), "baseline"); await g.submit("first");
  const checkpoint = (await g.list()).checkpoints.find(item => item.phase === "after")!;
  const conversationPlan = await g.gateway.manageCheckpoints!({ ...g.input, action: "preview", checkpointId: checkpoint.id, mode: "conversation" }) as RestorePlan;
  await g.gateway.manageCheckpoints!({ ...g.input, action: "restore", planId: conversationPlan.id });
  assert.equal(activeTranscriptEntries(await g.history()).filter(entry => entry.type === "accepted_input").length, 0);
  assert.equal((await g.list()).sessionChanges[0].restorable, true);
});

test("editing the last visible turn after a rewind preserves archived history and supports transaction rollback", async t => {
  const f = await fixture(t); await writeFile(join(f.workspace, "demo.txt"), "baseline"); await f.submit("first"); await f.submit("second");
  const rounds = (await f.list()).checkpoints.filter(item => item.phase === "after");
  const plan = await f.gateway.manageCheckpoints!({ ...f.input, action: "preview", checkpointId: rounds[1].id, mode: "both" }) as RestorePlan;
  await f.gateway.manageCheckpoints!({ ...f.input, action: "restore", planId: plan.id });
  const original = await f.history(), firstInput = activeTranscriptEntries(original).find(entry => entry.type === "accepted_input")!;
  const input = { ...f.input, expectedTurnId: firstInput.turnId, replacementTurnId: "replacement" };
  const options = { projectRoot: f.workspace, pilotHome: f.home };
  const replacement = await replaceLastWebSessionTurn(input, options);
  const prepared = await f.history(); assert.equal(prepared.filter(entry => entry.type === "accepted_input").length, 2);
  assert.equal(activeTranscriptEntries(prepared).filter(entry => entry.type === "accepted_input").length, 0);
  assert.equal(replayTranscriptEntries(prepared).messages.length, 0);
  assert.equal(replayTranscriptEntries(prepared).metadata.firstPrompt, undefined);
  await finalizeLastWebSessionTurnReplacement({ ...f.input, transactionId: replacement.transactionId, action: "rollback" }, options);
  assert.deepEqual(await f.history(), original);
  const committed = await replaceLastWebSessionTurn(input, options);
  await finalizeLastWebSessionTurnReplacement({ ...f.input, transactionId: committed.transactionId, action: "commit" }, options);
  f.restart(); await f.submit("corrected first");
  const raw = await f.history(); assert.equal(raw.filter(entry => entry.type === "accepted_input").length, 3);
  assert.equal(activeTranscriptEntries(raw).filter(entry => entry.type === "accepted_input").length, 1);
  const context = JSON.stringify(f.requests.at(-1)!.messages);
  assert.ok(context.includes('"text":"corrected first"')); assert.ok(!context.includes('"text":"first"')); assert.ok(!context.includes('"text":"second"'));
  assert.equal(await readFile(join(f.workspace, "demo.txt"), "utf8"), "first");
  assert.equal(replayTranscriptEntries(raw).metadata.firstPrompt, "corrected first");
});

test("conversation-only rewind preserves files, and new turns invalidate a conversation restore preview", async t => {
  const f = await fixture(t);
  await writeFile(join(f.workspace, "demo.txt"), "baseline"); await f.submit("first");
  const checkpoint = (await f.list()).checkpoints.find(item => item.phase === "after")!;
  const stale = await f.gateway.manageCheckpoints!({ ...f.input, action: "preview", checkpointId: checkpoint.id, mode: "conversation" }) as RestorePlan;
  await f.submit("second");
  await assert.rejects(f.gateway.manageCheckpoints!({ ...f.input, action: "restore", planId: stale.id }), { code: "STALE_PLAN" });
  const plan = await f.gateway.manageCheckpoints!({ ...f.input, action: "preview", checkpointId: checkpoint.id, mode: "conversation" }) as RestorePlan;
  const operation = await f.gateway.manageCheckpoints!({ ...f.input, action: "restore", planId: plan.id }) as RestoreOperation;
  assert.equal(await readFile(join(f.workspace, "demo.txt"), "utf8"), "second"); assert.equal(operation.applied.length, 0);
  const undo = await f.gateway.manageCheckpoints!({ ...f.input, action: "undo", operationId: operation.id }) as RestorePlan;
  assert.equal(undo.mode, "conversation");
  await f.gateway.manageCheckpoints!({ ...f.input, action: "restore", planId: undo.id });
  assert.equal(activeTranscriptEntries(await f.history()).filter(entry => entry.type === "accepted_input").length, 2);
});
