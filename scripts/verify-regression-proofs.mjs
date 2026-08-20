#!/usr/bin/env node

import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const execFileAsync = promisify(execFile);
const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const NODE = process.execPath;

const CASES = [
  {
    id: "cron-origin-rejection",
    source: "src/adapters/channel/protocol/ImCronDelivery.ts",
    target: "tests/adapters/im-cron-delivery.spec.ts",
    name: "IM cron delivery reports transport rejection and propagates transport errors",
    mutation: (source) => replaceOnce(source,
      "return (await sendText(chatId, delivery.text)) !== false;",
      "await sendText(chatId, delivery.text);\n  return true;",
    ),
  },
  {
    id: "cron-session-key-validation",
    source: "src/adapters/channel/protocol/ImCronDelivery.ts",
    target: "tests/adapters/im-cron-delivery.spec.ts",
    name: "IM cron session keys require a channel match and a complete session suffix",
    mutation: (source) => replaceOnce(source,
      "/^(.+):(general|s_[0-9a-fA-F-]{36})$/",
      "/^(.+):(.+)$/",
    ),
  },
  {
    id: "renderer-tool-noise",
    source: "src/adapters/channel/weixin/weixin-render.ts",
    target: "tests/adapters/im-renderers.spec.ts",
    name: "IM renderers suppress tool start and successful tool completion noise",
    mutation: (source) => replaceOnce(source,
      'case "tool_call_started":\n      return "";',
      'case "tool_call_started":\n      return "tool started";',
    ),
  },
  {
    id: "feishu-elicitation-capture",
    source: "src/adapters/channel/feishu/FeishuChannel.ts",
    target: "tests/adapters/feishu-permission-reply.spec.ts",
    name: "Feishu webhook captures an elicitation and pairs the public reply with the Gateway request",
    mutation: (source) => replaceOnce(source,
      "const questionText = this.elicitation.capture(chatId, turn.sessionKey, event);",
      'const questionText = "elicitation not captured";',
    ),
  },
  {
    id: "weixin-permission-activity-delay",
    source: "src/adapters/channel/weixin/WeixinChannel.ts",
    target: "tests/adapters/weixin-lifecycle.spec.ts",
    name: "Weixin public poll delays permission activity until the configured timer fires",
    mutation: (source) => replaceOnce(source,
      'resumeActivity("tool", { immediate: false })',
      'resumeActivity("tool", { immediate: true })',
    ),
  },
  {
    id: "signal-receive-concurrency",
    source: "src/adapters/channel/signal/SignalChannel.ts",
    target: "tests/adapters/signal-stream-lifecycle.spec.ts",
    name: "Signal public SSE loop handles a permission answer while its turn is still pending",
    mutation: (source) => replaceOnce(source,
      "void this.parseLine(line).catch((e) => {",
      "await this.parseLine(line).catch((e) => {",
    ),
  },
  {
    id: "weixin-busy-queue",
    source: "src/adapters/channel/weixin/WeixinChannel.ts",
    target: "tests/adapters/weixin-lifecycle.spec.ts",
    name: "Weixin public poll drains busy messages FIFO and snapshots queued attachments",
    mutation: (source) => replaceOnce(source,
      'this.queuePendingTurn(fromUser, {\n        sessionKey: mapped.sessionKey,\n        message: mapped.message,\n        projectKey: mapped.projectKey,\n        attachments: extracted.attachments,\n      });',
      "return;",
    ),
  },
  {
    id: "weixin-content-length",
    source: "src/adapters/channel/weixin/WeixinChannel.ts",
    target: "tests/adapters/weixin-fetch-compat.spec.ts",
    name: "Weixin iLink fetch removes content-length without changing unrelated requests",
    mutation: (source) => replaceOnce(source,
      "const headers = stripContentLengthHeader(init.headers);",
      "const headers = init.headers;",
    ),
  },
  {
    id: "weixin-poll-rebuild",
    source: "src/adapters/channel/weixin/WeixinChannel.ts",
    target: "tests/adapters/weixin-lifecycle.spec.ts",
    name: "Weixin public poll rebuilds a recoverable client with the live cursor",
    mutation: (source) => replaceOnce(source,
      "this.rebuildClientAfterPollError(e);",
      "// client rebuild removed by mutation proof",
    ),
  },
  {
    id: "weixin-file-decryption",
    source: "src/adapters/channel/weixin/WeixinChannel.ts",
    target: "tests/adapters/weixin-lifecycle.spec.ts",
    name: "Weixin public poll decrypts a nested encrypted file before Gateway submission",
    mutation: (source) => replaceOnce(source,
      "transform: (buffer) => this.decryptWeixinFile(buffer, file),",
      "transform: (buffer) => buffer,",
    ),
  },
  {
    id: "weixin-qr-poll-start",
    source: "src/adapters/channel/weixin/WeixinChannel.ts",
    target: "tests/adapters/weixin-lifecycle.spec.ts",
    name: "Weixin starts polling when a background QR login completes after start returns",
    mutation: (source) => replaceOnce(source,
      "this.logger?.info?.(`weixin: login successful, accountId=${result.accountId}`);\n      this.startPollingWithCredentials(creds);",
      "this.logger?.info?.(`weixin: login successful, accountId=${result.accountId}`);",
    ),
  },
  {
    id: "weixin-assistant-attachment",
    source: "src/adapters/channel/weixin/WeixinChannel.ts",
    target: "tests/adapters/weixin-lifecycle.spec.ts",
    name: "Weixin public Gateway stream sends only explicit assistant_attachment events as media",
    mutation: (source) => replaceOnce(source,
      'if (event.type === "assistant_attachment") {\n          await this.sendAttachment(userId, event.attachment);\n          continue;\n        }',
      'if (event.type === "assistant_attachment") {\n          continue;\n        }',
    ),
  },
  {
    id: "gateway-busy-session",
    source: "src/gateway/client/InProcessGateway.ts",
    target: "tests/gateway/gateway-lifecycle-regressions.spec.ts",
    name: "InProcessGateway rejects a second turn while the session is busy",
    mutation: (source) => replaceOnce(source,
      "if (!this.router.beginTurn(input.sessionKey, runId)) {",
      "if (this.router.beginTurn(input.sessionKey, runId)) {",
    ),
  },
  {
    id: "gateway-abort-awaits-unwind",
    source: "src/gateway/client/InProcessGateway.ts",
    target: "tests/gateway/gateway-lifecycle-regressions.spec.ts",
    name: "abortTurn resolves only after the active turn has fully unwound",
    mutation: (source) => replaceOnce(source,
      "    await pending;\n  }\n\n  async listSessions",
      "    void pending;\n  }\n\n  async listSessions",
    ),
  },
  {
    id: "gateway-active-replay-pending-only",
    source: "src/gateway/client/InProcessGateway.ts",
    target: "tests/gateway/gateway-lifecycle-regressions.spec.ts",
    name: "active turn replay removes resolved interactive requests",
    mutation: (source) => replaceOnce(source,
      ".filter((event) => this.shouldReplayActiveTurnEvent(input.sessionKey, event))",
      ".filter(() => true)",
    ),
  },
  {
    id: "gateway-ws-close-abort",
    source: "src/gateway/server/GatewayWsConnection.ts",
    target: "tests/gateway/gateway-lifecycle-regressions.spec.ts",
    name: "GatewayWsConnection aborts its in-flight session when the socket closes",
    mutation: (source) => replaceOnce(source,
      "this.options.gateway\n        .abortTurn({ sessionKey })\n        .catch(() => undefined);",
      "void Promise.resolve();",
    ),
  },
  {
    id: "wecom-close-abort",
    source: "src/adapters/channel/wecom/WeComChannel.ts",
    target: "tests/adapters/wecom-lifecycle.spec.ts",
    name: "WeCom socket close aborts active turns, stops heartbeat, and reconnects unless stopped",
    mutation: (source) => replaceOnce(source,
      'void this.abortActiveTurns("wecom websocket closed");',
      "void Promise.resolve();",
    ),
  },
  {
    id: "config-model-conflict-soft-recovery",
    source: "src/pilot/config/loadPilotConfig.ts",
    target: "tests/regressions/config-state-file-regressions.spec.ts",
    name: "conflicting router default model is normalized to the main agent model",
    mutation: (source) => replaceOnce(source,
      "id: agent.model.id,\n      provider: agent.model.provider,\n      model: agent.model.model,",
      "id: previousId,\n      provider: router.scenarios.default.provider,\n      model: router.scenarios.default.model,",
    ),
  },
  {
    id: "router-store-survives-shutdown",
    source: "src/router/RouterRuntime.ts",
    target: "tests/regressions/config-state-file-regressions.spec.ts",
    name: "RouterRuntime shutdown preserves an externally owned session store",
    mutation: (source) => replaceOnce(source,
      "if (!externalStore) sessionStore.clear();",
      "sessionStore.clear();",
    ),
  },
  {
    id: "project-id-collision-resistance",
    source: "src/pilot/paths.ts",
    target: "tests/regressions/config-state-file-regressions.spec.ts",
    name: "collision-resistant project ids distinguish paths with the same legacy slug",
    mutation: (source) => replaceOnce(source,
      "return `${legacyId}--${digest}`;",
      "return legacyId;",
    ),
  },
  {
    id: "file-history-idempotent-first-snapshot",
    source: "src/session/filesystem/FileHistoryStore.ts",
    target: "tests/regressions/config-state-file-regressions.spec.ts",
    name: "FileHistoryStore captures only the first pre-edit value per message",
    mutation: (source) => replaceOnce(source,
      "if (snapshot.trackedFileBackups[absPath]) {",
      "if (false) {",
    ),
  },
  {
    id: "file-history-snapshot-eviction",
    source: "src/session/filesystem/FileHistoryStore.ts",
    target: "tests/regressions/config-state-file-regressions.spec.ts",
    name: "FileHistoryStore evicts old snapshots and unreferenced backups",
    mutation: (source) => replaceOnce(source,
      "while (this.state.snapshots.length > this.options.maxSnapshots) {",
      "while (this.state.snapshots.length >= this.options.maxSnapshots) {",
    ),
  },
  {
    id: "model-tool-result-clone-isolation",
    source: "src/model/protocol/clone.ts",
    target: "tests/regressions/model-router-regressions.spec.ts",
    name: "cloning tool results isolates their nested content",
    mutation: (source) => replaceOnce(source,
      "content: tr.content.map((item) => ({ ...item })),",
      "content: tr.content,",
    ),
  },
  {
    id: "model-tool-call-clone-isolation",
    source: "src/model/protocol/clone.ts",
    target: "tests/regressions/model-router-regressions.spec.ts",
    name: "cloning tool calls isolates nested input objects",
    mutation: (source) => replaceOnce(source,
      "input: tc.input !== undefined ? structuredClone(tc.input) : tc.input,",
      "input: tc.input,",
    ),
  },
  {
    id: "anthropic-cache-breakpoint-cap",
    source: "src/model/providers/anthropic/request.ts",
    target: "tests/regressions/model-router-regressions.spec.ts",
    name: "Anthropic requests keep only the three newest message cache breakpoints",
    mutation: (source) => replaceOnce(source,
      "request.cacheBreakpoints.slice(-MAX_MESSAGE_BREAKPOINTS)",
      "request.cacheBreakpoints.slice(0, MAX_MESSAGE_BREAKPOINTS)",
    ),
  },
  {
    id: "anthropic-transient-retryability",
    source: "src/model/providers/anthropic/stream.ts",
    target: "tests/regressions/model-router-regressions.spec.ts",
    name: "Anthropic stream marks transient provider errors retryable",
    mutation: (source) => replaceOnce(source,
      "retryable: TRANSIENT_ERROR_TYPES.has(errType),",
      "retryable: false,",
    ),
  },
  {
    id: "router-fallback-hides-failed-attempt",
    source: "src/router/RouterRuntime.ts",
    target: "tests/regressions/model-router-regressions.spec.ts",
    name: "RouterRuntime suppresses failed attempt events when fallback succeeds",
    mutation: (source) => replaceOnce(source,
      "if (hasYieldedContent) {\n            yield event;",
      "if (true) {\n            yield event;",
    ),
  },
  {
    id: "router-zero-usage-retry",
    source: "src/router/RouterRuntime.ts",
    target: "tests/regressions/model-router-regressions.spec.ts",
    name: "RouterRuntime retries a zero-usage empty completion without leaking it",
    mutation: (source) => replaceOnce(source,
      "        if (\n          !hasYieldedContent &&\n          zeroUsageEnabled &&\n          outcome.shouldRetryZeroUsage &&\n          zeroUsageAttempt < zeroUsageMax\n        ) {",
      "if (false) {",
    ),
  },
  {
    id: "router-stream-recovery-order",
    source: "src/model/streaming/streamModel.ts",
    target: "tests/router/streaming-recovery.spec.ts",
    name: "stream recovery continues after visible content from a dropped stream",
    mutation: (source) => replaceOnce(source,
      "        currentRequest = buildLiteLLMContinuationRequest(currentRequest, checkpoint.get().partialText);\n        checkpoint.reset();",
      "        currentRequest = { ...currentRequest };\n        checkpoint.reset();",
    ),
  },
  {
    id: "always-on-bypass-deny",
    source: "src/permission/decision/PermissionRuntime.ts",
    target: "tests/regressions/always-on-session-adapter-regressions.spec.ts",
    name: "Always-On deny rules remain effective in bypass mode",
    mutation: (source) => replaceOnce(source,
      "if (denyRule) {",
      "if (denyRule && denyRule.source === \"user\" && denyRule.pattern === \"__never__\") {",
    ),
  },
  {
    id: "always-on-plan-terminal-sync",
    source: "src/always-on/storage/DiscoveryPlanStore.ts",
    target: "tests/regressions/always-on-session-adapter-regressions.spec.ts",
    name: "DiscoveryPlanStore mirrors terminal status into existing executionStatus",
    mutation: (source) => replaceOnce(source,
      "raw.executionStatus = update.status;",
      "raw.executionStatus = raw.executionStatus;",
    ),
  },
  {
    id: "tui-tool-event-pairing",
    source: "src/adapters/channel/tui/app/types.ts",
    target: "tests/regressions/always-on-session-adapter-regressions.spec.ts",
    name: "TUI reducer pairs tool start and finish without leaving stale activity",
    mutation: (source) => replaceOnce(source,
      "activity: state.activity.filter((item) => item.id !== event.toolCallId),",
      "activity: state.activity,",
    ),
  },
  {
    id: "ui-queued-attachment-snapshot",
    suite: "ui",
    source: "ui/src/components/chat/hooks/useChatComposerState.ts",
    target: "src/components/chat/hooks/useChatComposerState.busySend.test.tsx",
    name: "sends the latest queued text and attachments when the active turn completes",
    mutation: (source) => replaceOnce(source,
      "    if (!queuedBusySendRef.current) return;\n    const previous = queuedBusySendSnapshotRef.current;",
      "    return;\n    const previous = queuedBusySendSnapshotRef.current;",
    ),
  },
  {
    id: "ui-stale-websocket-close",
    suite: "ui",
    source: "ui/src/contexts/WebSocketContext.tsx",
    target: "src/contexts/WebSocketContext.lifecycle.test.tsx",
    name: "ignores a stale close callback after the auth token changes",
    mutation: (source) => replaceOnce(source,
      "          if (connectIdRef.current !== id) return;\n          setIsConnected(false);",
      "          if (false) return;\n          setIsConnected(false);",
    ),
  },
];

