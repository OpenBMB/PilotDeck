import React from "react";
import { render } from "ink-testing-library";
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { TuiApp } from "../src/adapters/channel/tui/app/TuiApp.js";
import { createGateway } from "../src/gateway/index.js";
import { createModelRuntime } from "../src/model/index.js";
import { createDefaultPermissionContext, PermissionRuntime } from "../src/permission/index.js";
import { loadPilotConfig } from "../src/pilot/index.js";
import { createRouterRuntime } from "../src/router/index.js";
import {
  SequentialToolScheduler,
  ToolRegistry,
  ToolRuntime,
  type PilotDeckToolDefinition,
} from "../src/tool/index.js";
import type { AgentRuntimeConfig } from "../src/agent/index.js";
import { createAgentSession } from "../src/agent/index.js";

const PROVIDER = process.env.PILOTDECK_E2E_PROVIDER ?? "edgeclaw";
const MODEL = process.env.PILOTDECK_E2E_MODEL ?? "moonshotai/kimi-k2.6";
const PROMPT = process.env.PILOTDECK_E2E_PROMPT ?? "Use add_numbers to compute 17 + 25, then tell me the result.";

const addNumbersTool: PilotDeckToolDefinition = {
  name: "add_numbers",
  description: "Add two numbers and return the result.",
  kind: "custom",
  inputSchema: {
    type: "object",
    required: ["a", "b"],
    additionalProperties: false,
    properties: {
      a: { type: "number" },
      b: { type: "number" },
    },
  },
  isReadOnly: () => true,
  isConcurrencySafe: () => true,
  execute: async (input) => {
    const { a, b } = input as { a: number; b: number };
    return { content: [{ type: "text", text: String(a + b) }], data: { sum: a + b } };
  },
};

async function main(): Promise<void> {
  const snapshot = loadPilotConfig();
  const provider = snapshot.config.model.providers[PROVIDER];
  if (!provider?.models[MODEL]) {
    throw new Error(`Provider ${PROVIDER} or model ${MODEL} is not configured.`);
  }

  const cwd = process.cwd();
  const registry = new ToolRegistry();
  registry.register(addNumbersTool);
  const permissionRuntime = new PermissionRuntime();
  const toolRuntime = new ToolRuntime(registry, permissionRuntime);
  const scheduler = new SequentialToolScheduler(toolRuntime);
  const modelRuntime = createModelRuntime(snapshot.config.model);

  const config: AgentRuntimeConfig = {
    provider: PROVIDER,
    model: MODEL,
    cwd,
    systemPrompt:
      "You are PilotDeck running an end-to-end TUI test. When asked for arithmetic, you MUST call the provided add_numbers tool exactly once instead of computing it yourself, then report the answer in plain text.",
    maxOutputTokens: 1024,
    temperature: 0,
    permissionMode: "default",
    permissionContext: createDefaultPermissionContext({
      cwd,
      mode: "default",
      canPrompt: false,
      bypassAvailable: true,
    }),
    metadata: { test: "tui-e2e-record" },
  };

  const router = createRouterRuntime(
    snapshot.config.router ?? {
      scenarios: {
        default: { id: `${PROVIDER}/${MODEL}`, provider: PROVIDER, model: MODEL },
      },
      zeroUsageRetry: { enabled: true, maxAttempts: 5 },
    },
    { modelRuntime },
  );

  const baseGateway = createGateway({
    session: {
      create: async ({ sessionKey }) =>
        createAgentSession({
          sessionId: sessionKey,
          config,
          dependencies: {
            router,
            tools: { registry, scheduler },
          },
        }),
    },
    serverInfo: { mode: "in_process", projectKey: cwd },
  });

  const gateway = process.env.PILOTDECK_E2E_TRACE === "1" ? wrapWithTrace(baseGateway) : baseGateway;

  const tree = (
    <TuiApp
      gateway={gateway}
      connection="in_process"
      projectKey={cwd}
      cwd={cwd}
      model={`${PROVIDER} · ${MODEL}`}
    />
  );

  const instance = render(tree);

  const writeFrame = (label: string) => {
    process.stdout.write(`\n--- ${label} (frame #${instance.frames.length}) ---\n`);
    process.stdout.write(`${instance.lastFrame() ?? ""}\n`);
  };

  await wait(120);
  writeFrame("cold start");

  for (const ch of PROMPT) {
    instance.stdin.write(ch);
    await wait(8);
  }
  await wait(120);
  writeFrame("after typing prompt");

  instance.stdin.write("\r");
  writeFrame("submit");

  const finalFrame = await waitForCompletedFrame(instance, 120_000);
  writeFrame("final");

  const logPath = resolve(process.cwd(), "artifacts/tui-e2e-frames.log");
  writeFileSync(logPath, instance.frames.map((frame, index) => `--- frame ${index} ---\n${frame}\n`).join("\n"));
  process.stdout.write(`\nSaved ${instance.frames.length} frames to ${logPath}\n`);

  instance.unmount();
  if (!finalFrame) {
    throw new Error("Timed out waiting for the assistant final frame.");
  }
}

