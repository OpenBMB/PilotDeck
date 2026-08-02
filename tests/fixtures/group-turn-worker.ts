import { ApiServerChannel } from "../../src/adapters/index.js";
import type { Gateway, GatewaySubmitTurnInput } from "../../src/gateway/index.js";
import { createGroupMemberDelegateTool, type PilotDeckToolRuntimeContext } from "../../src/tool/index.js";

const workerName = process.env.WORKER_NAME || "Worker";
const port = Number(process.env.API_SERVER_PORT || 0);
const workspacePath = process.env.WORKSPACE_PATH || process.cwd();
const apiKey = process.env.API_SERVER_KEY || "";
if (!port || !apiKey) throw new Error("API_SERVER_PORT and API_SERVER_KEY are required.");

function runtimeContext(input: GatewaySubmitTurnInput): PilotDeckToolRuntimeContext {
  return {
    sessionId: input.sessionKey,
    turnId: input.collaboration?.turnId || input.runId || "group-turn",
    cwd: input.workspaceCwd || workspacePath,
    env: process.env,
    permissionMode: "default",
    permissionContext: {
      mode: "default",
      cwd: input.workspaceCwd || workspacePath,
      additionalWorkingDirectories: [],
      canPrompt: false,
      bypassAvailable: false,
      rules: { allow: [], deny: [], ask: [] },
    },
    metadata: input.collaboration ? { collaboration: input.collaboration } : undefined,
  };
}

const gateway = {
  submitTurn: async function* (input: GatewaySubmitTurnInput) {
    const runId = input.runId || `${workerName}-run`;
    yield { type: "turn_started", runId } as const;
    yield { type: "assistant_thinking_delta", text: `${workerName} is processing the group turn.` } as const;
    const contextText = (input.syntheticMessages || []).map((message) => message.text).join("\n");
    const requiredMatch = /You must delegate to these member ids in order:\s*([^\n]+)/u.exec(contextText);
    const naturalMatch = /\[delegate:([a-zA-Z0-9._-]+)\]/u.exec(input.message);
    const delegateIds = [...new Set([
      ...(requiredMatch ? requiredMatch[1].split(/\s*->\s*/u)
        .map((value) => value.trim().replace(/[.,;:]+$/u, ""))
        .filter(Boolean) : []),
      ...(naturalMatch ? [naturalMatch[1]] : []),
    ])];
    if (delegateIds.length > 0 && input.collaboration?.canDelegate) {
      const summaries: string[] = [];
      for (const [index, memberId] of delegateIds.entries()) {
        const toolCallId = `${workerName}-delegate-${index}`;
        yield { type: "tool_call_started", toolCallId, name: "group_member_delegate", argsPreview: memberId } as const;
        const result = await createGroupMemberDelegateTool().execute({
          memberId,
          message: `${workerName} requests a direct review from ${memberId}.`,
        }, runtimeContext(input));
        yield {
          type: "tool_call_finished", toolCallId, name: "group_member_delegate", toolName: "group_member_delegate",
          ok: true, resultPreview: result.data?.reply || "delegated",
        } as const;
        summaries.push(`${result.data?.memberName}: ${result.data?.reply}`);
      }
      yield { type: "assistant_text_delta", text: `${workerName} summary after ${summaries.join(" | ")}` } as const;
    } else {
      yield { type: "assistant_text_delta", text: `${workerName} reply: ${input.message}` } as const;
    }
    yield { type: "turn_completed", usage: {}, finishReason: "completed" } as const;
  },
} as unknown as Gateway;

const channel = new ApiServerChannel({
  host: "127.0.0.1",
  port,
  apiKey,
  workspaceMappings: { shared: workspacePath },
});
const handle = await channel.start({
  gateway,
  logger: {
    info: (message: string) => process.stderr.write(`[${workerName}] ${message}\n`),
    warn: (message: string) => process.stderr.write(`[${workerName}] WARN ${message}\n`),
    error: (message: string) => process.stderr.write(`[${workerName}] ERROR ${message}\n`),
  },
} as never);

process.stdout.write(`READY ${workerName} ${port}\n`);
const stop = async () => {
  await handle.stop("signal");
  process.exit(0);
};
process.once("SIGTERM", () => void stop());
process.once("SIGINT", () => void stop());
await new Promise(() => undefined);