const args = process.argv.slice(2);
if (args.includes("--list")) {
  for (const item of CASES) console.log(`${item.id}\t${item.name}`);
  process.exit(0);
}
const requested = args.indexOf("--case") >= 0 ? args[args.indexOf("--case") + 1] : undefined;
const requestedIds = requested ? requested.split(",").map((id) => id.trim()).filter(Boolean) : [];
const selected = requestedIds.length > 0 ? CASES.filter((item) => requestedIds.includes(item.id)) : CASES;
if (requestedIds.length > 0 && selected.length !== requestedIds.length) {
  const known = new Set(selected.map((item) => item.id));
  const unknown = requestedIds.filter((id) => !known.has(id));
  console.error(`unknown regression proof case: ${unknown.join(", ")}`);
  process.exit(2);
}

const tempRoots = [];
try {
  const baseline = await createCopy("pilotdeck-regression-baseline-");
  tempRoots.push(baseline.root);
  await build(baseline.root, baseline.home);
  for (const item of CASES) {
    if (item.suite === "ui") await buildUi(baseline.root, baseline.home);
    await runTarget(baseline.root, item, true, baseline.home);
  }
  console.log(`baseline: ${CASES.length} targeted tests passed`);

  for (const item of selected) {
    const copy = await createCopy(`pilotdeck-regression-${item.id}-`);
    tempRoots.push(copy.root);
    const sourcePath = join(copy.root, item.source);
    const before = await readFile(sourcePath, "utf8");
    const after = item.mutation(before);
    if (before === after) throw new Error(`${item.id}: mutation did not change the source`);
    await writeFile(sourcePath, after);
    await build(copy.root, copy.home);
    if (item.suite === "ui") await buildUi(copy.root, copy.home);
    const result = await runTarget(copy.root, item, false, copy.home);
    if (!result.failed) throw new Error(`${item.id}: target test still passed after mutation\n${result.output ?? ""}`);
    console.log(`MUTATION_FAIL ${item.id}`);
  }
} finally {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
}