function wrapWithTrace(gateway: ReturnType<typeof createGateway>): ReturnType<typeof createGateway> {
  return new Proxy(gateway, {
    get(target, prop, receiver) {
      const original = Reflect.get(target, prop, receiver);
      if (prop !== "submitTurn" || typeof original !== "function") {
        return original;
      }
      return (...args: Parameters<typeof gateway.submitTurn>) => {
        const startedAt = Date.now();
        let lastAt = startedAt;
        let textChars = 0;
        const iterable = original.apply(target, args) as AsyncIterable<unknown>;
        const ms = (now: number) => `${(now - startedAt).toString().padStart(5)} ms`;
        process.stdout.write(`\n[trace] submitTurn() called\n`);
        return (async function* () {
          for await (const event of iterable) {
            const now = Date.now();
            const delta = now - lastAt;
            lastAt = now;
            const ev = event as { type: string; text?: string; name?: string; toolCallId?: string };
            const type = ev.type;
            let detail = "";
            if (type === "assistant_text_delta") {
              textChars += ev.text?.length ?? 0;
              detail = ` text+=${ev.text?.length ?? 0} total=${textChars}`;
            } else if (type === "tool_call_started" || type === "tool_call_finished") {
              detail = ` ${ev.name ?? ev.toolCallId ?? ""}`;
            } else if (type === "error") {
              detail = ` "${(event as { message?: string }).message ?? ""}"`;
            }
            process.stdout.write(`[trace ${ms(now)} +${delta.toString().padStart(4)}ms] ${type}${detail}\n`);
            yield event;
          }
          const total = Date.now() - startedAt;
          process.stdout.write(`[trace] turn finished after ${total} ms (${textChars} assistant chars)\n`);
        })();
      };
    },
  });
}

function wait(ms: number): Promise<void> {
  return new Promise((resolveTimer) => setTimeout(resolveTimer, ms));
}

async function waitForFrame(
  instance: ReturnType<typeof render>,
  pattern: RegExp,
  timeoutMs: number,
): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frame = instance.lastFrame();
    if (frame && pattern.test(frame)) {
      return frame;
    }
    await wait(120);
  }
  return undefined;
}

async function waitForCompletedFrame(
  instance: ReturnType<typeof render>,
  timeoutMs: number,
): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const frame = instance.lastFrame() ?? "";
    const hasResult = /\b42\b/.test(frame);
    const stillThinking = /✦ thinking/.test(frame);
    if (hasResult && !stillThinking) {
      return frame;
    }
    await wait(150);
  }
  return undefined;
}

async function waitForStableFrame(
  instance: ReturnType<typeof render>,
  timeoutMs: number,
  stableMs = 600,
): Promise<string | undefined> {
  const deadline = Date.now() + timeoutMs;
  let last = instance.lastFrame();
  let lastChange = Date.now();
  while (Date.now() < deadline) {
    const current = instance.lastFrame();
    if (current !== last) {
      last = current;
      lastChange = Date.now();
    } else if (Date.now() - lastChange >= stableMs) {
      return current;
    }
    await wait(120);
  }
  return last;
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