function replaceOnce(source, needle, replacement) {
  const index = source.indexOf(needle);
  if (index < 0) throw new Error("mutation needle was not found");
  if (source.indexOf(needle, index + needle.length) >= 0) {
    throw new Error("mutation needle matched more than one source location");
  }
  return `${source.slice(0, index)}${replacement}${source.slice(index + needle.length)}`;
}

async function createCopy(prefix) {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const home = join(root, "pilot-home");
  await mkdir(home, { recursive: true });
  const output = await execFileAsync("git", ["ls-files", "-co", "--exclude-standard", "-z"], { cwd: ROOT, encoding: "buffer" });
  const files = output.stdout.toString("utf8").split("\0").filter(Boolean);
  for (const file of files) {
    const destination = join(root, file);
    await mkdir(dirname(destination), { recursive: true });
    await cp(join(ROOT, file), destination);
  }
  await symlink(join(ROOT, "node_modules"), join(root, "node_modules"), "dir");
  await symlink(join(ROOT, "ui", "node_modules"), join(root, "ui", "node_modules"), "dir");
  return { root, home };
}

async function build(root, home) {
  await execFileAsync("pnpm", ["run", "build"], {
    cwd: root,
    env: { ...process.env, PILOT_HOME: home },
    maxBuffer: 16 * 1024 * 1024,
  });
}

async function buildUi(root, home) {
  await execFileAsync("pnpm", ["run", "typecheck"], {
    cwd: join(root, "ui"),
    env: { ...process.env, PILOT_HOME: home },
    maxBuffer: 16 * 1024 * 1024,
  });
}

async function runTarget(root, item, expectPass, home) {
  const pattern = `^${item.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`;
  const command = item.suite === "ui"
    ? {
      file: "pnpm",
      args: ["exec", "vitest", "run", item.target, "-t", item.name],
      cwd: join(root, "ui"),
    }
    : {
      file: NODE,
      args: [
        "--test", "--test-force-exit", "--test-timeout", "10000",
        "--test-name-pattern", pattern,
        `dist/${item.target.replace(/\.(ts|tsx)$/, ".js")}`,
      ],
      cwd: root,
    };
  const result = await execFileAsync(command.file, command.args, {
    cwd: command.cwd,
    env: { ...process.env, PILOT_HOME: home },
    maxBuffer: 16 * 1024 * 1024,
  }).catch((error) => ({ stdout: error.stdout ?? "", stderr: error.stderr ?? "", status: error.code ?? 1 }));
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`;
  const failed = item.suite === "ui"
    ? (result.status ?? 0) !== 0 && /\bFAIL\b|AssertionError|expected/.test(output)
    : (result.status ?? 0) !== 0
      && (output.match(/^not ok /gm) ?? []).length === 1
      && output.includes(item.name)
      && /# fail 1\b/.test(output)
      && /# cancelled 0\b/.test(output);
  const passed = item.suite === "ui"
    ? (result.status ?? 0) === 0 && /\b(pass|passed)\b/i.test(output)
    : (result.status ?? 0) === 0 && /# pass 1\b/.test(output);
  if (expectPass && !passed) {
    throw new Error(`baseline target failed: ${item.id}\n${output}`);
  }
  return { failed, output };
}
