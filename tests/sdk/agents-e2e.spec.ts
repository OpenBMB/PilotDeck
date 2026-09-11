import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createLocalGateway } from "../../src/cli/createLocalGateway.js";
import {
  createBubblewrapSandboxProfile,
  createEmbeddedGatewayEndpoint,
  createGatewayAsyncTranscriptStorageAdapter,
  createGatewayUserDialogJournal,
  FileGatewayUserDialogStore,
  HttpGatewayUserDialogStore,
  startGatewayServer,
  startGatewayUserDialogStoreHttpServer,
  type GatewayStoredUserDialog,
  type GatewayStoredUserDialogResult,
  type GatewayUserDialogStore,
  type GatewayUserDialogStoreKey,
} from "../../src/gateway/index.js";
import {
  acceptsFormDialogAnswer,
  FORM_DIALOG_DRAFT_2020_12,
  validateFormDialogSchema,
} from "../../src/tool/dialog/FormDialogSchema.js";
import { PermissionRuntime } from "../../src/permission/index.js";
import {
  createEmbeddedSessionStore,
  createEmbeddedPilotDeckHost,
  createEmbeddedPilotDeckClient,
  createEmbeddedQuery,
  createEmbeddedToolRegistry,
  createManualUserDialogRenderer,
  createPilotDeckClient,
  createSdkMcpServer,
  query,
  tool,
} from "../../packages/sdk/src/index.js";
import { HostedHookServer } from "../../packages/sdk/src/hook-server.js";
import {
  createAgentProjectSessionStorage,
  readAgentProjectSessionTranscript,
} from "../../src/session/storage/ProjectSessionStorage.js";
import { ToolResultBudget } from "../../src/context/budget/ToolResultBudget.js";
import { forkWebSession } from "../../src/web/server/forkSession.js";
import { readSubagentWebMessages } from "../../src/web/server/readSessionMessages.js";
import { replaceLastWebSessionTurn } from "../../src/web/server/replaceLastTurn.js";
import type { AgentLoopRunResult } from "../../src/agent/loop/AgentLoop.js";
import type { AgentEvent } from "../../src/agent/protocol/events.js";
import type { ModelRuntime } from "../../src/model/ModelRuntime.js";
import type { ModelRuntimeOptions } from "../../src/model/streaming/streamModel.js";
import type {
  CanonicalModelEvent,
  CanonicalModelRequest,
  CanonicalModelResponse,
} from "../../src/model/protocol/canonical.js";
import { DEFAULT_MODEL_CAPABILITIES } from "../../src/model/protocol/capabilities.js";
import type { MultimodalConstraints } from "../../src/model/protocol/multimodal.js";

const TEST_CONFIG = `
schemaVersion: 1
agent:
  model: test/test
  maxContextTokens: 65536
  maxOutputTokens: 8192
model:
  providers:
    test:
      protocol: openai
      url: http://127.0.0.1:1
      apiKey: test-only
      models:
        test:
          capabilities:
            supportsToolUse: true
            maxContextTokens: 32768
            maxOutputTokens: 8192
        reviewer:
          capabilities:
            supportsToolUse: true
            maxContextTokens: 32768
            maxOutputTokens: 8192
`;

const COMPACTION_TEST_CONFIG = TEST_CONFIG
  .replace("maxContextTokens: 65536", "maxContextTokens: 20000")
  .replace("maxOutputTokens: 8192", "maxOutputTokens: 1000");

class TitleModel implements ModelRuntime {
  async *stream(_request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
    yield { type: "request_started", provider: "test", model: "test" };
    yield { type: "message_start", role: "assistant" };
    yield { type: "text_delta", text: '{"title":"SDK agent test"}' };
    yield { type: "message_end", finishReason: "stop" };
  }

  async complete(): Promise<CanonicalModelResponse> {
    return { role: "assistant", content: [{ type: "text", text: '{"title":"SDK agent test"}' }], finishReason: "stop" };
  }

  getCapabilities() { return DEFAULT_MODEL_CAPABILITIES; }
  getMultimodal(): MultimodalConstraints { return { input: ["text"] }; }
  getProviderProtocol() { return "openai" as const; }
  getProviderBaseUrl() { return undefined; }
}

class RestoredToolResultCacheModel implements ModelRuntime {
  private step = 0;

  constructor(private readonly filePath: string) {}

  async *stream(_request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
    yield { type: "request_started", provider: "test", model: "test" };
    yield { type: "message_start", role: "assistant" };
    if (this.step === 0) {
      this.step += 1;
      yield { type: "tool_call_start", id: "read-restored-tool-result", name: "read_file" };
      yield {
        type: "tool_call_end",
        toolCall: {
          id: "read-restored-tool-result",
          name: "read_file",
          input: { file_path: this.filePath, offset: 1, limit: 2 },
        },
      };
      yield { type: "message_end", finishReason: "tool_call" };
      return;
    }
    yield { type: "text_delta", text: "restored host payload was readable" };
    yield { type: "message_end", finishReason: "stop" };
  }

  async complete(): Promise<CanonicalModelResponse> {
    return { role: "assistant", content: [{ type: "text", text: "restored host payload was readable" }], finishReason: "stop" };
  }

  getCapabilities() { return DEFAULT_MODEL_CAPABILITIES; }
  getMultimodal(): MultimodalConstraints { return { input: ["text"] }; }
  getProviderProtocol() { return "openai" as const; }
  getProviderBaseUrl() { return undefined; }
}

class LifecycleHookModel implements ModelRuntime {
  constructor(private readonly lifecycleHooksObserved: Promise<void>) {}

  async *stream(_request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
    yield { type: "request_started", provider: "test", model: "test" };
    await waitForLifecycleHook(this.lifecycleHooksObserved);
    yield { type: "message_start", role: "assistant" };
    yield { type: "text_delta", text: "lifecycle callbacks observed" };
    yield { type: "message_end", finishReason: "stop" };
  }

  async complete(): Promise<CanonicalModelResponse> {
    return { role: "assistant", content: [{ type: "text", text: "lifecycle callbacks observed" }], finishReason: "stop" };
  }

  getCapabilities() { return DEFAULT_MODEL_CAPABILITIES; }
  getMultimodal(): MultimodalConstraints { return { input: ["text"] }; }
  getProviderProtocol() { return "openai" as const; }
  getProviderBaseUrl() { return undefined; }
}

class ConfigChangeHookModel implements ModelRuntime {
  constructor(private readonly configChangeObserved: Promise<void>) {}

  async *stream(_request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
    yield { type: "request_started", provider: "test", model: "test" };
    await waitForLifecycleHook(this.configChangeObserved);
    yield { type: "message_start", role: "assistant" };
    yield { type: "text_delta", text: "config change callback observed" };
    yield { type: "message_end", finishReason: "stop" };
  }

  async complete(): Promise<CanonicalModelResponse> {
    return { role: "assistant", content: [{ type: "text", text: "config change callback observed" }], finishReason: "stop" };
  }

  getCapabilities() { return DEFAULT_MODEL_CAPABILITIES; }
  getMultimodal(): MultimodalConstraints { return { input: ["text"] }; }
  getProviderProtocol() { return "openai" as const; }
  getProviderBaseUrl() { return undefined; }
}

class StopFailureHookModel implements ModelRuntime {
  async *stream(_request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
    yield { type: "request_started", provider: "test", model: "test" };
    yield {
      type: "error",
      error: {
        provider: "test",
        model: "test",
        protocol: "openai",
        code: "invalid_request_error",
        message: "The test provider rejected the request.",
        retryable: false,
      },
    };
  }

  async complete(): Promise<CanonicalModelResponse> {
    return { role: "assistant", content: [{ type: "text", text: "unreachable" }], finishReason: "error" };
  }

  getCapabilities() { return DEFAULT_MODEL_CAPABILITIES; }
  getMultimodal(): MultimodalConstraints { return { input: ["text"] }; }
  getProviderProtocol() { return "openai" as const; }
  getProviderBaseUrl() { return undefined; }
}

class PermissionLifecycleModel implements ModelRuntime {
  private step = 0;

  async *stream(_request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
    yield { type: "request_started", provider: "test", model: "test" };
    yield { type: "message_start", role: "assistant" };
    if (this.step === 0) {
      this.step += 1;
      yield { type: "tool_call_start", id: "permission-read", name: "read_file" };
      yield {
        type: "tool_call_end",
        toolCall: { id: "permission-read", name: "read_file", input: { file_path: "note.txt" } },
      };
      yield { type: "message_end", finishReason: "tool_call" };
      return;
    }
    if (this.step === 1) {
      this.step += 1;
      yield { type: "tool_call_start", id: "permission-write", name: "write_file" };
      yield {
        type: "tool_call_end",
        toolCall: {
          id: "permission-write",
          name: "write_file",
          input: { file_path: "note.txt", content: "must not be written\n" },
        },
      };
      yield { type: "message_end", finishReason: "tool_call" };
      return;
    }
    yield { type: "text_delta", text: "The write request was denied." };
    yield { type: "message_end", finishReason: "stop" };
  }

  async complete(): Promise<CanonicalModelResponse> {
    return { role: "assistant", content: [{ type: "text", text: "The write request was denied." }], finishReason: "stop" };
  }

  getCapabilities() { return DEFAULT_MODEL_CAPABILITIES; }
  getMultimodal(): MultimodalConstraints { return { input: ["text"] }; }
  getProviderProtocol() { return "openai" as const; }
  getProviderBaseUrl() { return undefined; }
}

class ToolLifecycleHookModel implements ModelRuntime {
  async *stream(request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
    const toolResult = request.messages
      .flatMap((message) => message.content)
      .find((block): block is Extract<typeof block, { type: "tool_result" }> => block.type === "tool_result");
    yield { type: "request_started", provider: "test", model: "test" };
    yield { type: "message_start", role: "assistant" };
    if (!toolResult) {
      yield { type: "tool_call_start", id: "tool-lifecycle-read", name: "read_file" };
      yield {
        type: "tool_call_end",
        toolCall: { id: "tool-lifecycle-read", name: "read_file", input: { file_path: "original.txt" } },
      };
      yield { type: "message_end", finishReason: "tool_call" };
      return;
    }
    const text = toolResult.content
      .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    yield { type: "text_delta", text };
    yield { type: "message_end", finishReason: "stop" };
  }

  async complete(): Promise<CanonicalModelResponse> {
    return { role: "assistant", content: [{ type: "text", text: "tool lifecycle test" }], finishReason: "stop" };
  }

  getCapabilities() { return DEFAULT_MODEL_CAPABILITIES; }
  getMultimodal(): MultimodalConstraints { return { input: ["text"] }; }
  getProviderProtocol() { return "openai" as const; }
  getProviderBaseUrl() { return undefined; }
}

class ToolFailureLifecycleHookModel implements ModelRuntime {
  async *stream(request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
    const hasToolResult = request.messages.some((message) =>
      message.content.some((block) => block.type === "tool_result"),
    );
    yield { type: "request_started", provider: "test", model: "test" };
    yield { type: "message_start", role: "assistant" };
    if (!hasToolResult) {
      yield { type: "tool_call_start", id: "tool-lifecycle-missing", name: "read_file" };
      yield {
        type: "tool_call_end",
        toolCall: { id: "tool-lifecycle-missing", name: "read_file", input: { file_path: "missing.txt" } },
      };
      yield { type: "message_end", finishReason: "tool_call" };
      return;
    }
    yield { type: "text_delta", text: "tool failure lifecycle observed" };
    yield { type: "message_end", finishReason: "stop" };
  }

  async complete(): Promise<CanonicalModelResponse> {
    return { role: "assistant", content: [{ type: "text", text: "tool failure lifecycle test" }], finishReason: "stop" };
  }

  getCapabilities() { return DEFAULT_MODEL_CAPABILITIES; }
  getMultimodal(): MultimodalConstraints { return { input: ["text"] }; }
  getProviderProtocol() { return "openai" as const; }
  getProviderBaseUrl() { return undefined; }
}

class ElicitationLifecycleHookModel implements ModelRuntime {
  async *stream(request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
    const toolResult = request.messages
      .flatMap((message) => message.content)
      .find((block): block is Extract<typeof block, { type: "tool_result" }> => block.type === "tool_result");
    yield { type: "request_started", provider: "test", model: "test" };
    yield { type: "message_start", role: "assistant" };
    if (!toolResult) {
      yield { type: "tool_call_start", id: "elicitation-lifecycle-call", name: "ask_user_question" };
      yield {
        type: "tool_call_end",
        toolCall: {
          id: "elicitation-lifecycle-call",
          name: "ask_user_question",
          input: {
            questions: [{
              question: "Which delivery mode?",
              header: "Mode",
              options: [
                { label: "Safe", description: "Use the conservative mode." },
                { label: "Fast", description: "Use the fast mode." },
              ],
            }],
          },
        },
      };
      yield { type: "message_end", finishReason: "tool_call" };
      return;
    }
    const text = toolResult.content
      .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    yield { type: "text_delta", text };
    yield { type: "message_end", finishReason: "stop" };
  }

  async complete(): Promise<CanonicalModelResponse> {
    return { role: "assistant", content: [{ type: "text", text: "elicitation lifecycle test" }], finishReason: "stop" };
  }

  getCapabilities() { return DEFAULT_MODEL_CAPABILITIES; }
  getMultimodal(): MultimodalConstraints { return { input: ["text"] }; }
  getProviderProtocol() { return "openai" as const; }
  getProviderBaseUrl() { return undefined; }
}

async function waitForLifecycleHook(observed: Promise<void>): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([
      observed,
      new Promise<never>((_resolve, reject) => {
        timeout = setTimeout(() => reject(new Error("The expected lifecycle hooks were not delivered to the SDK host.")), 2_000);
      }),
    ]);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

class PromptSuggestionModel implements ModelRuntime {
  readonly completeRequests: CanonicalModelRequest[] = [];

  async *stream(_request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
    yield { type: "request_started", provider: "test", model: "test" };
    yield { type: "message_start", role: "assistant" };
    yield { type: "text_delta", text: "The implementation is complete." };
    yield { type: "message_end", finishReason: "stop" };
  }

  async complete(request: CanonicalModelRequest): Promise<CanonicalModelResponse> {
    this.completeRequests.push(request);
    const text = request.metadata?.purpose === "prompt_suggestion_generation"
      ? "请运行相关测试并汇报结果"
      : '{"title":"Prompt suggestion test"}';
    return { role: "assistant", content: [{ type: "text", text }], finishReason: "stop" };
  }

  getCapabilities() { return DEFAULT_MODEL_CAPABILITIES; }
  getMultimodal(): MultimodalConstraints { return { input: ["text"] }; }
  getProviderProtocol() { return "openai" as const; }
  getProviderBaseUrl() { return undefined; }
}

class InputDialogModel implements ModelRuntime {
  readonly requests: CanonicalModelRequest[] = [];

  reset(): void {
    this.requests.length = 0;
  }

  async *stream(request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
    this.requests.push(request);
    const hasInputTool = request.tools?.some((tool) => tool.name === "request_user_input") === true;
    const hasToolResult = request.messages.some((message) =>
      message.content.some((block) => block.type === "tool_result"),
    );
    yield { type: "request_started", provider: "test", model: "test" };
    yield { type: "message_start", role: "assistant" };
    if (hasInputTool && !hasToolResult) {
      yield { type: "tool_call_start", id: "input-1", name: "request_user_input" };
      yield {
        type: "tool_call_end",
        toolCall: {
          id: "input-1",
          name: "request_user_input",
          input: {
            prompt: "Which test command should I run?",
            placeholder: "pnpm test",
          },
        },
      };
      yield { type: "message_end", finishReason: "tool_call" };
      return;
    }
    yield {
      type: "text_delta",
      text: hasInputTool ? "The input answer was consumed." : "The input dialog is unavailable.",
    };
    yield { type: "message_end", finishReason: "stop" };
  }

  async complete(): Promise<CanonicalModelResponse> {
    return { role: "assistant", content: [{ type: "text", text: "input dialog test" }], finishReason: "stop" };
  }

  getCapabilities() { return DEFAULT_MODEL_CAPABILITIES; }
  getMultimodal(): MultimodalConstraints { return { input: ["text"] }; }
  getProviderProtocol() { return "openai" as const; }
  getProviderBaseUrl() { return undefined; }
}

class SelectAndConfirmDialogModel implements ModelRuntime {
  readonly requests: CanonicalModelRequest[] = [];

  async *stream(request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
    this.requests.push(request);
    const hasSelectTool = request.tools?.some((tool) => tool.name === "request_user_choice") === true;
    const hasConfirmTool = request.tools?.some((tool) => tool.name === "request_user_confirmation") === true;
    const toolResults = request.messages.flatMap((message) => message.content)
      .filter((block): block is Extract<typeof block, { type: "tool_result" }> => block.type === "tool_result");
    const selectResult = toolResults.find((block) => block.toolCallId === "select-1");
    const confirmResult = toolResults.find((block) => block.toolCallId === "confirm-1");
    yield { type: "request_started", provider: "test", model: "test" };
    yield { type: "message_start", role: "assistant" };
    if (hasSelectTool && hasConfirmTool && !selectResult) {
      yield { type: "tool_call_start", id: "select-1", name: "request_user_choice" };
      yield {
        type: "tool_call_end",
        toolCall: {
          id: "select-1",
          name: "request_user_choice",
          input: {
            prompt: "Choose the test suite.",
            options: [
              { value: "unit", label: "Unit tests" },
              { value: "e2e", label: "End-to-end tests", description: "Runs the complete SDK suite" },
            ],
            defaultValue: "unit",
          },
        },
      };
      yield { type: "message_end", finishReason: "tool_call" };
      return;
    }
    if (hasSelectTool && hasConfirmTool && selectResult && !confirmResult) {
      yield { type: "tool_call_start", id: "confirm-1", name: "request_user_confirmation" };
      yield {
        type: "tool_call_end",
        toolCall: {
          id: "confirm-1",
          name: "request_user_confirmation",
          input: { prompt: "Run the selected suite?", confirmLabel: "Run", cancelLabel: "Skip", defaultValue: false },
        },
      };
      yield { type: "message_end", finishReason: "tool_call" };
      return;
    }
    yield {
      type: "text_delta",
      text: hasSelectTool && hasConfirmTool ? "The dialog answers were consumed." : "The dialogs are unavailable.",
    };
    yield { type: "message_end", finishReason: "stop" };
  }

  async complete(): Promise<CanonicalModelResponse> {
    return { role: "assistant", content: [{ type: "text", text: "select and confirm dialog test" }], finishReason: "stop" };
  }

  getCapabilities() { return DEFAULT_MODEL_CAPABILITIES; }
  getMultimodal(): MultimodalConstraints { return { input: ["text"] }; }
  getProviderProtocol() { return "openai" as const; }
  getProviderBaseUrl() { return undefined; }
}

class FormDialogModel implements ModelRuntime {
  readonly requests: CanonicalModelRequest[] = [];

  reset(): void {
    this.requests.length = 0;
  }

  async *stream(request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
    this.requests.push(request);
    const hasFormTool = request.tools?.some((tool) => tool.name === "request_user_form") === true;
    const hasFormResult = request.messages.flatMap((message) => message.content)
      .some((block) => block.type === "tool_result" && block.toolCallId === "form-1");
    yield { type: "request_started", provider: "test", model: "test" };
    yield { type: "message_start", role: "assistant" };
    if (hasFormTool && !hasFormResult) {
      yield { type: "tool_call_start", id: "form-1", name: "request_user_form" };
      yield {
        type: "tool_call_end",
        toolCall: {
          id: "form-1",
          name: "request_user_form",
          input: {
            prompt: "Configure the SDK test run.",
            schema: {
              type: "object",
              $defs: {
                emailAddress: { type: "string", format: "email" },
                deliveryTarget: {
                  oneOf: [
                    { $ref: "#/$defs/emailAddress" },
                    { type: "string", format: "uri" },
                  ],
                },
              },
              properties: {
                suite: { type: "string", enum: ["unit", "e2e"] },
                contact: { $ref: "#/$defs/emailAddress" },
                delivery: { $ref: "#/$defs/deliveryTarget" },
                retries: { type: "integer", minimum: 0, maximum: 5 },
                tag: { type: "string", minLength: 3, maxLength: 12, pattern: "^[a-z]+$" },
                targets: {
                  type: "array",
                  minItems: 1,
                  maxItems: 2,
                  uniqueItems: true,
                  items: { type: "string", minLength: 1 },
                },
                labels: {
                  type: "object",
                  minProperties: 1,
                  additionalProperties: { type: "string", minLength: 1 },
                },
                deliveryMode: { type: "string", enum: ["direct", "guided"] },
                ticket: { type: "string", pattern: "^PD-[0-9]+$" },
                reviewer: { type: "string", minLength: 1 },
                approved: { type: "boolean" },
              },
              required: ["suite", "contact", "delivery", "deliveryMode"],
              additionalProperties: false,
              if: {
                properties: { deliveryMode: { const: "direct" } },
                required: ["deliveryMode"],
              },
              then: {
                properties: { ticket: { type: "string", pattern: "^PD-[0-9]+$" } },
                required: ["ticket"],
              },
              dependentRequired: { reviewer: ["approved"] },
              dependentSchemas: {
                reviewer: {
                  properties: { approved: { const: true } },
                  required: ["approved"],
                },
              },
            },
          },
        },
      };
      yield { type: "message_end", finishReason: "tool_call" };
      return;
    }
    yield { type: "text_delta", text: hasFormTool ? "The form response was consumed." : "The form dialog is unavailable." };
    yield { type: "message_end", finishReason: "stop" };
  }

  async complete(): Promise<CanonicalModelResponse> {
    return { role: "assistant", content: [{ type: "text", text: "form dialog test" }], finishReason: "stop" };
  }

  getCapabilities() { return DEFAULT_MODEL_CAPABILITIES; }
  getMultimodal(): MultimodalConstraints { return { input: ["text"] }; }
  getProviderProtocol() { return "openai" as const; }
  getProviderBaseUrl() { return undefined; }
}

class Draft202012FormDialogModel implements ModelRuntime {
  readonly requests: CanonicalModelRequest[] = [];

  async *stream(request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
    this.requests.push(request);
    const hasFormTool = request.tools?.some((tool) => tool.name === "request_user_form") === true;
    const hasFormResult = request.messages.flatMap((message) => message.content)
      .some((block) => block.type === "tool_result" && block.toolCallId === "draft-form-1");
    yield { type: "request_started", provider: "test", model: "test" };
    yield { type: "message_start", role: "assistant" };
    if (hasFormTool && !hasFormResult) {
      yield { type: "tool_call_start", id: "draft-form-1", name: "request_user_form" };
      yield {
        type: "tool_call_end",
        toolCall: {
          id: "draft-form-1",
          name: "request_user_form",
          input: {
            prompt: "Provide the release retry count.",
            schema: {
              $schema: FORM_DIALOG_DRAFT_2020_12,
              type: "object",
              $defs: {
                positiveInteger: { type: "integer", minimum: 1 },
              },
              properties: {
                retries: { $ref: "#/$defs/positiveInteger" },
              },
              required: ["retries"],
              unevaluatedProperties: false,
            },
          },
        },
      };
      yield { type: "message_end", finishReason: "tool_call" };
      return;
    }
    yield { type: "text_delta", text: hasFormTool ? "The Draft 2020-12 form was consumed." : "The form dialog is unavailable." };
    yield { type: "message_end", finishReason: "stop" };
  }

  async complete(): Promise<CanonicalModelResponse> {
    return { role: "assistant", content: [{ type: "text", text: "draft form dialog test" }], finishReason: "stop" };
  }

  getCapabilities() { return DEFAULT_MODEL_CAPABILITIES; }
  getMultimodal(): MultimodalConstraints { return { input: ["text"] }; }
  getProviderProtocol() { return "openai" as const; }
  getProviderBaseUrl() { return undefined; }
}

class EmbeddedRegistryModel implements ModelRuntime {
  readonly requests: CanonicalModelRequest[] = [];

  async *stream(request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
    this.requests.push(request);
    const hasEmbeddedTool = request.tools?.some((tool) => tool.name === "embedded_echo") === true;
    const hasToolResult = request.messages.some((message) =>
      message.content.some((block) => block.type === "tool_result"),
    );
    yield { type: "request_started", provider: "test", model: "test" };
    yield { type: "message_start", role: "assistant" };
    if (hasEmbeddedTool && !hasToolResult) {
      yield { type: "tool_call_start", id: "embedded-call", name: "embedded_echo" };
      yield {
        type: "tool_call_end",
        toolCall: { id: "embedded-call", name: "embedded_echo", input: { value: "local value" } },
      };
      yield { type: "message_end", finishReason: "tool_call" };
      return;
    }
    yield { type: "text_delta", text: hasEmbeddedTool ? "embedded tool completed" : "embedded tool unavailable" };
    yield { type: "message_end", finishReason: "stop" };
  }

  async complete(): Promise<CanonicalModelResponse> {
    return { role: "assistant", content: [{ type: "text", text: "embedded registry test" }], finishReason: "stop" };
  }

  getCapabilities() { return DEFAULT_MODEL_CAPABILITIES; }
  getMultimodal(): MultimodalConstraints { return { input: ["text"] }; }
  getProviderProtocol() { return "openai" as const; }
  getProviderBaseUrl() { return undefined; }
}

class PreContentFallbackModel implements ModelRuntime {
  readonly attempts: string[] = [];

  async *stream(request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
    this.attempts.push(`${request.provider}/${request.model}`);
    if (request.model === "test") {
      yield {
        type: "error",
        error: {
          provider: "test",
          model: "test",
          protocol: "openai",
          code: "rate_limit_error",
          message: "primary unavailable",
          retryable: true,
        },
      };
      return;
    }
    yield { type: "request_started", provider: request.provider, model: request.model };
    yield { type: "message_start", role: "assistant" };
    yield { type: "text_delta", text: "fallback model response" };
    yield { type: "message_end", finishReason: "stop" };
  }

  async complete(): Promise<CanonicalModelResponse> {
    return { role: "assistant", content: [{ type: "text", text: "fallback model response" }], finishReason: "stop" };
  }

  getCapabilities() { return DEFAULT_MODEL_CAPABILITIES; }
  getMultimodal(): MultimodalConstraints { return { input: ["text"] }; }
  getProviderProtocol() { return "openai" as const; }
  getProviderBaseUrl() { return undefined; }
}

class BashProgressModel implements ModelRuntime {
  private shouldCallTool = true;
  readonly requests: CanonicalModelRequest[] = [];

  reset(): void {
    this.shouldCallTool = true;
    this.requests.length = 0;
  }

  async *stream(request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
    this.requests.push(request);
    yield { type: "request_started", provider: "test", model: "test" };
    yield { type: "message_start", role: "assistant" };
    if (this.shouldCallTool) {
      this.shouldCallTool = false;
      yield { type: "tool_call_start", id: "bash-progress", name: "bash" };
      yield {
        type: "tool_call_end",
        toolCall: {
          id: "bash-progress",
          name: "bash",
          input: { command: "printf progress" },
        },
      };
      yield { type: "message_end", finishReason: "tool_call" };
      return;
    }
    yield { type: "text_delta", text: "bash completed" };
    yield { type: "message_end", finishReason: "stop" };
  }

  async complete(): Promise<CanonicalModelResponse> {
    return { role: "assistant", content: [{ type: "text", text: "bash completed" }], finishReason: "stop" };
  }

  getCapabilities() { return DEFAULT_MODEL_CAPABILITIES; }
  getMultimodal(): MultimodalConstraints { return { input: ["text"] }; }
  getProviderProtocol() { return "openai" as const; }
  getProviderBaseUrl() { return undefined; }
}

class ExecuteCodeSandboxModel implements ModelRuntime {
  private shouldCallTool = true;
  readonly requests: CanonicalModelRequest[] = [];

  reset(): void {
    this.shouldCallTool = true;
    this.requests.length = 0;
  }

  async *stream(request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
    this.requests.push(request);
    yield { type: "request_started", provider: "test", model: "test" };
    yield { type: "message_start", role: "assistant" };
    if (this.shouldCallTool) {
      this.shouldCallTool = false;
      yield { type: "tool_call_start", id: "sandbox-execute-code", name: "execute_code" };
      yield {
        type: "tool_call_end",
        toolCall: {
          id: "sandbox-execute-code",
          name: "execute_code",
          input: { code: "print('inside profile')" },
        },
      };
      yield { type: "message_end", finishReason: "tool_call" };
      return;
    }
    yield { type: "text_delta", text: "sandboxed execute_code completed" };
    yield { type: "message_end", finishReason: "stop" };
  }

  async complete(): Promise<CanonicalModelResponse> {
    return { role: "assistant", content: [{ type: "text", text: "sandboxed execute_code completed" }], finishReason: "stop" };
  }

  getCapabilities() { return DEFAULT_MODEL_CAPABILITIES; }
  getMultimodal(): MultimodalConstraints { return { input: ["text"] }; }
  getProviderProtocol() { return "openai" as const; }
  getProviderBaseUrl() { return undefined; }
}

class CheckpointWriteModel implements ModelRuntime {
  private step = 0;

  async *stream(_request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
    yield { type: "request_started", provider: "test", model: "test" };
    yield { type: "message_start", role: "assistant" };
    if (this.step === 0) {
      this.step += 1;
      yield { type: "tool_call_start", id: "checkpoint-read", name: "read_file" };
      yield {
        type: "tool_call_end",
        toolCall: { id: "checkpoint-read", name: "read_file", input: { file_path: "note.txt" } },
      };
      yield { type: "message_end", finishReason: "tool_call" };
      return;
    }
    if (this.step === 1) {
      this.step += 1;
      yield { type: "tool_call_start", id: "checkpoint-write", name: "write_file" };
      yield {
        type: "tool_call_end",
        toolCall: {
          id: "checkpoint-write",
          name: "write_file",
          input: { file_path: "note.txt", content: "after\n" },
        },
      };
      yield { type: "message_end", finishReason: "tool_call" };
      return;
    }
    yield { type: "text_delta", text: "checkpoint written" };
    yield { type: "message_end", finishReason: "stop" };
  }

  async complete(): Promise<CanonicalModelResponse> {
    return { role: "assistant", content: [{ type: "text", text: "checkpoint written" }], finishReason: "stop" };
  }

  getCapabilities() { return DEFAULT_MODEL_CAPABILITIES; }
  getMultimodal(): MultimodalConstraints { return { input: ["text"] }; }
  getProviderProtocol() { return "openai" as const; }
  getProviderBaseUrl() { return undefined; }
}

class PromptCaptureModel implements ModelRuntime {
  readonly requests: CanonicalModelRequest[] = [];

  async *stream(request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
    this.requests.push(request);
    yield { type: "request_started", provider: "test", model: "test" };
    yield { type: "message_start", role: "assistant" };
    yield { type: "text_delta", text: "style response" };
    yield { type: "message_end", finishReason: "stop" };
  }

  async complete(): Promise<CanonicalModelResponse> {
    return { role: "assistant", content: [{ type: "text", text: "style response" }], finishReason: "stop" };
  }

  getCapabilities() { return DEFAULT_MODEL_CAPABILITIES; }
  getMultimodal(): MultimodalConstraints { return { input: ["text"] }; }
  getProviderProtocol() { return "openai" as const; }
  getProviderBaseUrl() { return undefined; }
}

class AsyncHookContextModel implements ModelRuntime {
  readonly requests: CanonicalModelRequest[] = [];
  private releaseFirstRequest?: () => void;
  private readonly firstRequestGate = new Promise<void>((resolve) => {
    this.releaseFirstRequest = resolve;
  });

  release(): void {
    this.releaseFirstRequest?.();
  }

  async *stream(request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
    this.requests.push(request);
    yield { type: "request_started", provider: "test", model: "test" };
    yield { type: "message_start", role: "assistant" };
    if (this.requests.length === 1) {
      await this.firstRequestGate;
      yield { type: "tool_call_start", id: "async-hook-read", name: "read_file" };
      yield {
        type: "tool_call_end",
        toolCall: { id: "async-hook-read", name: "read_file", input: { file_path: "note.txt" } },
      };
      yield { type: "message_end", finishReason: "tool_call" };
      return;
    }
    yield { type: "text_delta", text: "async hook context consumed" };
    yield { type: "message_end", finishReason: "stop" };
  }

  async complete(): Promise<CanonicalModelResponse> {
    return { role: "assistant", content: [{ type: "text", text: "async hook context consumed" }], finishReason: "stop" };
  }

  getCapabilities() { return DEFAULT_MODEL_CAPABILITIES; }
  getMultimodal(): MultimodalConstraints { return { input: ["text"] }; }
  getProviderProtocol() { return "openai" as const; }
  getProviderBaseUrl() { return undefined; }
}

class AsyncFileChangedHookModel implements ModelRuntime {
  readonly requests: CanonicalModelRequest[] = [];
  private releaseFinalRequest?: () => void;
  private readonly finalRequestGate = new Promise<void>((resolve) => {
    this.releaseFinalRequest = resolve;
  });

  release(): void {
    this.releaseFinalRequest?.();
  }

  async *stream(request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
    this.requests.push(request);
    yield { type: "request_started", provider: "test", model: "test" };
    yield { type: "message_start", role: "assistant" };
    if (this.requests.length === 1) {
      yield { type: "tool_call_start", id: "async-file-hook-read", name: "read_file" };
      yield {
        type: "tool_call_end",
        toolCall: { id: "async-file-hook-read", name: "read_file", input: { file_path: "note.txt" } },
      };
      yield { type: "message_end", finishReason: "tool_call" };
      return;
    }
    if (this.requests.length === 2) {
      yield { type: "tool_call_start", id: "async-file-hook-write", name: "write_file" };
      yield {
        type: "tool_call_end",
        toolCall: {
          id: "async-file-hook-write",
          name: "write_file",
          input: { file_path: "note.txt", content: "after async hook\n" },
        },
      };
      yield { type: "message_end", finishReason: "tool_call" };
      return;
    }
    if (this.requests.length === 3) {
      await this.finalRequestGate;
      yield { type: "tool_call_start", id: "async-file-hook-confirm", name: "read_file" };
      yield {
        type: "tool_call_end",
        toolCall: { id: "async-file-hook-confirm", name: "read_file", input: { file_path: "note.txt" } },
      };
      yield { type: "message_end", finishReason: "tool_call" };
      return;
    }
    yield { type: "text_delta", text: "async file hook context consumed" };
    yield { type: "message_end", finishReason: "stop" };
  }

  async complete(): Promise<CanonicalModelResponse> {
    return { role: "assistant", content: [{ type: "text", text: "async file hook context consumed" }], finishReason: "stop" };
  }

  getCapabilities() { return DEFAULT_MODEL_CAPABILITIES; }
  getMultimodal(): MultimodalConstraints { return { input: ["text"] }; }
  getProviderProtocol() { return "openai" as const; }
  getProviderBaseUrl() { return undefined; }
}

class SkillScopeModel implements ModelRuntime {
  readonly requests: CanonicalModelRequest[] = [];

  constructor(private skillName: string) {}

  reset(skillName: string): void {
    this.skillName = skillName;
    this.requests.length = 0;
  }

  async *stream(request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
    this.requests.push(request);
    const toolResult = request.messages
      .flatMap((message) => message.content)
      .find((block): block is Extract<typeof block, { type: "tool_result" }> => block.type === "tool_result");
    if (!toolResult) {
      yield { type: "request_started", provider: "test", model: "test" };
      yield { type: "message_start", role: "assistant" };
      yield { type: "tool_call_start", id: "read-skill", name: "read_skill" };
      yield {
        type: "tool_call_end",
        toolCall: { id: "read-skill", name: "read_skill", input: { skillName: this.skillName } },
      };
      yield { type: "message_end", finishReason: "tool_call" };
      return;
    }
    const text = toolResult.content
      .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    yield { type: "request_started", provider: "test", model: "test" };
    yield { type: "message_start", role: "assistant" };
    yield { type: "text_delta", text };
    yield { type: "message_end", finishReason: "stop" };
  }

  async complete(): Promise<CanonicalModelResponse> {
    return { role: "assistant", content: [{ type: "text", text: "SDK skill test" }], finishReason: "stop" };
  }

  getCapabilities() { return DEFAULT_MODEL_CAPABILITIES; }
  getMultimodal(): MultimodalConstraints { return { input: ["text"] }; }
  getProviderProtocol() { return "openai" as const; }
  getProviderBaseUrl() { return undefined; }
}

class AgentDefinitionScopeModel implements ModelRuntime {
  readonly childRequests: CanonicalModelRequest[] = [];

  async *stream(request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
    const isChild = request.systemPrompt?.includes("SDK AGENT SCOPE MARKER") === true;
    const hasToolResult = request.messages.some((message) =>
      message.content.some((block) => block.type === "tool_result"),
    );
    yield { type: "request_started", provider: "test", model: "test" };
    yield { type: "message_start", role: "assistant" };
    if (isChild) {
      this.childRequests.push(request);
      if (this.childRequests.length === 1) {
        yield { type: "tool_call_start", id: "agent-scope-ping", name: "mcp__agent_tools__ping" };
        yield {
          type: "tool_call_end",
          toolCall: { id: "agent-scope-ping", name: "mcp__agent_tools__ping", input: {} },
        };
        yield { type: "message_end", finishReason: "tool_call" };
        return;
      }
      if (this.childRequests.length === 2) {
        yield { type: "tool_call_start", id: "agent-scope-hidden-skill", name: "read_skill" };
        yield {
          type: "tool_call_end",
          toolCall: { id: "agent-scope-hidden-skill", name: "read_skill", input: { skillName: "deploy" } },
        };
        yield { type: "message_end", finishReason: "tool_call" };
        return;
      }
      yield {
        type: "text_delta",
        text: "Scope: child\nResult: MCP completed\nKey files: none\nFiles changed: none\nIssues: none",
      };
      yield { type: "message_end", finishReason: "stop" };
      return;
    }
    if (!hasToolResult) {
      yield { type: "tool_call_start", id: "launch-agent-scope", name: "agent" };
      yield {
        type: "tool_call_end",
        toolCall: {
          id: "launch-agent-scope",
          name: "agent",
          input: {
            description: "Inspect scoped tools",
            prompt: "Use the assigned MCP tool and return the required report.",
            subagent_type: "reviewer",
          },
        },
      };
      yield { type: "message_end", finishReason: "tool_call" };
      return;
    }
    yield { type: "text_delta", text: "parent complete" };
    yield { type: "message_end", finishReason: "stop" };
  }

  async complete(): Promise<CanonicalModelResponse> {
    return { role: "assistant", content: [{ type: "text", text: "parent complete" }], finishReason: "stop" };
  }

  getCapabilities() { return DEFAULT_MODEL_CAPABILITIES; }
  getMultimodal(): MultimodalConstraints { return { input: ["text"] }; }
  getProviderProtocol() { return "openai" as const; }
  getProviderBaseUrl() { return undefined; }
}

class ForwardSubagentTextModel implements ModelRuntime {
  async *stream(request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
    const isChild = request.systemPrompt?.includes("SDK FORWARD SUBAGENT TEXT MARKER") === true;
    const hasToolResult = request.messages.some((message) =>
      message.content.some((block) => block.type === "tool_result"),
    );
    yield { type: "request_started", provider: "test", model: "test" };
    yield { type: "message_start", role: "assistant" };
    if (isChild) {
      yield { type: "text_delta", text: "child streamed result" };
      yield { type: "message_end", finishReason: "stop" };
      return;
    }
    if (!hasToolResult) {
      yield { type: "tool_call_start", id: "forward-child", name: "agent" };
      yield {
        type: "tool_call_end",
        toolCall: {
          id: "forward-child",
          name: "agent",
          input: {
            description: "Return a short child report",
            prompt: "SDK FORWARD SUBAGENT TEXT MARKER",
            subagent_type: "reviewer",
          },
        },
      };
      yield { type: "message_end", finishReason: "tool_call" };
      return;
    }
    yield { type: "text_delta", text: "parent final result" };
    yield { type: "message_end", finishReason: "stop" };
  }

  async complete(): Promise<CanonicalModelResponse> {
    return { role: "assistant", content: [{ type: "text", text: "parent final result" }], finishReason: "stop" };
  }

  getCapabilities() { return DEFAULT_MODEL_CAPABILITIES; }
  getMultimodal(): MultimodalConstraints { return { input: ["text"] }; }
  getProviderProtocol() { return "openai" as const; }
  getProviderBaseUrl() { return undefined; }
}

class AgentDepthCapModel implements ModelRuntime {
  readonly requests: CanonicalModelRequest[] = [];

  async *stream(request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
    this.requests.push(request);
    const hasToolResult = request.messages.some((message) =>
      message.content.some((block) => block.type === "tool_result"),
    );
    yield { type: "request_started", provider: "test", model: "test" };
    yield { type: "message_start", role: "assistant" };
    if (!hasToolResult) {
      yield { type: "tool_call_start", id: "depth-capped-agent", name: "agent" };
      yield {
        type: "tool_call_end",
        toolCall: {
          id: "depth-capped-agent",
          name: "agent",
          input: {
            description: "Inspect without nested execution",
            prompt: "Report the workspace state.",
            subagent_type: "reviewer",
          },
        },
      };
      yield { type: "message_end", finishReason: "tool_call" };
      return;
    }
    yield { type: "text_delta", text: "fork was rejected by host policy" };
    yield { type: "message_end", finishReason: "stop" };
  }

  async complete(): Promise<CanonicalModelResponse> {
    return { role: "assistant", content: [{ type: "text", text: "fork was rejected by host policy" }], finishReason: "stop" };
  }

  getCapabilities() { return DEFAULT_MODEL_CAPABILITIES; }
  getMultimodal(): MultimodalConstraints { return { input: ["text"] }; }
  getProviderProtocol() { return "openai" as const; }
  getProviderBaseUrl() { return undefined; }
}

class BackgroundAgentDefinitionModel implements ModelRuntime {
  private resolveChildStarted!: () => void;
  private resolveChildAborted!: () => void;
  readonly childStarted = new Promise<void>((resolve) => {
    this.resolveChildStarted = resolve;
  });
  readonly childAborted = new Promise<void>((resolve) => {
    this.resolveChildAborted = resolve;
  });

  async *stream(request: CanonicalModelRequest, options?: ModelRuntimeOptions): AsyncIterable<CanonicalModelEvent> {
    const isChild = request.systemPrompt?.includes("BACKGROUND SDK MARKER") === true;
    const hasToolResult = request.messages.some((message) =>
      message.content.some((block) => block.type === "tool_result"),
    );
    yield { type: "request_started", provider: "test", model: "test" };
    yield { type: "message_start", role: "assistant" };
    if (isChild) {
      this.resolveChildStarted();
      await new Promise<void>((resolve) => {
        if (options?.signal?.aborted || !options?.signal) {
          resolve();
          return;
        }
        options.signal.addEventListener("abort", () => resolve(), { once: true });
      });
      this.resolveChildAborted();
      return;
    }
    if (!hasToolResult) {
      yield { type: "tool_call_start", id: "launch-background-agent", name: "agent" };
      yield {
        type: "tool_call_end",
        toolCall: {
          id: "launch-background-agent",
          name: "agent",
          input: {
            description: "Review asynchronously",
            prompt: "BACKGROUND SDK MARKER",
            subagent_type: "reviewer",
          },
        },
      };
      yield { type: "message_end", finishReason: "tool_call" };
      return;
    }
    yield { type: "text_delta", text: "parent completed without waiting" };
    yield { type: "message_end", finishReason: "stop" };
  }

  async complete(): Promise<CanonicalModelResponse> {
    return { role: "assistant", content: [{ type: "text", text: "background test" }], finishReason: "stop" };
  }

  getCapabilities() { return DEFAULT_MODEL_CAPABILITIES; }
  getMultimodal(): MultimodalConstraints { return { input: ["text"] }; }
  getProviderProtocol() { return "openai" as const; }
  getProviderBaseUrl() { return undefined; }
}

class ObserverAgentDefinitionModel implements ModelRuntime {
  readonly observerRequests: CanonicalModelRequest[] = [];
  readonly parentRequests: CanonicalModelRequest[] = [];
  private resolveObserverStarted!: () => void;
  private resolveObserverDone!: () => void;
  private releaseObserver!: () => void;
  readonly observerStarted = new Promise<void>((resolve) => {
    this.resolveObserverStarted = resolve;
  });
  readonly observerDone = new Promise<void>((resolve) => {
    this.resolveObserverDone = resolve;
  });
  private readonly observerGate = new Promise<void>((resolve) => {
    this.releaseObserver = resolve;
  });

  release(): void {
    this.releaseObserver();
  }

  async *stream(request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
    const systemPrompt = request.systemPrompt ?? "";
    const isObserver = systemPrompt.includes("OBSERVER AGENT MARKER");
    const isObservedChild = systemPrompt.includes("OBSERVED AGENT MARKER");
    const hasToolResult = request.messages.some((message) =>
      message.content.some((block) => block.type === "tool_result"),
    );
    yield { type: "request_started", provider: "test", model: "test" };
    yield { type: "message_start", role: "assistant" };
    if (isObserver) {
      this.observerRequests.push(request);
      this.resolveObserverStarted();
      await this.observerGate;
      yield {
        type: "text_delta",
        text: "Scope: observer\nResult: found no blocking issue\nKey files: none\nFiles changed: none\nIssues: none",
      };
      yield { type: "message_end", finishReason: "stop" };
      this.resolveObserverDone();
      return;
    }
    if (isObservedChild) {
      yield {
        type: "text_delta",
        text: "Scope: review\nResult: observed child finished\nKey files: none\nFiles changed: none\nIssues: none",
      };
      yield { type: "message_end", finishReason: "stop" };
      return;
    }
    this.parentRequests.push(request);
    if (!hasToolResult) {
      yield { type: "tool_call_start", id: "launch-observed-agent", name: "agent" };
      yield {
        type: "tool_call_end",
        toolCall: {
          id: "launch-observed-agent",
          name: "agent",
          input: {
            description: "Review with an independent observer",
            prompt: "Inspect the implementation and report the result.",
            subagent_type: "reviewer",
          },
        },
      };
      yield { type: "message_end", finishReason: "tool_call" };
      return;
    }
    yield { type: "text_delta", text: "parent did not receive observer report" };
    yield { type: "message_end", finishReason: "stop" };
  }

  async complete(): Promise<CanonicalModelResponse> {
    return { role: "assistant", content: [{ type: "text", text: "observer test" }], finishReason: "stop" };
  }

  getCapabilities() { return DEFAULT_MODEL_CAPABILITIES; }
  getMultimodal(): MultimodalConstraints { return { input: ["text"] }; }
  getProviderProtocol() { return "openai" as const; }
  getProviderBaseUrl() { return undefined; }
}

class SessionPluginMcpModel implements ModelRuntime {
  readonly requests: CanonicalModelRequest[] = [];

  reset(): void {
    this.requests.length = 0;
  }

  async *stream(request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
    this.requests.push(request);
    const hasToolResult = request.messages.some((message) =>
      message.content.some((block) => block.type === "tool_result"),
    );
    yield { type: "request_started", provider: "test", model: "test" };
    yield { type: "message_start", role: "assistant" };
    if (!hasToolResult) {
      yield { type: "tool_call_start", id: "plugin-mcp-ping", name: "mcp__session_plugin_tools__ping" };
      yield {
        type: "tool_call_end",
        toolCall: { id: "plugin-mcp-ping", name: "mcp__session_plugin_tools__ping", input: {} },
      };
      yield { type: "message_end", finishReason: "tool_call" };
      return;
    }
    yield { type: "text_delta", text: "plugin MCP complete" };
    yield { type: "message_end", finishReason: "stop" };
  }

  async complete(): Promise<CanonicalModelResponse> {
    return { role: "assistant", content: [{ type: "text", text: "plugin MCP complete" }], finishReason: "stop" };
  }

  getCapabilities() { return DEFAULT_MODEL_CAPABILITIES; }
  getMultimodal(): MultimodalConstraints { return { input: ["text"] }; }
  getProviderProtocol() { return "openai" as const; }
  getProviderBaseUrl() { return undefined; }
}

class DeferredMcpToolModel implements ModelRuntime {
  readonly requests: CanonicalModelRequest[] = [];

  async *stream(request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
    this.requests.push(request);
    yield { type: "request_started", provider: "test", model: "test" };
    yield { type: "message_start", role: "assistant" };
    if (this.requests.length === 1) {
      yield { type: "tool_call_start", id: "search-deferred-tools", name: "search_tools" };
      yield {
        type: "tool_call_end",
        toolCall: { id: "search-deferred-tools", name: "search_tools", input: { query: "diagnostic ping" } },
      };
      yield { type: "message_end", finishReason: "tool_call" };
      return;
    }
    if (this.requests.length === 2) {
      yield { type: "tool_call_start", id: "call-deferred-ping", name: "mcp__deferred_tools__ping" };
      yield {
        type: "tool_call_end",
        toolCall: { id: "call-deferred-ping", name: "mcp__deferred_tools__ping", input: {} },
      };
      yield { type: "message_end", finishReason: "tool_call" };
      return;
    }
    yield { type: "text_delta", text: "deferred MCP tool completed" };
    yield { type: "message_end", finishReason: "stop" };
  }

  async complete(): Promise<CanonicalModelResponse> {
    return { role: "assistant", content: [{ type: "text", text: "deferred MCP tool completed" }], finishReason: "stop" };
  }

  getCapabilities() { return DEFAULT_MODEL_CAPABILITIES; }
  getMultimodal(): MultimodalConstraints { return { input: ["text"] }; }
  getProviderProtocol() { return "openai" as const; }
  getProviderBaseUrl() { return undefined; }
}

class DeferredNativeToolModel implements ModelRuntime {
  readonly requests: CanonicalModelRequest[] = [];

  async *stream(request: CanonicalModelRequest): AsyncIterable<CanonicalModelEvent> {
    this.requests.push(request);
    yield { type: "request_started", provider: "test", model: "test" };
    yield { type: "message_start", role: "assistant" };
    if (this.requests.length === 1) {
      yield { type: "tool_call_start", id: "search-native-tools", name: "search_tools" };
      yield {
        type: "tool_call_end",
        toolCall: { id: "search-native-tools", name: "search_tools", input: { query: "current clock time" } },
      };
      yield { type: "message_end", finishReason: "tool_call" };
      return;
    }
    if (this.requests.length === 2) {
      yield { type: "tool_call_start", id: "call-current-time", name: "get_current_time" };
      yield {
        type: "tool_call_end",
        toolCall: { id: "call-current-time", name: "get_current_time", input: {} },
      };
      yield { type: "message_end", finishReason: "tool_call" };
      return;
    }
    yield { type: "text_delta", text: "deferred native tool completed" };
    yield { type: "message_end", finishReason: "stop" };
  }

  async complete(): Promise<CanonicalModelResponse> {
    return { role: "assistant", content: [{ type: "text", text: "deferred native tool completed" }], finishReason: "stop" };
  }

  getCapabilities() { return DEFAULT_MODEL_CAPABILITIES; }
  getMultimodal(): MultimodalConstraints { return { input: ["text"] }; }
  getProviderProtocol() { return "openai" as const; }
  getProviderBaseUrl() { return undefined; }
}

async function writeStandaloneSkill(root: string, name: string, body: string): Promise<void> {
  const skillRoot = join(root, name);
  await mkdir(skillRoot, { recursive: true });
  await writeFile(
    join(skillRoot, "SKILL.md"),
    `---\nname: ${name}\ndescription: ${name} test skill\n---\n\n${body}\n`,
    "utf8",
  );
}

function requestWithSkills(model: SkillScopeModel): CanonicalModelRequest {
  const request = model.requests.find((candidate) => candidate.systemPrompt?.includes("<available-skills>"));
  assert.ok(request, "the AgentLoop did not build a skill-aware model request");
  return request;
}

test("createLocalGateway applies SDK fallbackModel only to its configured session", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-fallback-model-"));
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, "pilotdeck.yaml"), TEST_CONFIG, "utf8");
  const model = new PreContentFallbackModel();
  const local = createLocalGateway({
    projectRoot,
    pilotHome: projectRoot,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
    __testModelFactory: () => model,
  });

  const submit = async (sessionKey: string, fallbackModel?: string) => {
    const events: any[] = [];
    for await (const event of local.gateway.submitTurn({
      sessionKey,
      workspaceCwd: projectRoot,
      channelKey: "test",
      message: "respond using the available model",
      mode: "bypassPermissions",
      ...(fallbackModel ? { sdkSessionConfig: { fallbackModel } } : {}),
    })) events.push(event);
    return events;
  };

  try {
    const fallbackEvents = await submit("sdk:fallback-enabled", "test/reviewer");
    assert.deepEqual(model.attempts, ["test/test", "test/reviewer"]);
    assert.match(JSON.stringify(fallbackEvents), /fallback model response/);
    assert.doesNotMatch(JSON.stringify(fallbackEvents), /primary unavailable/);

    model.attempts.length = 0;
    const defaultEvents = await submit("sdk:fallback-disabled");
    assert.ok(model.attempts.length >= 1);
    assert.equal(model.attempts.every((attempt) => attempt === "test/test"), true);
    assert.match(JSON.stringify(defaultEvents), /primary unavailable/);

    const invalidEvents = await submit("sdk:fallback-invalid", "test/missing");
    assert.match(JSON.stringify(invalidEvents), /fallbackModel is not uniquely resolvable/);
  } finally {
    local.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("SDK managed model policy excludes project Router fallback attempts", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-managed-router-fallback-"));
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(
    join(projectRoot, "pilotdeck.yaml"),
    `${TEST_CONFIG}
router:
  enabled: true
  fallback:
    default:
      - test/reviewer
`,
    "utf8",
  );
  const model = new PreContentFallbackModel();
  const local = createLocalGateway({
    projectRoot,
    pilotHome: projectRoot,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
    __testModelFactory: () => model,
  });

  try {
    const events: any[] = [];
    for await (const event of local.gateway.submitTurn({
      sessionKey: "sdk:managed-router-fallback",
      workspaceCwd: projectRoot,
      channelKey: "test",
      message: "do not use the disallowed fallback",
      mode: "bypassPermissions",
      sdkSessionConfig: {
        managedModels: { allow: ["test/test"], deny: [] },
      },
    })) events.push(event);

    assert.ok(model.attempts.length > 0);
    assert.equal(model.attempts.every((attempt) => attempt === "test/test"), true);
    assert.match(JSON.stringify(events), /primary unavailable/);
  } finally {
    local.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("createLocalGateway emits transient tool progress only when the SDK option is enabled", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-tool-progress-"));
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, "pilotdeck.yaml"), TEST_CONFIG, "utf8");
  const model = new BashProgressModel();
  const local = createLocalGateway({
    projectRoot,
    pilotHome: projectRoot,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
    __testModelFactory: () => model,
  });

  const submit = async (sessionKey: string, agentProgressSummaries?: boolean) => {
    const events: any[] = [];
    for await (const event of local.gateway.submitTurn({
      sessionKey,
      workspaceCwd: projectRoot,
      channelKey: "test",
      message: "run a command",
      mode: "bypassPermissions",
      ...(agentProgressSummaries !== undefined
        ? { sdkSessionConfig: { agentProgressSummaries } }
        : {}),
    })) events.push(event);
    return events;
  };

  try {
    const enabled = await submit("sdk:tool-progress-enabled", true);
    const progress = enabled.find((event) => event.type === "tool_progress");
    assert.deepEqual(progress && {
      toolCallId: progress.toolCallId,
      toolName: progress.toolName,
      message: progress.message,
      metadata: progress.metadata,
    }, {
      toolCallId: "bash-progress",
      toolName: "bash",
      message: "stdout: 8 bytes",
      metadata: { stream: "stdout", chunk: "progress", byteCount: 8 },
    });
    assert.equal(typeof progress?.createdAt, "string");
    assert.equal(typeof progress?.runId, "string");

    model.reset();
    const disabled = await submit("sdk:tool-progress-disabled");
    assert.equal(disabled.some((event) => event.type === "tool_progress"), false);
  } finally {
    local.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("createLocalGateway scopes SDK session skills in both prompts and read_skill", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-skills-e2e-"));
  const projectRoot = join(root, "project");
  const pilotHome = projectRoot;
  const builtinSkillsRoot = join(root, "builtin-skills");
  await mkdir(projectRoot, { recursive: true });
  await Promise.all([
    writeFile(join(projectRoot, "pilotdeck.yaml"), TEST_CONFIG, "utf8"),
    writeStandaloneSkill(builtinSkillsRoot, "review", "# Review skill\n\nSelected skill body."),
    writeStandaloneSkill(builtinSkillsRoot, "deploy", "# Deploy skill\n\nHidden skill body."),
  ]);

  const model = new SkillScopeModel("review");
  const local = createLocalGateway({
    projectRoot,
    pilotHome,
    builtinSkillsRoot,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
    __testModelFactory: () => model,
  });
  const submit = async (sessionKey: string, skills: string[] | "all") => {
    const events: any[] = [];
    for await (const event of local.gateway.submitTurn({
      sessionKey,
      workspaceCwd: projectRoot,
      channelKey: "test",
      message: "load the requested skill",
      mode: "bypassPermissions",
      sdkSessionConfig: { skills },
    })) events.push(event);
    return events;
  };

  try {
    const scopedEvents = await submit("sdk:skills-scoped", ["review"]);
    const scopedPrompt = requestWithSkills(model).systemPrompt ?? "";
    assert.match(scopedPrompt, /- review .*SKILL\.md/);
    assert.doesNotMatch(scopedPrompt, /- deploy .*SKILL\.md/);
    assert.match(JSON.stringify(scopedEvents), /Selected skill body/);

    model.reset("deploy");
    const blockedEvents = await submit("sdk:skills-blocked", ["review"]);
    const blockedPrompt = requestWithSkills(model).systemPrompt ?? "";
    assert.doesNotMatch(blockedPrompt, /- deploy .*SKILL\.md/);
    assert.match(JSON.stringify(blockedEvents), /Skill 'deploy' not found\. Available skills: review/);
    assert.doesNotMatch(JSON.stringify(blockedEvents), /Hidden skill body/);

    model.reset("deploy");
    const allEvents = await submit("sdk:skills-all", "all");
    const allPrompt = requestWithSkills(model).systemPrompt ?? "";
    assert.match(allPrompt, /- review .*SKILL\.md/);
    assert.match(allPrompt, /- deploy .*SKILL\.md/);
    assert.match(JSON.stringify(allEvents), /Hidden skill body/);

    const missingEvents = await submit("sdk:skills-missing", ["missing"]);
    assert.equal(missingEvents[0]?.type, "error");
    assert.equal(missingEvents[0]?.code, "SDK_SKILL_NOT_FOUND");
  } finally {
    local.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("createLocalGateway isolates Gateway-local SDK plugins to their configured session", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-plugins-e2e-"));
  const projectRoot = join(root, "project");
  const pluginRoot = join(root, "sdk-plugin");
  await Promise.all([
    mkdir(projectRoot, { recursive: true }),
    mkdir(join(pluginRoot, "skills"), { recursive: true }),
    mkdir(join(pluginRoot, "output-styles"), { recursive: true }),
  ]);
  await Promise.all([
    writeFile(join(projectRoot, "pilotdeck.yaml"), TEST_CONFIG, "utf8"),
    writeFile(join(pluginRoot, "plugin.json"), JSON.stringify({
      name: "SDK Review Plugin",
      skills: "skills",
      outputStyles: "output-styles",
    }), "utf8"),
    writeFile(join(pluginRoot, "skills", "review.md"), "# SDK review skill\n\nSDK PLUGIN SKILL BODY", "utf8"),
    writeFile(join(pluginRoot, "output-styles", "brief.md"), "SDK PLUGIN STYLE", "utf8"),
  ]);

  const model = new SkillScopeModel("sdk-plugin:review");
  const local = createLocalGateway({
    projectRoot,
    pilotHome: projectRoot,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
    __testModelFactory: () => model,
  });
  const submit = async (sessionKey: string, config?: Record<string, unknown>) => {
    const events: any[] = [];
    for await (const event of local.gateway.submitTurn({
      sessionKey,
      workspaceCwd: projectRoot,
      channelKey: "test",
      message: "load the SDK plugin skill",
      mode: "bypassPermissions",
      ...(config ? { sdkSessionConfig: config as any } : {}),
    })) events.push(event);
    return events;
  };

  try {
    const sessionKey = "sdk:plugin-scoped";
    const events = await submit(sessionKey, {
      plugins: [{ type: "local", path: pluginRoot }],
      skills: ["sdk-plugin:review"],
      outputStyle: "sdk-plugin:brief",
    });
    const prompt = requestWithSkills(model).systemPrompt ?? "";
    assert.match(prompt, /- sdk-plugin:review .*review\.md/);
    assert.match(prompt, /SDK PLUGIN STYLE/);
    assert.match(JSON.stringify(events), /SDK PLUGIN SKILL BODY/);

    const styles = await local.gateway.outputStylesList!({ projectKey: projectRoot, sessionKey });
    assert.deepEqual(styles.styles, [{
      name: "sdk-plugin:brief",
      plugin: "SDK Review Plugin",
      source: "project",
    }]);

    model.reset("sdk-plugin:review");
    const unscoped = await submit("sdk:plugin-unscoped");
    const unscopedPrompt = model.requests[0]?.systemPrompt ?? "";
    assert.doesNotMatch(unscopedPrompt, /sdk-plugin:review/);
    assert.doesNotMatch(unscopedPrompt, /SDK PLUGIN STYLE/);
    assert.match(JSON.stringify(unscoped), /Skill 'sdk-plugin:review' not found/);
    assert.doesNotMatch(JSON.stringify(unscoped), /SDK PLUGIN SKILL BODY/);
  } finally {
    local.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("createLocalGateway starts plugin MCP endpoints only for the owning SDK session", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-plugin-mcp-e2e-"));
  const projectRoot = join(root, "project");
  const pluginRoot = join(root, "session-plugin");
  await Promise.all([
    mkdir(projectRoot, { recursive: true }),
    mkdir(pluginRoot, { recursive: true }),
  ]);
  await writeFile(join(projectRoot, "pilotdeck.yaml"), TEST_CONFIG, "utf8");
  let calls = 0;
  const endpoint = createSdkMcpServer({
    name: "session-plugin-tools",
    tools: [tool(
      "ping",
      "Return a session-plugin response.",
      { type: "object", additionalProperties: false, properties: {} },
      async () => {
        calls += 1;
        return { content: [{ type: "text", text: "plugin-pong" }] };
      },
    )],
  });
  const mcpConfig = await endpoint.start();
  await writeFile(join(pluginRoot, "plugin.json"), JSON.stringify({
    name: "Session Plugin",
    mcpServers: {
      session_plugin_tools: { url: mcpConfig.url, transport: "streamable_http" },
    },
  }), "utf8");

  const model = new SessionPluginMcpModel();
  const local = createLocalGateway({
    projectRoot,
    pilotHome: projectRoot,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
    __testModelFactory: () => model,
  });
  const submit = async (sessionKey: string, plugin = false) => {
    const events: any[] = [];
    for await (const event of local.gateway.submitTurn({
      sessionKey,
      workspaceCwd: projectRoot,
      channelKey: "test",
      message: "call the session plugin MCP tool",
      mode: "bypassPermissions",
      ...(plugin ? { sdkSessionConfig: { plugins: [{ type: "local" as const, path: pluginRoot }] } } : {}),
    })) events.push(event);
    return events;
  };

  try {
    const scopedSession = "sdk:plugin-mcp-scoped";
    const scoped = await submit(scopedSession, true);
    assert.equal(calls, 1, "the configured session must execute the plugin-owned MCP tool");
    assert.equal(
      model.requests.some((request) => request.tools?.some((tool) => tool.name === "mcp__session_plugin_tools__ping") === true),
      true,
      "the native scheduler must receive the plugin MCP tool through the session registry",
    );
    assert.equal(scoped.some((event) => event.type === "turn_completed"), true);
    const statuses = await local.gateway.mcpServerStatus!({ projectKey: projectRoot, sessionKey: scopedSession });
    assert.equal(statuses.servers?.some((server) => server.name === "session_plugin_tools"), true);

    model.reset();
    const unscoped = await submit("sdk:plugin-mcp-unscoped");
    assert.equal(calls, 1, "the plugin MCP tool must not be visible in another SDK session");
    assert.equal(
      model.requests.some((request) => request.tools?.some((tool) => tool.name === "mcp__session_plugin_tools__ping") === true),
      false,
    );
    assert.match(JSON.stringify(unscoped), /not found|does not exist|unavailable|unknown tool/i);
  } finally {
    local.dispose();
    await endpoint.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("createLocalGateway reveals deferred SDK MCP tools only after search_tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-deferred-mcp-e2e-"));
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, "pilotdeck.yaml"), TEST_CONFIG, "utf8");
  let calls = 0;
  const endpoint = createSdkMcpServer({
    name: "deferred-tools",
    alwaysLoad: false,
    tools: [tool(
      "ping",
      "Run a deferred diagnostic ping.",
      { type: "object", additionalProperties: false, properties: {} },
      async () => {
        calls += 1;
        return { content: [{ type: "text", text: "deferred-pong" }] };
      },
      { searchHint: "diagnostic ping health check" },
    )],
  });
  const mcpConfig = await endpoint.start();
  const model = new DeferredMcpToolModel();
  const local = createLocalGateway({
    projectRoot,
    pilotHome: projectRoot,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
    __testModelFactory: () => model,
  });
  try {
    const sessionKey = "sdk:deferred-mcp";
    assert.deepEqual(await local.gateway.setMcpServers!({
      sessionKey,
      projectKey: projectRoot,
      servers: {
        deferred_tools: {
          ...mcpConfig,
          deferredTools: endpoint.deferredTools,
        },
      },
    }), { added: ["deferred_tools"], removed: [], errors: [] });

    const events: any[] = [];
    for await (const event of local.gateway.submitTurn({
      sessionKey,
      workspaceCwd: projectRoot,
      channelKey: "test",
      message: "Find and run the diagnostic tool.",
      mode: "bypassPermissions",
    })) events.push(event);

    assert.equal(calls, 1, "the deferred MCP handler must execute through the normal MCP runtime");
    assert.equal(model.requests[0]?.tools?.some((tool) => tool.name === "search_tools"), true);
    assert.equal(model.requests[0]?.tools?.some((tool) => tool.name === "mcp__deferred_tools__ping"), false);
    assert.equal(model.requests[1]?.tools?.some((tool) => tool.name === "mcp__deferred_tools__ping"), true);
    assert.match(JSON.stringify(events), /deferred-pong/);
  } finally {
    local.dispose();
    await endpoint.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("SDK query defers native tools until search_tools reveals the canonical definition", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-deferred-native-e2e-"));
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, "pilotdeck.yaml"), TEST_CONFIG, "utf8");
  const model = new DeferredNativeToolModel();
  const local = createLocalGateway({
    projectRoot,
    pilotHome: projectRoot,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
    __testModelFactory: () => model,
  });
  const server = await startGatewayServer({
    gateway: local.gateway,
    port: 0,
    token: "sdk-deferred-native-token",
  });
  let run: ReturnType<typeof query> | undefined;
  try {
    run = query({
      prompt: "Find the current clock time.",
      options: {
        gatewayUrl: server.wsUrl,
        authToken: server.token,
        projectKey: projectRoot,
        allowedTools: ["search_tools", "get_current_time"],
        deferredTools: [{ name: "get_current_time", searchHint: "current clock time" }],
      },
    });
    for await (const _event of run) { /* consume */ }

    assert.equal((await run.result()).status, "completed");
    assert.equal(model.requests[0]?.tools?.some((tool) => tool.name === "search_tools"), true);
    assert.equal(model.requests[0]?.tools?.some((tool) => tool.name === "get_current_time"), false);
    assert.equal(
      model.requests[1]?.tools?.some((tool) => tool.name === "get_current_time"),
      true,
      JSON.stringify(model.requests.map((request) => request.tools?.map((tool) => tool.name))),
    );
    assert.equal(model.requests[2]?.tools?.some((tool) => tool.name === "search_tools"), true);
  } finally {
    run?.close();
    await server.close();
    local.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("Gateway excludes native deferred catalogs when policy or explicit tools block their search path", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-deferred-native-policy-e2e-"));
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, "pilotdeck.yaml"), TEST_CONFIG, "utf8");
  const cases: Array<{
    name: string;
    organizationPolicy?: { tools: { deny: string[] } };
    allowedTools?: string[];
    disallowedTools?: string[];
  }> = [
    { name: "organization-target-deny", organizationPolicy: { tools: { deny: ["get_current_time"] } } },
    { name: "explicit-target-deny", disallowedTools: ["get_current_time"] },
    { name: "explicit-search-deny", disallowedTools: ["search_tools"] },
  ];
  try {
    for (const policyCase of cases) {
      const model = new DeferredNativeToolModel();
      const local = createLocalGateway({
        projectRoot,
        pilotHome: projectRoot,
        fallbackProjectRoot: projectRoot,
        permissionMode: "bypassPermissions",
        ...(policyCase.organizationPolicy ? { organizationPolicy: policyCase.organizationPolicy } : {}),
        __testModelFactory: () => model,
      });
      try {
        for await (const _event of local.gateway.submitTurn({
          sessionKey: `sdk:deferred-native-policy:${policyCase.name}`,
          workspaceCwd: projectRoot,
          channelKey: "test",
          message: "Find the current clock time.",
          mode: "bypassPermissions",
          ...(policyCase.allowedTools ? { allowedTools: policyCase.allowedTools } : {}),
          ...(policyCase.disallowedTools ? { disallowedTools: policyCase.disallowedTools } : {}),
          sdkSessionConfig: {
            deferredTools: [{ name: "get_current_time", searchHint: "current clock time" }],
          },
        })) { /* consume */ }

        assert.equal(
          model.requests.every((request) => !request.tools?.some((tool) => tool.name === "search_tools")),
          true,
          `${policyCase.name} must not expose a catalog that cannot reveal its target`,
        );
        assert.equal(
          model.requests.every((request) => !request.tools?.some((tool) => tool.name === "get_current_time")),
          true,
          `${policyCase.name} must not expose the denied native target`,
        );
      } finally {
        local.dispose();
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Gateway host tool policy also filters deferred MCP search and target tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-deferred-mcp-policy-e2e-"));
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, "pilotdeck.yaml"), TEST_CONFIG, "utf8");
  let calls = 0;
  const endpoint = createSdkMcpServer({
    name: "deferred-tools-policy",
    alwaysLoad: false,
    tools: [tool(
      "ping",
      "Run a deferred diagnostic ping.",
      { type: "object", additionalProperties: false, properties: {} },
      async () => {
        calls += 1;
        return { content: [{ type: "text", text: "deferred-pong" }] };
      },
      { searchHint: "diagnostic ping health check" },
    )],
  });
  const mcpConfig = await endpoint.start();
  const targetName = "mcp__deferred_tools__ping";
  const policyCases: Array<{
    name: string;
    deny?: string[];
    sandbox?: { type: "host"; profile: string; toolIsolation: "strict" };
  }> = [
    { name: "search", deny: ["search_tools"] },
    { name: "target", deny: ["mcp__deferred_tools__*"] },
    { name: "strict-host-sandbox", sandbox: { type: "host", profile: "strict", toolIsolation: "strict" } },
  ];
  try {
    for (const policyCase of policyCases) {
      calls = 0;
      const model = new DeferredMcpToolModel();
      const local = createLocalGateway({
        projectRoot,
        pilotHome: projectRoot,
        fallbackProjectRoot: projectRoot,
        permissionMode: "bypassPermissions",
        ...(policyCase.deny ? { organizationPolicy: { tools: { deny: policyCase.deny } } } : {}),
        ...(policyCase.sandbox ? {
          sandboxProfiles: {
            strict: createBubblewrapSandboxProfile({
              createRunner: () => ({
                async run() {
                  return { exitCode: 0, stdout: "", stderr: "", timedOut: false, durationMs: 1 };
                },
              }),
            }),
          },
        } : {}),
        __testModelFactory: () => model,
      });
      try {
        assert.deepEqual(await local.gateway.setMcpServers!({
          sessionKey: `sdk:deferred-mcp-policy:${policyCase.name}`,
          projectKey: projectRoot,
          servers: {
            deferred_tools: {
              ...mcpConfig,
              deferredTools: endpoint.deferredTools,
            },
          },
        }), { added: ["deferred_tools"], removed: [], errors: [] });

        for await (const _event of local.gateway.submitTurn({
          sessionKey: `sdk:deferred-mcp-policy:${policyCase.name}`,
          workspaceCwd: projectRoot,
          channelKey: "test",
          message: "Find and run the diagnostic tool.",
          mode: "bypassPermissions",
          ...(policyCase.sandbox ? { sdkSessionConfig: { sandbox: policyCase.sandbox } } : {}),
        })) { /* consume */ }

        assert.equal(calls, 0, `${policyCase.name} policy must prevent deferred handler execution`);
        assert.equal(
          model.requests.every((request) => !request.tools?.some((tool) => tool.name === "search_tools")),
          true,
          `${policyCase.name} policy must not expose search_tools`,
        );
        assert.equal(
          model.requests.every((request) => !request.tools?.some((tool) => tool.name === targetName)),
          true,
          `${policyCase.name} policy must not expose the deferred target`,
        );
      } finally {
        local.dispose();
      }
    }
  } finally {
    await endpoint.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("createLocalGateway keeps persistSession=false outside project transcript storage", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-ephemeral-e2e-"));
  const projectRoot = join(root, "project");
  const pilotHome = projectRoot;
  const sessionKey = "sdk:ephemeral-e2e";
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, "pilotdeck.yaml"), TEST_CONFIG, "utf8");

  const storage = createAgentProjectSessionStorage({ projectRoot, pilotHome, sessionId: sessionKey });
  const transcriptExists = async (): Promise<boolean> =>
    await stat(storage.transcriptPath).then((entry) => entry.isFile()).catch(() => false);
  const local = createLocalGateway({
    projectRoot,
    pilotHome,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
    __testModelFactory: () => new TitleModel(),
  });

  try {
    assert.equal(await transcriptExists(), false, "the session must not have a pre-created project transcript");
    const events: any[] = [];
    for await (const event of local.gateway.submitTurn({
      sessionKey,
      workspaceCwd: projectRoot,
      channelKey: "test",
      message: "produce a short answer",
      mode: "bypassPermissions",
      sdkSessionConfig: { persistSession: false },
    })) {
      events.push(event);
    }
    assert.equal(events.some((event) => event.type === "turn_completed"), true);
    // submitTurn does not delete sessions itself. If an ordinary JSONL writer
    // had been used, the file would still exist at this point.
    assert.equal(await transcriptExists(), false, "the completed ephemeral session must not create a project JSONL transcript");

    await local.gateway.deleteSession!({ sessionKey, projectKey: projectRoot });
    assert.equal(await transcriptExists(), false, "Gateway cleanup must not fall back to persistent deletion");
  } finally {
    local.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("createLocalGateway restores file checkpoints after a Gateway restart without a new turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-checkpoint-restart-e2e-"));
  const projectRoot = join(root, "project");
  const sessionKey = "sdk:checkpoint-restart";
  const runId = "checkpoint-turn";
  const notePath = join(projectRoot, "note.txt");
  await mkdir(projectRoot, { recursive: true });
  await Promise.all([
    writeFile(join(projectRoot, "pilotdeck.yaml"), TEST_CONFIG, "utf8"),
    writeFile(notePath, "before\n", "utf8"),
  ]);

  const first = createLocalGateway({
    projectRoot,
    pilotHome: projectRoot,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
    __testModelFactory: () => new CheckpointWriteModel(),
  });
  try {
    const events: any[] = [];
    for await (const event of first.gateway.submitTurn({
      sessionKey,
      workspaceCwd: projectRoot,
      channelKey: "test",
      message: "replace the note",
      mode: "bypassPermissions",
      runId,
    })) events.push(event);
    assert.equal(events.some((event) => event.type === "turn_completed"), true);
    assert.equal(await readFile(notePath, "utf8"), "after\n");
  } finally {
    first.dispose();
  }

  const restarted = createLocalGateway({
    projectRoot,
    pilotHome: projectRoot,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
    __testModelFactory: () => new TitleModel(),
  });
  try {
    assert.ok(restarted.gateway.rewindFiles, "createLocalGateway must expose the rewind_files capability");
    await writeFile(notePath, "external\n", "utf8");
    const conflict = await restarted.gateway.rewindFiles!({
      sessionKey,
      projectKey: projectRoot,
      userMessageId: runId,
      dryRun: true,
    });
    assert.equal(conflict.canRewind, false);
    assert.deepEqual(conflict.conflicts, [notePath]);
    assert.equal(await readFile(notePath, "utf8"), "external\n");

    await writeFile(notePath, "after\n", "utf8");
    const dryRun = await restarted.gateway.rewindFiles!({
      sessionKey,
      projectKey: projectRoot,
      userMessageId: runId,
      dryRun: true,
    });
    assert.deepEqual(dryRun, { canRewind: true, insertions: 1, deletions: 1 });

    const rewind = await restarted.gateway.rewindFiles!({
      sessionKey,
      projectKey: projectRoot,
      userMessageId: runId,
    });
    assert.equal(rewind.canRewind, true);
    assert.deepEqual(rewind.filesChanged, [notePath]);
    assert.equal(await readFile(notePath, "utf8"), "before\n");
  } finally {
    restarted.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("Gateway async transcript storage restores file checkpoints from a host-owned backup store", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-async-checkpoint-store-"));
  const projectRoot = join(root, "project");
  const sessionKey = "sdk:async-checkpoint-store";
  const runId = "async-checkpoint-turn";
  const notePath = join(projectRoot, "note.txt");
  const transcriptRecords = new Map<string, unknown[]>();
  const backupRecords = new Map<string, Uint8Array>();
  const storageKey = (transcriptPath: string, backupFileName: string) =>
    `${transcriptPath}\u0000${backupFileName}`;
  const nativeSessionStorage = createGatewayAsyncTranscriptStorageAdapter({
    store: {
      async append(key, entry) {
        const entries = transcriptRecords.get(key.transcriptPath) ?? [];
        entries.push(structuredClone(entry));
        transcriptRecords.set(key.transcriptPath, entries);
      },
      async read(key) {
        return {
          entries: structuredClone(transcriptRecords.get(key.transcriptPath) ?? []) as any[],
          diagnostics: [],
        };
      },
      async has(key) {
        return transcriptRecords.has(key.transcriptPath);
      },
      async delete(key) {
        transcriptRecords.delete(key.transcriptPath);
      },
      fileHistoryBackups: {
        async write(key, backupFileName, bytes) {
          backupRecords.set(storageKey(key.transcriptPath, backupFileName), bytes.slice());
        },
        async read(key, backupFileName) {
          return backupRecords.get(storageKey(key.transcriptPath, backupFileName))?.slice();
        },
        async delete(key, backupFileName) {
          backupRecords.delete(storageKey(key.transcriptPath, backupFileName));
        },
        async deleteAll(key) {
          const prefix = `${key.transcriptPath}\u0000`;
          for (const recordKey of backupRecords.keys()) {
            if (recordKey.startsWith(prefix)) backupRecords.delete(recordKey);
          }
        },
      },
    },
  });
  await mkdir(projectRoot, { recursive: true });
  await Promise.all([
    writeFile(join(projectRoot, "pilotdeck.yaml"), TEST_CONFIG, "utf8"),
    writeFile(notePath, "before\n", "utf8"),
  ]);

  const first = createLocalGateway({
    projectRoot,
    pilotHome: projectRoot,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
    nativeSessionStorage,
    __testModelFactory: () => new CheckpointWriteModel(),
  });
  try {
    for await (const _event of first.gateway.submitTurn({
      sessionKey,
      workspaceCwd: projectRoot,
      channelKey: "test",
      message: "replace the note through the host-owned checkpoint store",
      mode: "bypassPermissions",
      runId,
    })) { /* consume */ }
    assert.equal(await readFile(notePath, "utf8"), "after\n");
    assert.ok(backupRecords.size > 0, "checkpoint backups must be written to the host-owned store");
    const storage = createAgentProjectSessionStorage({ projectRoot, pilotHome: projectRoot, sessionId: sessionKey });
    await assert.rejects(stat(storage.transcriptPath), "external checkpoint storage must not create a primary JSONL");
    await assert.rejects(stat(storage.fileHistoryDir), "external checkpoint storage must not create a backup directory");
  } finally {
    first.dispose();
  }

  const restarted = createLocalGateway({
    projectRoot,
    pilotHome: projectRoot,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
    nativeSessionStorage,
    __testModelFactory: () => new TitleModel(),
  });
  try {
    await writeFile(notePath, "after\n", "utf8");
    const dryRun = await restarted.gateway.rewindFiles!({
      sessionKey,
      projectKey: projectRoot,
      userMessageId: runId,
      dryRun: true,
    });
    assert.deepEqual(dryRun, { canRewind: true, insertions: 1, deletions: 1 });
    const rewind = await restarted.gateway.rewindFiles!({
      sessionKey,
      projectKey: projectRoot,
      userMessageId: runId,
    });
    assert.equal(rewind.canRewind, true);
    assert.equal(await readFile(notePath, "utf8"), "before\n");

    await restarted.gateway.deleteSession!({ sessionKey, projectKey: projectRoot });
    assert.equal(backupRecords.size, 0, "session deletion must remove host-owned checkpoint blobs");
  } finally {
    restarted.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("createLocalGateway reloads a project output style without changing its namespace", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-output-style-e2e-"));
  const projectRoot = join(root, "project");
  const pluginRoot = join(projectRoot, ".pilotdeck", "plugins", "style-plugin");
  const stylePath = join(pluginRoot, "output-styles", "concise.md");
  const sessionKey = "sdk:output-style-e2e";
  await mkdir(join(pluginRoot, "output-styles"), { recursive: true });
  await Promise.all([
    writeFile(join(projectRoot, "pilotdeck.yaml"), TEST_CONFIG, "utf8"),
    writeFile(join(pluginRoot, "plugin.json"), JSON.stringify({ name: "Style Plugin", outputStyles: "output-styles" }), "utf8"),
    writeFile(stylePath, "---\ndescription: Concise style\n---\nSTYLE V1", "utf8"),
  ]);
  const model = new PromptCaptureModel();
  const local = createLocalGateway({
    projectRoot,
    pilotHome: projectRoot,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
    __testModelFactory: () => model,
  });
  try {
    const styles = await local.gateway.outputStylesList!({ projectKey: projectRoot, sessionKey });
    assert.deepEqual(styles.styles, [{
      name: "style-plugin:concise",
      description: "Concise style",
      plugin: "Style Plugin",
      source: "project",
    }]);
    await local.gateway.setOutputStyle!({ projectKey: projectRoot, sessionKey, name: "style-plugin:concise" });

    for await (const _event of local.gateway.submitTurn({
      sessionKey,
      workspaceCwd: projectRoot,
      channelKey: "test",
      message: "answer with the selected style",
      mode: "bypassPermissions",
      runId: "output-style-v1",
    })) { /* consume */ }
    assert.equal(
      model.requests.some((request) => request.systemPrompt?.includes("STYLE V1")),
      true,
      "the selected project style must be appended while building the session runtime",
    );

    await writeFile(stylePath, "---\ndescription: Concise style\n---\nSTYLE V2", "utf8");
    const reloaded = await local.gateway.reloadOutputStyles!({ projectKey: projectRoot });
    assert.deepEqual(reloaded, { reloaded: true, changed: ["style-plugin:concise"] });
    const stylesAfterReload = await local.gateway.outputStylesList!({ projectKey: projectRoot, sessionKey });
    assert.deepEqual(stylesAfterReload.styles?.map((style) => style.name), ["style-plugin:concise"]);

    for await (const _event of local.gateway.submitTurn({
      sessionKey,
      workspaceCwd: projectRoot,
      channelKey: "test",
      message: "answer after style reload",
      mode: "bypassPermissions",
      runId: "output-style-v2",
    })) { /* consume */ }
    assert.equal(
      model.requests.some((request) => request.systemPrompt?.includes("STYLE V2")),
      true,
      "the reloaded style must affect only the subsequently constructed runtime",
    );
  } finally {
    local.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("createLocalGateway publishes Gateway-owned context usage categories", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-context-usage-e2e-"));
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, "pilotdeck.yaml"), TEST_CONFIG, "utf8");
  const local = createLocalGateway({
    projectRoot,
    pilotHome: projectRoot,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
    __testModelFactory: () => new TitleModel(),
  });

  try {
    const events: any[] = [];
    for await (const event of local.gateway.submitTurn({
      sessionKey: "sdk:context-usage-e2e",
      workspaceCwd: projectRoot,
      channelKey: "test",
      message: "produce a short answer",
      mode: "bypassPermissions",
    })) {
      events.push(event);
    }
    const budget = events.find((event) => event.type === "context_budget");
    assert.ok(budget, "the native Gateway must expose the AgentLoop context budget event");
    assert.deepEqual(budget.breakdown?.source, "local_estimate");
    assert.ok((budget.breakdown?.system ?? 0) > 0);
    assert.ok((budget.breakdown?.tools ?? 0) > 0);
    assert.ok((budget.breakdown?.messages ?? 0) > 0);
    assert.equal(
      budget.breakdown.system
        + budget.breakdown.mcp
        + budget.breakdown.memory
        + budget.breakdown.tools
        + budget.breakdown.messages,
      budget.breakdown.total,
    );
  } finally {
    local.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("createLocalGateway applies SDK dynamic agent definitions before native session creation", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-agents-e2e-"));
  const projectRoot = join(root, "project");
  const pilotHome = projectRoot;
  await Promise.all([
    mkdir(projectRoot, { recursive: true }),
  ]);
  await writeFile(join(pilotHome, "pilotdeck.yaml"), TEST_CONFIG, "utf8");

  let receivedConfig: any;
  const local = createLocalGateway({
    projectRoot,
    pilotHome,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
    __testModelFactory: () => new TitleModel(),
    __testAgentLoopFactory: ({ config }) => {
      receivedConfig = config;
      return {
        snapshotFileState: () => ({}),
        async *run(options): AsyncGenerator<AgentEvent, AgentLoopRunResult, unknown> {
          const finalMessage = {
            role: "assistant" as const,
            content: [{ type: "text" as const, text: "agent config applied" }],
          };
          const result: AgentLoopRunResult = {
            result: {
              type: "success",
              sessionId: options.sessionId,
              turnId: options.turnId,
              finalMessage,
              stopReason: "completed",
              usage: {},
              permissionDenials: [],
              turns: 1,
              startedAt: "2026-09-08T00:00:00.000Z",
              completedAt: "2026-09-08T00:00:00.001Z",
            },
            messages: [...options.messages, finalMessage],
          };
          yield {
            type: "turn_completed",
            sessionId: options.sessionId,
            turnId: options.turnId,
            result: result.result,
          };
          return result;
        },
      };
    },
  });

  try {
    const events: any[] = [];
    for await (const event of local.gateway.submitTurn({
      sessionKey: "sdk:agents-e2e",
      workspaceCwd: projectRoot,
      channelKey: "test",
      message: "delegate this review",
      mode: "bypassPermissions",
      sdkSessionConfig: {
        agents: {
          reviewer: {
            description: "Reviews a bounded change.",
            prompt: "Focus on correctness and report only actionable findings.",
            model: "test/reviewer",
            tools: ["read_file"],
            disallowedTools: ["bash"],
            maxTurns: 2,
            effort: "medium",
            permissionMode: "plan",
            mcpServers: {
              agent_tools: { type: "streamable_http", url: "http://127.0.0.1:4321/mcp" },
              legacy_tools: { type: "sse", url: "http://127.0.0.1:4321/events", headers: { authorization: "Bearer legacy" } },
            },
            memory: "disabled",
            initialPrompt: "Review the repository conventions before the directive.",
            criticalSystemReminder_EXPERIMENTAL: "Only report verified findings.",
          },
        },
      },
    })) {
      events.push(event);
    }

    assert.equal(events.some((event) => event.type === "turn_completed"), true);
    assert.deepEqual(receivedConfig.subagentDefinitions, {
      reviewer: {
        id: "reviewer",
        description: "Reviews a bounded change.",
        systemPromptSuffix: "Focus on correctness and report only actionable findings.",
        allowedTools: ["read_file"],
        disallowedTools: ["bash"],
        omitProjectInstructions: false,
        omitGitStatus: false,
        isReadOnly: true,
        modelOverride: {
          provider: "test",
          model: "reviewer",
        },
        maxTurns: 2,
        effort: "medium",
        permissionMode: "plan",
        mcpServers: {
          agent_tools: { type: "streamable_http", url: "http://127.0.0.1:4321/mcp" },
          legacy_tools: { type: "sse", url: "http://127.0.0.1:4321/events", headers: { authorization: "Bearer legacy" } },
        },
        memory: "disabled",
        initialPrompt: "Review the repository conventions before the directive.",
        criticalSystemReminder: "Only report verified findings.",
      },
    });

    const invalidEvents: any[] = [];
    for await (const event of local.gateway.submitTurn({
      sessionKey: "sdk:agents-invalid-model",
      workspaceCwd: projectRoot,
      channelKey: "test",
      message: "delegate this review",
      mode: "bypassPermissions",
      sdkSessionConfig: {
        agents: {
          reviewer: {
            description: "Reviews a bounded change.",
            prompt: "Focus on correctness and report only actionable findings.",
            model: "test/missing",
          },
        },
      },
    })) {
      invalidEvents.push(event);
    }
    assert.equal(invalidEvents[0]?.type, "error");
    assert.equal(invalidEvents[0]?.code, "INVALID_SDK_AGENT_MODEL");
  } finally {
    local.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("Gateway resolves AgentDefinition MCP references to immutable SDK-session endpoints", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-agent-mcp-reference-"));
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, "pilotdeck.yaml"), TEST_CONFIG, "utf8");
  let receivedConfig: any;
  const local = createLocalGateway({
    projectRoot,
    pilotHome: projectRoot,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
    __testModelFactory: () => new TitleModel(),
    __testAgentLoopFactory: ({ config }) => {
      receivedConfig = config;
      return {
        snapshotFileState: () => ({}),
        async *run(options): AsyncGenerator<AgentEvent, AgentLoopRunResult, unknown> {
          const finalMessage = {
            role: "assistant" as const,
            content: [{ type: "text" as const, text: "agent MCP reference applied" }],
          };
          const result: AgentLoopRunResult = {
            result: {
              type: "success",
              sessionId: options.sessionId,
              turnId: options.turnId,
              finalMessage,
              stopReason: "completed",
              usage: {},
              permissionDenials: [],
              turns: 1,
              startedAt: "2026-09-08T00:00:00.000Z",
              completedAt: "2026-09-08T00:00:00.001Z",
            },
            messages: [...options.messages, finalMessage],
          };
          yield {
            type: "turn_completed",
            sessionId: options.sessionId,
            turnId: options.turnId,
            result: result.result,
          };
          return result;
        },
      };
    },
  });
  const sessionKey = "sdk:agent-mcp-reference";

  try {
    assert.ok(local.gateway.setMcpServers, "Gateway must expose SDK MCP configuration");
    assert.ok(local.gateway.toggleMcpServer, "Gateway must expose SDK MCP toggles");
    await local.gateway.setMcpServers!({
      sessionKey,
      projectKey: projectRoot,
      servers: {
        tickets: { type: "streamable_http", url: "http://127.0.0.1:4321/mcp" },
      },
    });
    for await (const _event of local.gateway.submitTurn({
      sessionKey,
      workspaceCwd: projectRoot,
      channelKey: "test",
      message: "configure a child",
      mode: "bypassPermissions",
      sdkSessionConfig: {
        agents: {
          reviewer: {
            description: "Review using a session MCP reference.",
            prompt: "Review the implementation.",
            mcpServers: [
              "tickets",
              { docs: { type: "sse", url: "http://127.0.0.1:4321/events" } },
            ],
          },
        },
      },
    })) { /* consume */ }

    assert.deepEqual(receivedConfig.subagentDefinitions.reviewer.mcpServers, {
      tickets: { type: "streamable_http", url: "http://127.0.0.1:4321/mcp" },
      docs: { type: "sse", url: "http://127.0.0.1:4321/events" },
    });

    const unknownEvents: any[] = [];
    for await (const event of local.gateway.submitTurn({
      sessionKey: "sdk:agent-mcp-unknown",
      workspaceCwd: projectRoot,
      channelKey: "test",
      message: "configure an unknown child MCP",
      mode: "bypassPermissions",
      sdkSessionConfig: {
        agents: {
          reviewer: {
            description: "Review using an unknown reference.",
            prompt: "Review the implementation.",
            mcpServers: ["tickets"],
          },
        },
      },
    })) unknownEvents.push(event);
    assert.equal(unknownEvents[0]?.type, "error");
    assert.equal(unknownEvents[0]?.code, "SDK_AGENT_MCP_REFERENCE_NOT_FOUND");

    await local.gateway.toggleMcpServer!({ sessionKey, projectKey: projectRoot, serverName: "tickets", enabled: false });
    const disabledEvents: any[] = [];
    for await (const event of local.gateway.submitTurn({
      sessionKey,
      workspaceCwd: projectRoot,
      channelKey: "test",
      message: "configure a disabled child MCP",
      mode: "bypassPermissions",
      sdkSessionConfig: {
        agents: {
          reviewer: {
            description: "Review using a disabled reference.",
            prompt: "Review the implementation.",
            mcpServers: ["tickets"],
          },
        },
      },
    })) disabledEvents.push(event);
    assert.equal(disabledEvents[0]?.type, "error");
    assert.equal(disabledEvents[0]?.code, "SDK_AGENT_MCP_REFERENCE_DISABLED");
  } finally {
    local.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("createLocalGateway runs SDK background AgentDefinitions after the parent turn and lets the owner stop them", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-background-agent-"));
  const projectRoot = join(root, "project");
  const sessionKey = "sdk:background-agent";
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, "pilotdeck.yaml"), TEST_CONFIG, "utf8");
  const storage = createAgentProjectSessionStorage({ projectRoot, pilotHome: projectRoot, sessionId: sessionKey });
  const model = new BackgroundAgentDefinitionModel();
  const local = createLocalGateway({
    projectRoot,
    pilotHome: projectRoot,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
    __testModelFactory: () => model,
  });

  try {
    const events: any[] = [];
    for await (const event of local.gateway.submitTurn({
      sessionKey,
      workspaceCwd: projectRoot,
      channelKey: "test",
      message: "delegate a background review",
      mode: "bypassPermissions",
      sdkSessionConfig: {
        agents: {
          reviewer: {
            description: "Background review.",
            prompt: "BACKGROUND SDK MARKER",
            background: true,
            tools: [],
          },
        },
      },
    })) {
      events.push(event);
    }

    assert.equal(events.some((event) => event.type === "turn_completed"), true);
    await model.childStarted;
    assert.ok(local.gateway.backgroundTasks, "Gateway must expose the background-task control capability");
    const active = await local.gateway.backgroundTasks({ sessionKey, projectKey: projectRoot });
    assert.equal(active.backgrounded, true, "the child must outlive its parent turn");
    assert.equal(active.taskIds?.length, 1);
    const taskId = active.taskIds?.[0];
    assert.ok(taskId);
    const launched = events.find((event) => event.type === "tool_call_finished" && event.toolName === "agent");
    assert.equal(
      launched?.data?.backgroundTaskId,
      taskId,
      "the streamed agent tool result must expose the id needed by Query.stopTask()",
    );
    assert.ok(local.gateway.stopBackgroundTask, "Gateway must expose background task stop");
    const stopped = await local.gateway.stopBackgroundTask({ sessionKey, projectKey: projectRoot, taskId });
    assert.deepEqual(stopped, { stopped: true, status: "cancelled" });
    await model.childAborted;

    const inactive = await local.gateway.backgroundTasks({ sessionKey, projectKey: projectRoot, taskId });
    assert.equal(inactive.backgrounded, false);
    const parentTranscript = await readFile(storage.transcriptPath, "utf8");
    assert.match(parentTranscript, /subagent_started/);
    const sidechains = await readdir(storage.subagentsDir);
    assert.equal(sidechains.length, 1, "the detached child must retain its own sidechain transcript");
  } finally {
    local.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("createLocalGateway runs AgentDefinition observers in a detached read-only sidechain", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-observer-agent-"));
  const projectRoot = join(root, "project");
  const sessionKey = "sdk:observer-agent";
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, "pilotdeck.yaml"), TEST_CONFIG, "utf8");
  const storage = createAgentProjectSessionStorage({ projectRoot, pilotHome: projectRoot, sessionId: sessionKey });
  const model = new ObserverAgentDefinitionModel();
  const local = createLocalGateway({
    projectRoot,
    pilotHome: projectRoot,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
    __testModelFactory: () => model,
  });

  try {
    const events: any[] = [];
    for await (const event of local.gateway.submitTurn({
      sessionKey,
      workspaceCwd: projectRoot,
      channelKey: "test",
      message: "review this change",
      mode: "bypassPermissions",
      sdkSessionConfig: {
        agents: {
          reviewer: {
            description: "Observed reviewer.",
            prompt: "OBSERVED AGENT MARKER",
            observer: "auditor",
            observerMessage: "Only report verified issues.",
          },
          auditor: {
            description: "Independent observer.",
            prompt: "OBSERVER AGENT MARKER",
            // Deliberately broad: observer execution must still receive no tools.
            tools: ["bash", "write_file"],
            permissionMode: "bypassPermissions",
          },
        },
      },
    })) {
      events.push(event);
    }

    assert.equal(events.some((event) => event.type === "turn_completed"), true);
    await model.observerStarted;
    assert.ok(local.gateway.backgroundTasks, "Gateway must expose background task inspection");
    const visibleTasks = await local.gateway.backgroundTasks({ sessionKey, projectKey: projectRoot });
    assert.equal(visibleTasks.backgrounded, false, "observers must not become user-controllable background tasks");

    const observerRequest = model.observerRequests[0];
    assert.ok(observerRequest, "the observer must receive its own model invocation");
    assert.deepEqual(observerRequest.tools ?? [], [], "observers must not receive tool, MCP, or agent execution access");
    const observerDigest = observerRequest.messages
      .flatMap((message) => message.content)
      .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
      .map((block) => block.text)
      .join("\n");
    assert.match(observerDigest, /Observed agent: reviewer/);
    assert.match(observerDigest, /Inspect the implementation and report the result/);
    assert.match(observerDigest, /Only report verified issues/);
    assert.match(observerDigest, /observed child finished/);

    const parentAfterChild = model.parentRequests.at(-1);
    const parentText = parentAfterChild?.messages
      .flatMap((message) => message.content)
      .filter((block): block is Extract<typeof block, { type: "text" }> => block.type === "text")
      .map((block) => block.text)
      .join("\n") ?? "";
    assert.doesNotMatch(parentText, /Only report verified issues|found no blocking issue/);

    model.release();
    await model.observerDone;
    const parentTranscript = await readFile(storage.transcriptPath, "utf8");
    assert.match(parentTranscript, /subagent_started/);
    const sidechains = await readdir(storage.subagentsDir);
    assert.equal(sidechains.length, 2, "observed and observer children must each retain a sidechain transcript");
  } finally {
    model.release();
    local.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("createLocalGateway scopes AgentDefinition skills and runs its fork-local MCP server", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-agent-definition-scope-"));
  const projectRoot = join(root, "project");
  const builtinSkillsRoot = join(root, "builtin-skills");
  await mkdir(projectRoot, { recursive: true });
  await Promise.all([
    writeFile(join(projectRoot, "pilotdeck.yaml"), TEST_CONFIG, "utf8"),
    writeStandaloneSkill(builtinSkillsRoot, "review", "# Review\n\nAgent-only review skill."),
    writeStandaloneSkill(builtinSkillsRoot, "deploy", "# Deploy\n\nThis skill must stay hidden."),
  ]);
  let mcpCalls = 0;
  const endpoint = createSdkMcpServer({
    name: "agent-tools",
    tools: [tool(
      "ping",
      "Return a fork-local MCP response.",
      { type: "object", additionalProperties: false, properties: {} },
      async () => {
        mcpCalls += 1;
        return { content: [{ type: "text", text: "agent-pong" }] };
      },
    )],
  });
  const mcpConfig = await endpoint.start();
  const model = new AgentDefinitionScopeModel();
  const local = createLocalGateway({
    projectRoot,
    pilotHome: projectRoot,
    builtinSkillsRoot,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
    __testModelFactory: () => model,
  });

  try {
    const events: any[] = [];
    for await (const event of local.gateway.submitTurn({
      sessionKey: "sdk:agent-definition-scope",
      workspaceCwd: projectRoot,
      channelKey: "test",
      message: "delegate a scoped review",
      mode: "bypassPermissions",
      sdkSessionConfig: {
        agents: {
          reviewer: {
            description: "Review with scoped extensions.",
            prompt: "SDK AGENT SCOPE MARKER",
            tools: ["mcp__agent_tools__ping", "read_skill"],
            mcpServers: { agent_tools: mcpConfig },
            skills: ["review"],
            memory: "disabled",
            initialPrompt: "Inspect the supplied review skill before acting.",
            criticalSystemReminder_EXPERIMENTAL: "Do not claim unverified results.",
          },
        },
      },
    })) {
      events.push(event);
    }

    assert.equal(events.some((event) => event.type === "turn_completed"), true);
    assert.equal(mcpCalls, 1, "the child must execute its fork-local MCP tool exactly once");
    assert.match(JSON.stringify(events), /Skill 'deploy' not found\. Available skills: review/);
    const childPrompt = model.childRequests[0]?.systemPrompt ?? "";
    assert.match(childPrompt, /SDK AGENT SCOPE MARKER/);
    assert.match(childPrompt, /Do not claim unverified results\./);
    assert.match(childPrompt, /- review .*SKILL\.md/);
    assert.doesNotMatch(childPrompt, /- deploy .*SKILL\.md/);
    assert.match(JSON.stringify(model.childRequests[0]?.messages), /Inspect the supplied review skill before acting\./);
    assert.match(JSON.stringify(model.childRequests[0]?.messages), /Use the assigned MCP tool and return the required report\./);
    assert.equal(
      model.childRequests.some((request) => request.tools?.some((tool) => tool.name === "mcp__agent_tools__ping") === true),
      true,
      "the child model must receive only its own MCP tool through the native registry",
    );
  } finally {
    local.dispose();
    await endpoint.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Gateway keeps session and host tool filters on fork-local AgentDefinition MCP tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-agent-definition-policy-"));
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, "pilotdeck.yaml"), TEST_CONFIG, "utf8");
  let calls = 0;
  const endpoint = createSdkMcpServer({
    name: "agent-tools-policy",
    tools: [tool(
      "ping",
      "Run a fork-local policy probe.",
      { type: "object", additionalProperties: false, properties: {} },
      async () => {
        calls += 1;
        return { content: [{ type: "text", text: "unexpected" }] };
      },
    )],
  });
  const mcpConfig = await endpoint.start();
  const targetName = "mcp__agent_tools__ping";
  const filterCases: Array<{
    name: string;
    organizationPolicy?: { tools: { allow?: string[]; deny?: string[] } };
    allowedTools?: string[];
    disallowedTools?: string[];
  }> = [
    { name: "organization", organizationPolicy: { tools: { deny: ["mcp__agent_tools__*"] } } },
    { name: "organization-allowlist", organizationPolicy: { tools: { allow: ["agent"] } } },
    {
      name: "organization-deny-wins",
      organizationPolicy: { tools: { allow: ["agent", targetName], deny: [targetName] } },
    },
    { name: "allowlist", allowedTools: ["agent"] },
    { name: "denylist", disallowedTools: [targetName] },
  ];
  try {
    for (const filterCase of filterCases) {
      calls = 0;
      const model = new AgentDefinitionScopeModel();
      const local = createLocalGateway({
        projectRoot,
        pilotHome: projectRoot,
        fallbackProjectRoot: projectRoot,
        permissionMode: "bypassPermissions",
        ...(filterCase.organizationPolicy ? { organizationPolicy: filterCase.organizationPolicy } : {}),
        __testModelFactory: () => model,
      });
      try {
        for await (const _event of local.gateway.submitTurn({
          sessionKey: `sdk:agent-definition-policy:${filterCase.name}`,
          workspaceCwd: projectRoot,
          channelKey: "test",
          message: "Delegate a policy-restricted MCP task.",
          mode: "bypassPermissions",
          ...(filterCase.allowedTools ? { allowedTools: filterCase.allowedTools } : {}),
          ...(filterCase.disallowedTools ? { disallowedTools: filterCase.disallowedTools } : {}),
          sdkSessionConfig: {
            agents: {
              reviewer: {
                description: "Review using an MCP tool that session policy denies.",
                prompt: "SDK AGENT SCOPE MARKER",
                tools: [targetName],
                mcpServers: { agent_tools: mcpConfig },
              },
            },
          },
        })) { /* consume */ }

        assert.equal(model.childRequests.length > 0, true, `${filterCase.name} child must still run`);
        assert.equal(
          model.childRequests.every((request) => !request.tools?.some((tool) => tool.name === targetName)),
          true,
          `${filterCase.name} filter must remove fork-local MCP schema: ${JSON.stringify(model.childRequests.map((request) => request.tools?.map((tool) => tool.name)))}`,
        );
        assert.equal(calls, 0, `${filterCase.name} filter must prevent fork-local MCP handler execution`);
      } finally {
        local.dispose();
      }
    }
  } finally {
    await endpoint.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("createLocalGateway delivers SDK async-hook context once through the active turn mailbox", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-async-hook-"));
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });
  await Promise.all([
    writeFile(join(projectRoot, "pilotdeck.yaml"), TEST_CONFIG, "utf8"),
    writeFile(join(projectRoot, "note.txt"), "hook context fixture\n", "utf8"),
  ]);
  let invocationId: string | undefined;
  const hookServer = new HostedHookServer({
    UserPromptSubmit: [{
      hooks: [(_input, _toolUseId, options) => {
        invocationId = options.asyncHookId;
        return { async: true, asyncTimeout: 5 };
      }],
    }],
  });
  const model = new AsyncHookContextModel();
  const local = createLocalGateway({
    projectRoot,
    pilotHome: projectRoot,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
    __testModelFactory: () => model,
  });
  try {
    const endpoint = await hookServer.start();
    const events: any[] = [];
    const stream = local.gateway.submitTurn({
      sessionKey: "sdk:async-hook",
      workspaceCwd: projectRoot,
      channelKey: "test",
      message: "Use the note file.",
      mode: "bypassPermissions",
      sdkSessionConfig: { hooks: endpoint, includeHookEvents: true },
    })[Symbol.asyncIterator]();

    while (!invocationId || model.requests.length === 0) {
      const next = await stream.next();
      assert.equal(next.done, false, "the hook must defer while the turn is active");
      events.push(next.value);
    }
    assert.ok(invocationId);
    assert.deepEqual(await local.gateway.submitAsyncHookResult!({
      sessionKey: "sdk:async-hook",
      invocationId,
      output: {
        hookSpecificOutput: {
          hookEventName: "UserPromptSubmit",
          additionalContext: "Use the current deployment policy.",
        },
      },
    }), { invocationId, status: "delivered" });
    assert.deepEqual(await local.gateway.submitAsyncHookResult!({
      sessionKey: "sdk:async-hook",
      invocationId,
      output: { hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: "must not repeat" } },
    }), { invocationId, status: "duplicate" });

    model.release();
    for await (const event of { [Symbol.asyncIterator]: () => stream }) events.push(event);

    assert.equal(events.some((event) => event.type === "hook_async_result" && event.status === "delivered"), true);
    const contextBlock = model.requests[1]?.messages
      .flatMap((message) => message.content)
      .find((block) => block.type === "text" && block.text.includes("<async_hook_context event=\"UserPromptSubmit\">"));
    assert.equal(contextBlock?.type, "text");
    if (contextBlock?.type === "text") {
      assert.equal(contextBlock.text, "<async_hook_context event=\"UserPromptSubmit\">\nUse the current deployment policy.\n</async_hook_context>");
    }
    assert.doesNotMatch(JSON.stringify(model.requests[1]?.messages), /must not repeat/);
  } finally {
    local.dispose();
    await hookServer.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("SDK query keeps its hook host alive through the native SessionEnd lifecycle", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-session-end-hook-"));
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, "pilotdeck.yaml"), TEST_CONFIG, "utf8");
  const received: Array<Record<string, unknown>> = [];
  const local = createLocalGateway({
    projectRoot,
    pilotHome: projectRoot,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
    __testModelFactory: () => new TitleModel(),
  });
  const server = await startGatewayServer({
    gateway: local.gateway,
    port: 0,
    token: "sdk-session-end-hook-token",
  });
  let closeQuery: (() => void) | undefined;
  try {
    const run = query({
      prompt: "Complete the lifecycle hook test.",
      options: {
        gatewayUrl: server.wsUrl,
        authToken: server.token,
        projectKey: projectRoot,
        includeHookEvents: true,
        hooks: {
          SessionEnd: [{
            hooks: [(input) => {
              received.push(input);
              return {};
            }],
          }],
        },
      },
    });
    closeQuery = () => run.close();
    const events: any[] = [];
    for await (const event of run) events.push(event);

    assert.equal((await run.result()).status, "completed");
    assert.equal(received.length, 1);
    assert.equal(received[0]?.hook_event_name, "SessionEnd");
    assert.equal(typeof received[0]?.session_id, "string");
    assert.equal((received[0]?.session_id as string).length > 0, true);
    assert.equal(events.some((event) => event.type === "hook.started" && event.hookEvent === "SessionEnd"), true);
    assert.equal(events.some((event) => event.type === "hook.response" && event.hookEvent === "SessionEnd"), true);
  } finally {
    closeQuery?.();
    await server.close();
    local.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("SDK query projects the supported native lifecycle hook sequence", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-lifecycle-hooks-"));
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, "pilotdeck.yaml"), TEST_CONFIG, "utf8");
  const expected = [
    "SessionStart",
    "Setup",
    "UserPromptSubmit",
    "InstructionsLoaded",
    "PreModelRequest",
    "Stop",
    "SessionEnd",
  ] as const;
  const beforeModelExpected = new Set([
    "SessionStart",
    "Setup",
    "UserPromptSubmit",
    "InstructionsLoaded",
    "PreModelRequest",
  ]);
  const received: string[] = [];
  const observed = new Set<string>();
  let resolveLifecycleHooks: (() => void) | undefined;
  const lifecycleHooksObserved = new Promise<void>((resolve) => {
    resolveLifecycleHooks = resolve;
  });
  const hooks = Object.fromEntries(expected.map((event) => [event, [{
    hooks: [(input: Record<string, unknown>) => {
      const hookEvent = String(input.hook_event_name);
      received.push(hookEvent);
      observed.add(hookEvent);
      if ([...beforeModelExpected].every((expectedEvent) => observed.has(expectedEvent))) {
        resolveLifecycleHooks?.();
      }
      return {};
    }],
  }]]));
  const local = createLocalGateway({
    projectRoot,
    pilotHome: projectRoot,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
    __testModelFactory: () => new LifecycleHookModel(lifecycleHooksObserved),
  });
  const server = await startGatewayServer({
    gateway: local.gateway,
    port: 0,
    token: "sdk-lifecycle-hooks-token",
  });
  let closeQuery: (() => void) | undefined;
  try {
    const run = query({
      prompt: "Verify native lifecycle delivery.",
      options: {
        gatewayUrl: server.wsUrl,
        authToken: server.token,
        projectKey: projectRoot,
        includeHookEvents: true,
        hooks,
      },
    });
    closeQuery = () => run.close();
    const events: any[] = [];
    for await (const event of run) events.push(event);

    assert.equal((await run.result()).status, "completed");
    assert.deepEqual(new Set(received), new Set(expected));
    for (const hookEvent of expected) {
      assert.equal(events.some((event) => event.type === "hook.started" && event.hookEvent === hookEvent), true, `${hookEvent} start`);
      assert.equal(events.some((event) => event.type === "hook.response" && event.hookEvent === hookEvent), true, `${hookEvent} response`);
    }
  } finally {
    closeQuery?.();
    await server.close();
    local.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("SDK query projects ConfigChange through a Gateway-owned local settings reload", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-config-change-hook-"));
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, "pilotdeck.yaml"), TEST_CONFIG, "utf8");
  const received: Array<Record<string, unknown>> = [];
  let asyncInvocationId: string | undefined;
  let resolveSessionStart: (() => void) | undefined;
  const sessionStarted = new Promise<void>((resolve) => {
    resolveSessionStart = resolve;
  });
  let resolveConfigChange: (() => void) | undefined;
  const configChangeObserved = new Promise<void>((resolve) => {
    resolveConfigChange = resolve;
  });
  const model = new ConfigChangeHookModel(configChangeObserved);
  const local = createLocalGateway({
    projectRoot,
    pilotHome: projectRoot,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
    __testModelFactory: () => model,
  });
  const server = await startGatewayServer({
    gateway: local.gateway,
    port: 0,
    token: "sdk-config-change-hook-token",
  });
  let closeQuery: (() => void) | undefined;
  try {
    const run = query({
      prompt: "Observe a configuration reload.",
      options: {
        gatewayUrl: server.wsUrl,
        authToken: server.token,
        projectKey: projectRoot,
        includeHookEvents: true,
        hooks: {
          SessionStart: [{
            hooks: [() => {
              resolveSessionStart?.();
              return {};
            }],
          }],
          ConfigChange: [{
            hooks: [(input, _toolUseId, hookOptions) => {
              received.push(input);
              asyncInvocationId = hookOptions.asyncHookId;
              resolveConfigChange?.();
              return { async: true, asyncTimeout: 5 };
            }],
          }],
        },
      },
    });
    closeQuery = () => run.close();
    const stream = run[Symbol.asyncIterator]();
    const firstEvent = stream.next();
    await waitForLifecycleHook(sessionStarted);
    await run.updateSettings("localSettings", { agent: { maxOutputTokens: 1024 } });
    assert.equal(local.configStore.getSnapshot().config.agent.maxOutputTokens, 1024);
    await waitForLifecycleHook(configChangeObserved);
    assert.ok(asyncInvocationId);
    assert.deepEqual(await run.submitAsyncHookResult(asyncInvocationId, {
      hookSpecificOutput: {
        hookEventName: "ConfigChange",
        additionalContext: "Config reload output must not enter the active turn.",
      },
    }), { invocationId: asyncInvocationId, status: "unknown" });

    const events: any[] = [];
    const initial = await firstEvent;
    if (!initial.done) events.push(initial.value);
    for await (const event of { [Symbol.asyncIterator]: () => stream }) events.push(event);

    assert.equal((await run.result()).status, "completed");
    assert.equal(received.length, 1);
    assert.equal(received[0]?.hook_event_name, "ConfigChange");
    assert.deepEqual(received[0]?.changed_paths, ["agent.maxOutputTokens"]);
    assert.deepEqual(received[0]?.change_classes, ["next-request"]);
    assert.equal(events.some((event) => event.type === "hook.started" && event.hookEvent === "ConfigChange"), true);
    assert.equal(events.some((event) => event.type === "hook.response" && event.hookEvent === "ConfigChange"), true);
  } finally {
    closeQuery?.();
    await server.close();
    local.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("SDK query projects StopFailure without closing its hook host before the native failure lifecycle", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-stop-failure-hook-"));
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, "pilotdeck.yaml"), TEST_CONFIG, "utf8");
  const received: Array<Record<string, unknown>> = [];
  const local = createLocalGateway({
    projectRoot,
    pilotHome: projectRoot,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
    __testModelFactory: () => new StopFailureHookModel(),
  });
  const server = await startGatewayServer({
    gateway: local.gateway,
    port: 0,
    token: "sdk-stop-failure-hook-token",
  });
  let closeQuery: (() => void) | undefined;
  try {
    const run = query({
      prompt: "Trigger a deterministic model failure.",
      options: {
        gatewayUrl: server.wsUrl,
        authToken: server.token,
        projectKey: projectRoot,
        includeHookEvents: true,
        hooks: {
          StopFailure: [{
            hooks: [(input: Record<string, unknown>) => {
              received.push(input);
              return {};
            }],
          }],
        },
      },
    });
    closeQuery = () => run.close();
    const events: any[] = [];
    for await (const event of run) events.push(event);

    assert.equal(received.length, 1);
    assert.equal(received[0]?.hook_event_name, "StopFailure");
    assert.deepEqual(received[0]?.error, {
      provider: "test",
      model: "test",
      protocol: "openai",
      code: "invalid_request_error",
      message: "The test provider rejected the request.",
      retryable: false,
    });
    assert.equal(events.some((event) => event.type === "hook.started" && event.hookEvent === "StopFailure"), true);
    assert.equal(events.some((event) => event.type === "hook.response" && event.hookEvent === "StopFailure"), true);
    assert.equal(events.some((event) => event.type === "error"), true);
    assert.equal((await run.result()).status, "failed");
  } finally {
    closeQuery?.();
    await server.close();
    local.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("SDK query projects PreCompact and PostCompact through a Gateway-owned auto compaction", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-compaction-hooks-"));
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, "pilotdeck.yaml"), COMPACTION_TEST_CONFIG, "utf8");
  const local = createLocalGateway({
    projectRoot,
    pilotHome: projectRoot,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
    __testModelFactory: () => new TitleModel(),
  });
  const server = await startGatewayServer({
    gateway: local.gateway,
    port: 0,
    token: "sdk-compaction-hooks-token",
  });
  let closeRun: (() => void) | undefined;
  try {
    const historySegment = "Prior implementation detail ".repeat(600);
    let sessionId: string | undefined;
    for (const prompt of [historySegment, historySegment, historySegment, historySegment]) {
      const warmup = query({
        prompt,
        options: {
          gatewayUrl: server.wsUrl,
          authToken: server.token,
          projectKey: projectRoot,
          ...(sessionId ? { resume: sessionId } : {}),
        },
      });
      for await (const event of warmup) sessionId ??= event.sessionId;
      assert.equal((await warmup.result()).status, "completed");
      assert.ok(sessionId, "the SDK stream must expose the owning session id");
      warmup.close();
    }

    const received: string[] = [];
    const run = query({
      prompt: historySegment,
      options: {
        gatewayUrl: server.wsUrl,
        authToken: server.token,
        projectKey: projectRoot,
        resume: sessionId,
        includeHookEvents: true,
        hooks: {
          SessionStart: [{ hooks: [(input) => { received.push(String(input.hook_event_name)); return {}; }] }],
          PreCompact: [{ hooks: [(input) => { received.push(String(input.hook_event_name)); return {}; }] }],
          PostCompact: [{ hooks: [(input) => { received.push(String(input.hook_event_name)); return {}; }] }],
        },
      },
    });
    closeRun = () => run.close();
    const events: any[] = [];
    for await (const event of run) events.push(event);

    assert.equal((await run.result()).status, "completed");
    assert.equal(received[0], "SessionStart");
    const compactionHooks = received.slice(1);
    assert.ok(compactionHooks.length >= 2, "auto compaction must dispatch at least one lifecycle pair");
    assert.equal(compactionHooks.length % 2, 0, "compaction lifecycle hooks must be paired");
    for (let index = 0; index < compactionHooks.length; index += 2) {
      assert.deepEqual(compactionHooks.slice(index, index + 2), ["PreCompact", "PostCompact"]);
    }
    assert.equal(events.some((event) =>
      event.type === "pilotdeck.agent_status"
      && event.event === "turn_continued"
      && (event.detail as { reason?: unknown } | undefined)?.reason === "auto_compact",
    ), true);
    for (const hookEvent of ["SessionStart", "PreCompact", "PostCompact"] as const) {
      assert.equal(events.some((event) => event.type === "hook.started" && event.hookEvent === hookEvent), true, `${hookEvent} start`);
      assert.equal(events.some((event) => event.type === "hook.response" && event.hookEvent === hookEvent), true, `${hookEvent} response`);
    }
  } finally {
    closeRun?.();
    await server.close();
    local.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("SDK query projects permission hook lifecycles when canUseTool denies a write", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-permission-hook-"));
  const projectRoot = join(root, "project");
  const notePath = join(projectRoot, "note.txt");
  await mkdir(projectRoot, { recursive: true });
  await Promise.all([
    writeFile(join(projectRoot, "pilotdeck.yaml"), TEST_CONFIG, "utf8"),
    writeFile(notePath, "before\n", "utf8"),
  ]);
  const received: Array<Record<string, unknown>> = [];
  const local = createLocalGateway({
    projectRoot,
    pilotHome: projectRoot,
    fallbackProjectRoot: projectRoot,
    permissionMode: "default",
    __testModelFactory: () => new PermissionLifecycleModel(),
  });
  const server = await startGatewayServer({
    gateway: local.gateway,
    port: 0,
    token: "sdk-permission-hook-token",
  });
  let closeQuery: (() => void) | undefined;
  try {
    const run = query({
      prompt: "Attempt a guarded write.",
      options: {
        gatewayUrl: server.wsUrl,
        authToken: server.token,
        projectKey: projectRoot,
        includeHookEvents: true,
        canUseTool: () => ({ behavior: "deny", message: "Writes are disabled for this request." }),
        hooks: {
          PermissionRequest: [{ hooks: [(input: Record<string, unknown>) => { received.push(input); return {}; }] }],
          PermissionDenied: [{ hooks: [(input: Record<string, unknown>) => { received.push(input); return {}; }] }],
        },
      },
    });
    closeQuery = () => run.close();
    const events: any[] = [];
    for await (const event of run) events.push(event);

    assert.deepEqual(received.map((input) => input.hook_event_name), ["PermissionRequest", "PermissionDenied"]);
    assert.equal(received.every((input) => input.tool_name === "write_file"), true);
    assert.equal(events.some((event) => event.type === "permission.requested" && event.toolName === "write_file"), true);
    assert.equal(events.some((event) => event.type === "permission.denied" && event.toolName === "write_file"), true);
    for (const hookEvent of ["PermissionRequest", "PermissionDenied"]) {
      assert.equal(events.some((event) => event.type === "hook.started" && event.hookEvent === hookEvent), true, `${hookEvent} start`);
      assert.equal(events.some((event) => event.type === "hook.response" && event.hookEvent === hookEvent), true, `${hookEvent} response`);
    }
    assert.equal((await run.result()).status, "completed");
    assert.equal(await readFile(notePath, "utf8"), "before\n");
  } finally {
    closeQuery?.();
    await server.close();
    local.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("SDK query runs PreToolUse input rewrites and PostToolUse with the native effective input", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-tool-lifecycle-hooks-"));
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });
  await Promise.all([
    writeFile(join(projectRoot, "pilotdeck.yaml"), TEST_CONFIG, "utf8"),
    writeFile(join(projectRoot, "original.txt"), "original content\n", "utf8"),
    writeFile(join(projectRoot, "rewritten.txt"), "rewritten content\n", "utf8"),
  ]);
  const received: Array<Record<string, unknown>> = [];
  const local = createLocalGateway({
    projectRoot,
    pilotHome: projectRoot,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
    __testModelFactory: () => new ToolLifecycleHookModel(),
  });
  const server = await startGatewayServer({
    gateway: local.gateway,
    port: 0,
    token: "sdk-tool-lifecycle-hook-token",
  });
  let closeQuery: (() => void) | undefined;
  try {
    const run = query({
      prompt: "Read the lifecycle-controlled file.",
      options: {
        gatewayUrl: server.wsUrl,
        authToken: server.token,
        projectKey: projectRoot,
        includeHookEvents: true,
        hooks: {
          PreToolUse: [{
            hooks: [(input) => {
              received.push(input);
              return {
                hookSpecificOutput: {
                  hookEventName: "PreToolUse",
                  updatedInput: { file_path: "rewritten.txt" },
                },
              };
            }],
          }],
          PostToolUse: [{ hooks: [(input) => { received.push(input); return {}; }] }],
        },
      },
    });
    closeQuery = () => run.close();
    const events: any[] = [];
    for await (const event of run) events.push(event);

    assert.deepEqual(received.map((input) => input.hook_event_name), ["PreToolUse", "PostToolUse"]);
    assert.deepEqual(received[0]?.tool_input, { file_path: "original.txt" });
    assert.deepEqual(received[1]?.tool_input, { file_path: "rewritten.txt" });
    for (const hookEvent of ["PreToolUse", "PostToolUse"] as const) {
      assert.equal(events.some((event) => event.type === "hook.started" && event.hookEvent === hookEvent), true, `${hookEvent} start`);
      assert.equal(events.some((event) => event.type === "hook.response" && event.hookEvent === hookEvent), true, `${hookEvent} response`);
    }
    const result = await run.result();
    assert.equal(result.status, "completed");
    assert.match(String(result.output), /rewritten content/);
  } finally {
    closeQuery?.();
    await server.close();
    local.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("SDK query projects PostToolUseFailure after a native tool error", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-tool-failure-hook-"));
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, "pilotdeck.yaml"), TEST_CONFIG, "utf8");
  const received: Array<Record<string, unknown>> = [];
  const local = createLocalGateway({
    projectRoot,
    pilotHome: projectRoot,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
    __testModelFactory: () => new ToolFailureLifecycleHookModel(),
  });
  const server = await startGatewayServer({
    gateway: local.gateway,
    port: 0,
    token: "sdk-tool-failure-hook-token",
  });
  let closeQuery: (() => void) | undefined;
  try {
    const run = query({
      prompt: "Read the missing lifecycle file.",
      options: {
        gatewayUrl: server.wsUrl,
        authToken: server.token,
        projectKey: projectRoot,
        includeHookEvents: true,
        hooks: {
          PostToolUseFailure: [{ hooks: [(input) => { received.push(input); return {}; }] }],
        },
      },
    });
    closeQuery = () => run.close();
    const events: any[] = [];
    for await (const event of run) events.push(event);

    assert.equal(received.length, 1);
    assert.equal(received[0]?.hook_event_name, "PostToolUseFailure");
    assert.equal(received[0]?.tool_name, "read_file");
    assert.deepEqual(received[0]?.tool_input, { file_path: "missing.txt" });
    assert.equal(typeof received[0]?.error, "string");
    assert.equal(events.some((event) => event.type === "tool.failed" && event.toolName === "read_file"), true);
    assert.equal(events.some((event) => event.type === "hook.started" && event.hookEvent === "PostToolUseFailure"), true);
    assert.equal(events.some((event) => event.type === "hook.response" && event.hookEvent === "PostToolUseFailure"), true);
    const result = await run.result();
    assert.equal(result.status, "completed");
    assert.equal(result.output, "tool failure lifecycle observed");
  } finally {
    closeQuery?.();
    await server.close();
    local.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("SDK query bridges native elicitation and Elicitation lifecycle hooks", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-elicitation-hook-"));
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, "pilotdeck.yaml"), TEST_CONFIG, "utf8");
  const hookInputs: Array<Record<string, unknown>> = [];
  const elicitationRequests: any[] = [];
  const local = createLocalGateway({
    projectRoot,
    pilotHome: projectRoot,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
    __testModelFactory: () => new ElicitationLifecycleHookModel(),
  });
  const server = await startGatewayServer({
    gateway: local.gateway,
    port: 0,
    token: "sdk-elicitation-hook-token",
  });
  let closeQuery: (() => void) | undefined;
  try {
    const run = query({
      prompt: "Request an elicitation answer.",
      options: {
        gatewayUrl: server.wsUrl,
        authToken: server.token,
        projectKey: projectRoot,
        includeHookEvents: true,
        onElicitation: (request) => {
          elicitationRequests.push(request);
          return {
            action: "accept",
            content: { answers: { "Which delivery mode?": "Safe" } },
          };
        },
        hooks: {
          Elicitation: [{ hooks: [(input) => { hookInputs.push(input); return {}; }] }],
          ElicitationResult: [{ hooks: [(input) => { hookInputs.push(input); return {}; }] }],
        },
      },
    });
    closeQuery = () => run.close();
    const events: any[] = [];
    for await (const event of run) events.push(event);

    assert.equal(elicitationRequests.length, 1);
    assert.equal(elicitationRequests[0]?.questions.length, 1);
    assert.equal(elicitationRequests[0]?.questions[0]?.question, "Which delivery mode?");
    assert.deepEqual(hookInputs.map((input) => input.hook_event_name), ["Elicitation", "ElicitationResult"]);
    assert.equal(hookInputs.every((input) => input.tool_name === "ask_user_question" || input.delivered === true), true);
    for (const hookEvent of ["Elicitation", "ElicitationResult"] as const) {
      assert.equal(events.some((event) => event.type === "hook.started" && event.hookEvent === hookEvent), true, `${hookEvent} start`);
      assert.equal(events.some((event) => event.type === "hook.response" && event.hookEvent === hookEvent), true, `${hookEvent} response`);
    }
    const result = await run.result();
    assert.equal(result.status, "completed");
    assert.match(String(result.output), /Which delivery mode\?"="Safe"/);
  } finally {
    closeQuery?.();
    await server.close();
    local.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("SDK query adapts native elicitation through onUserDialog without a permission handler", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-user-dialog-elicitation-"));
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, "pilotdeck.yaml"), TEST_CONFIG, "utf8");
  const dialogs: any[] = [];
  const local = createLocalGateway({
    projectRoot,
    pilotHome: projectRoot,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
    __testModelFactory: () => new ElicitationLifecycleHookModel(),
  });
  const server = await startGatewayServer({
    gateway: local.gateway,
    port: 0,
    token: "sdk-user-dialog-elicitation-token",
  });
  let closeQuery: (() => void) | undefined;
  try {
    const run = query({
      prompt: "Request a dialog answer.",
      options: {
        gatewayUrl: server.wsUrl,
        authToken: server.token,
        projectKey: projectRoot,
        supportedDialogKinds: ["elicitation"],
        onUserDialog: (request) => {
          dialogs.push(request);
          return {
            behavior: "answered",
            value: { answers: { "Which delivery mode?": "Fast" } },
          };
        },
      },
    });
    closeQuery = () => run.close();
    for await (const _event of run) { /* consume */ }

    assert.equal(dialogs.length, 1);
    assert.equal(dialogs[0]?.dialogKind, "elicitation");
    assert.equal(dialogs[0]?.payload.questions[0]?.question, "Which delivery mode?");
    const result = await run.result();
    assert.equal(result.status, "completed");
    assert.match(String(result.output), /Which delivery mode\?"="Fast"/);
  } finally {
    closeQuery?.();
    await server.close();
    local.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("SDK query projects native SubagentStart and SubagentStop hook lifecycles", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-subagent-lifecycle-hooks-"));
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, "pilotdeck.yaml"), TEST_CONFIG, "utf8");
  const received: Array<Record<string, unknown>> = [];
  const model = new AgentDefinitionScopeModel();
  const local = createLocalGateway({
    projectRoot,
    pilotHome: projectRoot,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
    __testModelFactory: () => model,
  });
  const server = await startGatewayServer({
    gateway: local.gateway,
    port: 0,
    token: "sdk-subagent-lifecycle-hooks-token",
  });
  let closeQuery: (() => void) | undefined;
  try {
    const run = query({
      prompt: "Delegate a bounded review.",
      options: {
        gatewayUrl: server.wsUrl,
        authToken: server.token,
        projectKey: projectRoot,
        includeHookEvents: true,
        agents: {
          reviewer: {
            description: "Review the scoped integration.",
            prompt: "SDK AGENT SCOPE MARKER",
            tools: [],
          },
        },
        hooks: {
          SubagentStart: [{ hooks: [(input) => {
            received.push(input);
            return {};
          }] }],
          SubagentStop: [{ hooks: [(input) => {
            received.push(input);
            return {};
          }] }],
        },
      },
    });
    closeQuery = () => run.close();
    const events: any[] = [];
    for await (const event of run) events.push(event);

    assert.equal((await run.result()).status, "completed");
    assert.deepEqual(received.map((input) => input.hook_event_name), ["SubagentStart", "SubagentStop"]);
    assert.equal(received[0]?.subagent_type, "reviewer");
    assert.equal(received[1]?.subagent_type, "reviewer");
    assert.equal(received[1]?.success, true);
    for (const hookEvent of ["SubagentStart", "SubagentStop"] as const) {
      assert.equal(events.some((event) => event.type === "hook.started" && event.hookEvent === hookEvent), true, `${hookEvent} start`);
      assert.equal(events.some((event) => event.type === "hook.response" && event.hookEvent === hookEvent), true, `${hookEvent} response`);
    }
  } finally {
    closeQuery?.();
    await server.close();
    local.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("SDK forwardSubagentText exposes child text without affecting the parent result", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-forward-subagent-text-"));
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, "pilotdeck.yaml"), TEST_CONFIG, "utf8");
  const local = createLocalGateway({
    projectRoot,
    pilotHome: projectRoot,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
    __testModelFactory: () => new ForwardSubagentTextModel(),
  });
  const server = await startGatewayServer({
    gateway: local.gateway,
    port: 0,
    token: "sdk-forward-subagent-text-token",
  });
  let closeQuery: (() => void) | undefined;
  try {
    const run = query({
      prompt: "Delegate one short report.",
      options: {
        gatewayUrl: server.wsUrl,
        authToken: server.token,
        projectKey: projectRoot,
        forwardSubagentText: true,
        agents: {
          reviewer: {
            description: "Return the delegated report.",
            prompt: "SDK FORWARD SUBAGENT TEXT MARKER",
            tools: [],
          },
        },
      },
    });
    closeQuery = () => run.close();
    const events: any[] = [];
    for await (const event of run) events.push(event);

    const child = events.find((event) => event.type === "subagent.message");
    assert.equal(child?.text, "child streamed result");
    assert.equal(child?.subagentType, "reviewer");
    assert.equal(typeof child?.subagentId, "string");
    assert.equal(typeof child?.runId, "string");
    assert.equal(events.some((event) => event.type === "assistant.message"), false);
    const result = await run.result();
    assert.equal(result.status, "completed");
    assert.equal(result.output, "parent final result");
    assert.equal(result.finishReason, "completed");
  } finally {
    closeQuery?.();
    await server.close();
    local.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("createLocalGateway emits SDK FileChanged hooks after a successful native file write", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-file-changed-hook-"));
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });
  await Promise.all([
    writeFile(join(projectRoot, "pilotdeck.yaml"), TEST_CONFIG, "utf8"),
    writeFile(join(projectRoot, "note.txt"), "before\n", "utf8"),
  ]);
  const inputs: Array<Record<string, unknown>> = [];
  const hookServer = new HostedHookServer({
    FileChanged: [{
      hooks: [(input) => {
        inputs.push(input);
        return {};
      }],
    }],
  });
  const local = createLocalGateway({
    projectRoot,
    pilotHome: projectRoot,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
    __testModelFactory: () => new CheckpointWriteModel(),
  });
  try {
    const endpoint = await hookServer.start();
    const events: any[] = [];
    for await (const event of local.gateway.submitTurn({
      sessionKey: "sdk:file-changed",
      workspaceCwd: projectRoot,
      channelKey: "test",
      message: "Update the note file.",
      mode: "bypassPermissions",
      sdkSessionConfig: { hooks: endpoint, includeHookEvents: true },
    })) events.push(event);

    assert.equal(await readFile(join(projectRoot, "note.txt"), "utf8"), "after\n");
    assert.equal(inputs.length, 1);
    assert.deepEqual(inputs[0], {
      session_id: "sdk:file-changed",
      transcript_path: "",
      cwd: projectRoot,
      hook_event_name: "FileChanged",
      file_path: "note.txt",
      absolute_path: join(projectRoot, "note.txt"),
      root: projectRoot,
      change_type: "updated",
    });
    assert.equal(events.some((event) => event.type === "hook_started" && event.hookEvent === "FileChanged"), true);
    assert.equal(events.some((event) => event.type === "hook_response" && event.hookEvent === "FileChanged"), true);
  } finally {
    local.dispose();
    await hookServer.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("createLocalGateway accepts one context-only async result from an SDK FileChanged hook", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-async-file-changed-hook-"));
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });
  await Promise.all([
    writeFile(join(projectRoot, "pilotdeck.yaml"), TEST_CONFIG, "utf8"),
    writeFile(join(projectRoot, "note.txt"), "before async hook\n", "utf8"),
  ]);
  let invocationId: string | undefined;
  const hookServer = new HostedHookServer({
    FileChanged: [{
      hooks: [(_input, _toolUseId, options) => {
        invocationId = options.asyncHookId;
        return { async: true, asyncTimeout: 5 };
      }],
    }],
  });
  const model = new AsyncFileChangedHookModel();
  const local = createLocalGateway({
    projectRoot,
    pilotHome: projectRoot,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
    __testModelFactory: () => model,
  });
  try {
    const endpoint = await hookServer.start();
    const events: any[] = [];
    const stream = local.gateway.submitTurn({
      sessionKey: "sdk:async-file-changed",
      workspaceCwd: projectRoot,
      channelKey: "test",
      message: "Update the note file.",
      mode: "bypassPermissions",
      sdkSessionConfig: { hooks: endpoint, includeHookEvents: true },
    })[Symbol.asyncIterator]();

    while (!invocationId || model.requests.length < 3) {
      const next = await stream.next();
      assert.equal(next.done, false, "the next model request must remain active until the async result arrives");
      events.push(next.value);
    }
    assert.ok(invocationId);
    assert.deepEqual(await local.gateway.submitAsyncHookResult!({
      sessionKey: "sdk:async-file-changed",
      invocationId,
      output: {
        hookSpecificOutput: {
          hookEventName: "FileChanged",
          additionalContext: "Re-read note.txt before using its new content.",
        },
      },
    }), { invocationId, status: "delivered" });
    assert.deepEqual(await local.gateway.submitAsyncHookResult!({
      sessionKey: "sdk:async-file-changed",
      invocationId,
      output: {
        hookSpecificOutput: {
          hookEventName: "FileChanged",
          additionalContext: "must not repeat",
        },
      },
    }), { invocationId, status: "duplicate" });

    model.release();
    for await (const event of { [Symbol.asyncIterator]: () => stream }) events.push(event);

    assert.equal(await readFile(join(projectRoot, "note.txt"), "utf8"), "after async hook\n");
    assert.equal(events.some((event) => event.type === "hook_started" && event.hookEvent === "FileChanged"), true);
    assert.equal(events.some((event) => event.type === "hook_response" && event.hookEvent === "FileChanged"), true);
    assert.equal(events.some((event) => event.type === "hook_async_result" && event.hookEvent === "FileChanged" && event.status === "delivered"), true);
    const contextBlock = model.requests[3]?.messages
      .flatMap((message) => message.content)
      .find((block) => block.type === "text" && block.text.includes("<async_hook_context event=\"FileChanged\">"));
    assert.equal(contextBlock?.type, "text");
    if (contextBlock?.type === "text") {
      assert.equal(contextBlock.text, "<async_hook_context event=\"FileChanged\">\nRe-read note.txt before using its new content.\n</async_hook_context>");
    }
    assert.doesNotMatch(JSON.stringify(model.requests[3]?.messages), /must not repeat/);
  } finally {
    local.dispose();
    await hookServer.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("Gateway updateSettings persists the allowlisted SDK settings and reloads the host snapshot", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-update-settings-"));
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, "pilotdeck.yaml"), TEST_CONFIG, "utf8");
  const local = createLocalGateway({
    projectRoot,
    pilotHome: projectRoot,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
  });
  try {
    const result = await local.gateway.updateSettings!({
      source: "localSettings",
      settings: {
        agent: {
          maxContextTokens: 4096,
          thinking: { enabled: true, budgetTokens: 1024 },
          subagents: { default: "test/test", timeoutMs: 3000 },
        },
        extension: { includeHookEvents: true, builtinPluginsEnabled: { sdk_test: true } },
        tools: { webSearch: { enabled: false } },
      },
    });
    assert.deepEqual(result.applied, [
      "agent.maxContextTokens",
      "agent.thinking",
      "agent.subagents.default",
      "agent.subagents.timeoutMs",
      "extension.includeHookEvents",
      "extension.builtinPluginsEnabled",
      "tools.webSearch.enabled",
    ]);
    assert.equal(local.configStore.getSnapshot().config.agent.maxContextTokens, 4096);
    assert.deepEqual(local.configStore.getSnapshot().config.agent.thinking, { enabled: true, budgetTokens: 1024 });
    assert.equal(local.configStore.getSnapshot().config.agent.subagents?.default?.id, "test/test");
    assert.equal(local.configStore.getSnapshot().config.agent.subagents?.timeoutMs, 3000);
    assert.equal(local.configStore.getSnapshot().config.extension.includeHookEvents, true);
    assert.deepEqual(local.configStore.getSnapshot().config.extension.builtinPluginsEnabled, { sdk_test: true });
    assert.equal(local.configStore.getSnapshot().config.tools?.webSearch?.enabled, false);
  } finally {
    local.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("Gateway resolveSettings exposes its current config snapshot with model credentials redacted", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-resolve-settings-"));
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, "pilotdeck.yaml"), TEST_CONFIG, "utf8");
  const local = createLocalGateway({ projectRoot, pilotHome: projectRoot, fallbackProjectRoot: projectRoot });
  try {
    const resolved = await local.gateway.resolveSettings!();
    assert.equal(resolved.schemaVersion, 1);
    assert.equal((resolved.config.model as any).providers.test.apiKey, "<redacted>");
    assert.equal(resolved.sources.some((source) => source.path === join(projectRoot, "pilotdeck.yaml")), true);
  } finally {
    local.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("Gateway emits an opt-in prompt suggestion without persisting it to the transcript", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-prompt-suggestion-"));
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, "pilotdeck.yaml"), TEST_CONFIG, "utf8");
  const model = new PromptSuggestionModel();
  const local = createLocalGateway({
    projectRoot,
    pilotHome: projectRoot,
    fallbackProjectRoot: projectRoot,
    __testModelFactory: () => model,
  });
  try {
    const disabled: any[] = [];
    for await (const event of local.gateway.submitTurn({
      sessionKey: "sdk:prompt-suggestion-off",
      workspaceCwd: projectRoot,
      channelKey: "test",
      message: "完成这个改动",
    })) disabled.push(event);
    assert.equal(disabled.some((event) => event.type === "prompt_suggestion"), false);
    assert.equal(
      model.completeRequests.some((request) => request.metadata?.purpose === "prompt_suggestion_generation"),
      false,
    );

    const enabled: any[] = [];
    for await (const event of local.gateway.submitTurn({
      sessionKey: "sdk:prompt-suggestion-on",
      workspaceCwd: projectRoot,
      channelKey: "test",
      message: "完成这个改动",
      sdkSessionConfig: { promptSuggestions: true },
    })) enabled.push(event);

    const suggestion = enabled.find((event) => event.type === "prompt_suggestion");
    assert.equal(suggestion?.suggestion, "请运行相关测试并汇报结果");
    assert.ok(
      enabled.findIndex((event) => event.type === "prompt_suggestion")
        < enabled.findIndex((event) => event.type === "turn_completed"),
      "the terminal event must remain last",
    );
    const generation = model.completeRequests.find((request) => request.metadata?.purpose === "prompt_suggestion_generation");
    assert.equal(generation?.metadata?.sessionId, "sdk:prompt-suggestion-on");
    assert.match(
      generation?.messages[0]?.content[0]?.type === "text"
        ? generation.messages[0].content[0].text
        : "",
      /完成这个改动[\s\S]*The implementation is complete\./,
    );
    const storage = createAgentProjectSessionStorage({
      projectRoot,
      pilotHome: projectRoot,
      sessionId: "sdk:prompt-suggestion-on",
    });
    const transcript = await readFile(storage.transcriptPath, "utf8");
    assert.doesNotMatch(transcript, /请运行相关测试并汇报结果/);
  } finally {
    local.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("Gateway exposes the opt-in input dialog only to the owning SDK session", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-input-dialog-"));
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, "pilotdeck.yaml"), TEST_CONFIG, "utf8");
  const model = new InputDialogModel();
  const local = createLocalGateway({
    projectRoot,
    pilotHome: projectRoot,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
    __testModelFactory: () => model,
  });
  try {
    const disabled: any[] = [];
    for await (const event of local.gateway.submitTurn({
      sessionKey: "sdk:input-dialog-disabled",
      workspaceCwd: projectRoot,
      channelKey: "test",
      message: "Ask for a test command.",
      mode: "bypassPermissions",
    })) disabled.push(event);
    assert.equal(model.requests[0]?.tools?.some((tool) => tool.name === "request_user_input"), false);
    assert.equal(disabled.some((event) => event.type === "user_dialog_request"), false);

    model.reset();
    const events: any[] = [];
    let request: Extract<any, { type: "user_dialog_request" }> | undefined;
    for await (const event of local.gateway.submitTurn({
      sessionKey: "sdk:input-dialog-enabled",
      workspaceCwd: projectRoot,
      channelKey: "test",
      message: "Ask for a test command.",
      mode: "bypassPermissions",
      sdkSessionConfig: { userDialogKinds: ["input"] },
    })) {
      events.push(event);
      if (event.type === "user_dialog_request") {
        request = event;
        assert.equal(await local.gateway.respondUserDialog!({
          sessionKey: "sdk:input-dialog-enabled",
          requestId: event.requestId,
          result: { behavior: "answered", value: "pnpm test" },
        }).then((result) => result.delivered), true);
      }
    }

    assert.ok(request, "the enabled session must emit a generic input dialog request");
    assert.equal(request.prompt, "Which test command should I run?");
    assert.equal(request.placeholder, "pnpm test");
    assert.equal(model.requests[0]?.tools?.some((tool) => tool.name === "request_user_input"), true);
    const answer = model.requests[1]?.messages
      .flatMap((message) => message.content)
      .find((block) => block.type === "tool_result" && block.toolCallId === "input-1");
    assert.equal(answer?.type, "tool_result");
    if (answer?.type === "tool_result") {
      assert.equal(answer.toolCallId, "input-1");
      assert.deepEqual(answer.content, [{ type: "text", text: "The user answered: pnpm test" }]);
    }
    assert.equal(events.some((event) => event.type === "turn_completed"), true);
    assert.ok(
      events.findIndex((event) => event.type === "user_dialog_request")
        < events.findIndex((event) => event.type === "turn_completed"),
      "the dialog must be resolved before the turn reaches its terminal event",
    );
    const storage = createAgentProjectSessionStorage({
      projectRoot,
      pilotHome: projectRoot,
      sessionId: "sdk:input-dialog-enabled",
    });
    const transcript = await readFile(storage.transcriptPath, "utf8");
    assert.match(transcript, /request_user_input/);
    assert.match(transcript, /The user answered: pnpm test/);
    assert.doesNotMatch(transcript, /user_dialog_request/);
    assert.deepEqual(await local.gateway.respondUserDialog!({
      sessionKey: "sdk:input-dialog-enabled",
      requestId: request.requestId,
      result: { behavior: "answered", value: "late answer" },
    }), { delivered: false });
  } finally {
    local.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("SDK manual dialog resources list and resolve a live Gateway-owned pending dialog", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-manual-dialog-resource-"));
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, "pilotdeck.yaml"), TEST_CONFIG, "utf8");
  const model = new InputDialogModel();
  const local = createLocalGateway({
    projectRoot,
    pilotHome: projectRoot,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
    __testModelFactory: () => model,
  });
  const server = await startGatewayServer({
    gateway: local.gateway,
    port: 0,
    token: "sdk-manual-dialog-resource-token",
  });
  local.bindServer(server);
  const sessionId = "sdk:manual-dialog-resource";
  const client = createPilotDeckClient({
    gatewayUrl: server.wsUrl,
    authToken: server.token,
    projectKey: projectRoot,
    channelKey: "sdk-manual-dialog-resource",
  });
  const secondClient = createPilotDeckClient({
    gatewayUrl: server.wsUrl,
    authToken: server.token,
    projectKey: projectRoot,
    channelKey: "sdk-manual-dialog-resource-second-renderer",
  });
  let run: ReturnType<typeof query> | undefined;
  let stopWatching: (() => void) | undefined;
  try {
    const changes: import("../../packages/sdk/src/index.js").PilotDeckUserDialogChange[] = [];
    let resolveRequested: ((change: import("../../packages/sdk/src/index.js").PilotDeckUserDialogChange) => void) | undefined;
    let resolveClaimed: ((change: import("../../packages/sdk/src/index.js").PilotDeckUserDialogChange) => void) | undefined;
    let resolveSettled: ((change: import("../../packages/sdk/src/index.js").PilotDeckUserDialogChange) => void) | undefined;
    const requestedChange = new Promise<import("../../packages/sdk/src/index.js").PilotDeckUserDialogChange>((resolve) => { resolveRequested = resolve; });
    const claimedChange = new Promise<import("../../packages/sdk/src/index.js").PilotDeckUserDialogChange>((resolve) => { resolveClaimed = resolve; });
    const settledChange = new Promise<import("../../packages/sdk/src/index.js").PilotDeckUserDialogChange>((resolve) => { resolveSettled = resolve; });
    stopWatching = await secondClient.dialogs.watch({ sessionId }, (change) => {
      changes.push(change);
      if (change.type === "requested") resolveRequested?.(change);
      if (change.type === "lease_changed" && change.action === "claimed") resolveClaimed?.(change);
      if (change.type === "settled") resolveSettled?.(change);
    });
    run = query({
      prompt: "Ask for a test command.",
      options: {
        gatewayUrl: server.wsUrl,
        authToken: server.token,
        projectKey: projectRoot,
        sessionId,
        channelKey: "sdk-manual-dialog-resource",
        permissionMode: "bypassPermissions",
        supportedDialogKinds: ["input"],
        userDialogMode: "manual",
      },
    });

    let requested = false;
    for await (const event of run) {
      if (event.type !== "user_dialog.requested") continue;
      requested = true;
      const sessionId = String(event.sessionId ?? "");
      const requestId = String(event.requestId ?? "");
      assert.ok(sessionId, "the stream must expose the Gateway session id");
      assert.ok(requestId, "the stream must expose the Gateway dialog request id");

      const requestedChangeEvent = await requestedChange;
      assert.equal(requestedChangeEvent.type, "requested");
      if (requestedChangeEvent.type === "requested") {
        assert.equal(requestedChangeEvent.request.requestId, requestId);
        assert.equal(requestedChangeEvent.projectKey, projectRoot);
      }

      const dialogs = await client.dialogs.list({ sessionId });
      assert.deepEqual(dialogs, [{
        requestId,
        dialogKind: "input",
        payload: {
          sessionId,
          toolCallId: "input-1",
          toolName: "request_user_input",
          prompt: "Which test command should I run?",
          placeholder: "pnpm test",
        },
      }]);

      const firstClaim = await client.dialogs.claim({ sessionId, requestId, ttlMs: 10_000 });
      assert.equal(firstClaim.claimed, true);
      if (!firstClaim.claimed) throw new Error("expected first renderer to claim the dialog");
      const claimed = await claimedChange;
      assert.equal(claimed.type, "lease_changed");
      if (claimed.type === "lease_changed") {
        assert.equal(claimed.requestId, requestId);
        assert.equal(claimed.action, "claimed");
      }
      const claimedDialogs = await secondClient.dialogs.list({ sessionId });
      assert.equal(claimedDialogs.length, 1);
      const claimedDialog = claimedDialogs[0];
      assert.ok(claimedDialog && "requestId" in claimedDialog, "the live dialog must remain listable while claimed");
      if (!claimedDialog || !("requestId" in claimedDialog)) throw new Error("expected a live claimed dialog");
      assert.equal(claimedDialog.requestId, requestId);
      assert.match(String(claimedDialog.lease?.expiresAt), /^\d{4}-\d{2}-\d{2}T/);
      const blockedClaim = await secondClient.dialogs.claim({ sessionId, requestId });
      assert.equal(blockedClaim.claimed, false);
      if (!blockedClaim.claimed) assert.equal(blockedClaim.reason, "claimed");
      await assert.rejects(
        () => secondClient.dialogs.respond({
          sessionId,
          requestId,
          result: { behavior: "answered", value: "racing renderer" },
        }),
        (error: unknown) => (error as { code?: unknown }).code === "user_dialog_lease_required",
      );
      assert.deepEqual(await secondClient.dialogs.release({
        sessionId,
        requestId,
        leaseId: "wrong-renderer-lease",
      }), { released: false });
      assert.deepEqual(await client.dialogs.release({
        sessionId,
        requestId,
        leaseId: firstClaim.leaseId,
      }), { released: true });
      const secondClaim = await secondClient.dialogs.claim({ sessionId, requestId });
      assert.equal(secondClaim.claimed, true);
      if (!secondClaim.claimed) throw new Error("expected second renderer to claim the released dialog");
      await assert.rejects(
        () => client.dialogs.respond({
          sessionId,
          requestId,
          leaseId: firstClaim.leaseId,
          result: { behavior: "answered", value: "stale renderer" },
        }),
        (error: unknown) => (error as { code?: unknown }).code === "user_dialog_lease_required",
      );
      assert.deepEqual(await secondClient.dialogs.respond({
        sessionId,
        requestId,
        leaseId: secondClaim.leaseId,
        result: { behavior: "answered", value: "pnpm test" },
      }), { delivered: true });
      const settled = await settledChange;
      assert.equal(settled.type, "settled");
      if (settled.type === "settled") {
        assert.equal(settled.requestId, requestId);
        assert.equal(settled.reason, "answered");
      }
      assert.deepEqual(await client.dialogs.list({ sessionId }), []);
      assert.deepEqual(await run.respondUserDialog(requestId, { behavior: "answered", value: "late answer" }), { delivered: false });
    }

    assert.equal(requested, true, "the manual SDK mode must surface the generic dialog event");
    assert.equal((await run.result()).status, "completed");
    run.close();
    const answer = model.requests[1]?.messages
      .flatMap((message) => message.content)
      .find((block) => block.type === "tool_result" && block.toolCallId === "input-1");
    assert.equal(answer?.type, "tool_result");
    if (answer?.type === "tool_result") {
      assert.deepEqual(answer.content, [{ type: "text", text: "The user answered: pnpm test" }]);
    }
  } finally {
    run?.close();
    stopWatching?.();
    await client.close();
    await secondClient.close();
    await server.close();
    local.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("SDK manual dialog renderer coordinates multiple hosts through Gateway leases", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-manual-dialog-renderer-"));
  const projectRoot = join(root, "project");
  const sessionId = "sdk:manual-dialog-renderer";
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, "pilotdeck.yaml"), TEST_CONFIG, "utf8");
  const model = new InputDialogModel();
  const local = createLocalGateway({
    projectRoot,
    pilotHome: projectRoot,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
    __testModelFactory: () => model,
  });
  const server = await startGatewayServer({
    gateway: local.gateway,
    port: 0,
    token: "sdk-manual-dialog-renderer-token",
  });
  local.bindServer(server);
  const firstClient = createPilotDeckClient({
    gatewayUrl: server.wsUrl,
    authToken: server.token,
    projectKey: projectRoot,
    channelKey: "sdk-manual-dialog-renderer-first",
  });
  const secondClient = createPilotDeckClient({
    gatewayUrl: server.wsUrl,
    authToken: server.token,
    projectKey: projectRoot,
    channelKey: "sdk-manual-dialog-renderer-second",
  });
  let firstRenderer: Awaited<ReturnType<typeof createManualUserDialogRenderer>> | undefined;
  let secondRenderer: Awaited<ReturnType<typeof createManualUserDialogRenderer>> | undefined;
  let run: ReturnType<typeof query> | undefined;
  try {
    let resolveStarted: (() => void) | undefined;
    const firstStarted = new Promise<void>((resolve) => { resolveStarted = resolve; });
    let resolveFirstAnswer: ((value: import("../../packages/sdk/src/index.js").PilotDeckUserDialogResult) => void) | undefined;
    const firstAnswer = new Promise<import("../../packages/sdk/src/index.js").PilotDeckUserDialogResult>((resolve) => { resolveFirstAnswer = resolve; });
    let firstRenderCount = 0;
    let secondRenderCount = 0;
    firstRenderer = await createManualUserDialogRenderer(firstClient, {
      sessionId,
      projectKey: projectRoot,
      render: async () => {
        firstRenderCount += 1;
        resolveStarted?.();
        return await firstAnswer;
      },
    });

    run = query({
      prompt: "Ask for a test command.",
      options: {
        gatewayUrl: server.wsUrl,
        authToken: server.token,
        projectKey: projectRoot,
        sessionId,
        channelKey: "sdk-manual-dialog-renderer-query",
        permissionMode: "bypassPermissions",
        supportedDialogKinds: ["input"],
        userDialogMode: "manual",
      },
    });
    const completed = (async () => {
      for await (const _event of run!) { /* renderer owns the response */ }
      return await run!.result();
    })();

    await firstStarted;
    secondRenderer = await createManualUserDialogRenderer(secondClient, {
      sessionId,
      projectKey: projectRoot,
      render: async () => {
        secondRenderCount += 1;
        return { behavior: "answered", value: "second renderer must not win" };
      },
    });
    resolveFirstAnswer?.({ behavior: "answered", value: "pnpm test" });

    assert.equal((await completed).status, "completed");
    assert.equal(firstRenderCount, 1);
    assert.equal(secondRenderCount, 0, "a second renderer must not render a dialog leased by the first");
    assert.deepEqual(await firstClient.dialogs.list({ sessionId, projectKey: projectRoot }), []);
  } finally {
    run?.close();
    firstRenderer?.close();
    secondRenderer?.close();
    await firstClient.close();
    await secondClient.close();
    await server.close();
    local.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("SDK persists a recovered Gateway dialog answer as context for the next turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-restarted-dialog-"));
  const projectRoot = join(root, "project");
  const sessionId = "sdk:restart-dialog";
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, "pilotdeck.yaml"), TEST_CONFIG, "utf8");
  const first = createLocalGateway({
    projectRoot,
    pilotHome: projectRoot,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
    __testModelFactory: () => new InputDialogModel(),
  });
  const firstIterator = first.gateway.submitTurn({
    sessionKey: sessionId,
    projectKey: projectRoot,
    workspaceCwd: projectRoot,
    channelKey: "sdk-restarted-dialog",
    message: "Ask for a test command.",
    mode: "bypassPermissions",
    sdkSessionConfig: { userDialogKinds: ["input"] },
  })[Symbol.asyncIterator]();
  let firstRequest: Extract<import("../../src/gateway/protocol/types.js").GatewayEvent, { type: "user_dialog_request" }> | undefined;
  let second: ReturnType<typeof createLocalGateway> | undefined;
  let server: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
  let client: ReturnType<typeof createPilotDeckClient> | undefined;
  const recoveryModel = new PromptCaptureModel();
  try {
    for (let index = 0; index < 20; index += 1) {
      const next = await firstIterator.next();
      if (next.done) break;
      if (next.value.type === "user_dialog_request") {
        firstRequest = next.value;
        break;
      }
    }
    assert.ok(firstRequest, "the first Gateway must persist the pending dialog before it disappears");
    const storage = createAgentProjectSessionStorage({ projectRoot, pilotHome: projectRoot, sessionId });
    assert.equal(await stat(`${storage.transcriptPath}.dialogs.json`).then((entry) => entry.isFile()).catch(() => false), true);

    second = createLocalGateway({
      projectRoot,
      pilotHome: projectRoot,
      fallbackProjectRoot: projectRoot,
      permissionMode: "bypassPermissions",
      __testModelFactory: () => recoveryModel,
    });
    server = await startGatewayServer({
      gateway: second.gateway,
      port: 0,
      token: "sdk-restarted-dialog-token",
    });
    client = createPilotDeckClient({
      gatewayUrl: server.wsUrl,
      authToken: server.token,
      projectKey: projectRoot,
      channelKey: "sdk-restarted-dialog",
    });

    const records = await client.dialogs.list({ sessionId });
    assert.equal(records.length, 1);
    const recovered = records[0];
    assert.ok(recovered && "type" in recovered, "the recovered record must be terminal");
    if (!recovered || !("type" in recovered) || recovered.type !== "user_dialog_terminated") {
      throw new Error("expected recovered user dialog");
    }
    assert.equal(recovered.reason, "gateway_restarted");
    assert.match(recovered.terminatedAt, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(recovered.recovery, "next_turn_context");
    assert.deepEqual(recovered.request, {
      requestId: firstRequest.requestId,
      dialogKind: "input",
      payload: {
        sessionId,
        toolCallId: "input-1",
        toolName: "request_user_input",
        prompt: "Which test command should I run?",
        placeholder: "pnpm test",
      },
    });
    assert.deepEqual(await client.dialogs.respond({
      sessionId,
      requestId: firstRequest.requestId,
      result: { behavior: "answered", value: "pnpm test" },
    }), { delivered: true, recovered: true, reason: "gateway_restarted" });
    assert.deepEqual(await client.dialogs.list({ sessionId }), []);

    const recoveredTranscript = await readAgentProjectSessionTranscript(storage);
    const recoveredAnswer = recoveredTranscript.entries.find((entry) => (
      entry.type === "durable_message"
      && entry.message.metadata?.purpose === `gateway_user_dialog_recovery:${firstRequest!.requestId}`
    ));
    assert.ok(recoveredAnswer, "the validated restart answer must be durable before the next turn");
    if (recoveredAnswer?.type === "durable_message") {
      assert.deepEqual(recoveredAnswer.message, {
        role: "user",
        content: [{
          type: "text",
          text: [
            "[Gateway restart dialog recovery]",
            "The Gateway restarted while waiting for request_user_input.",
            "Question: Which test command should I run?",
            "The user answered: pnpm test",
          ].join("\n"),
        }],
        metadata: {
          synthetic: true,
          purpose: `gateway_user_dialog_recovery:${firstRequest.requestId}`,
          toolCallId: "input-1",
        },
      });
    }

    // The original run is not revived. A new turn sees the durable answer as
    // regular model context and then follows the normal AgentLoop lifecycle.
    const nextTurnEvents: import("../../src/gateway/protocol/types.js").GatewayEvent[] = [];
    for await (const event of second.gateway.submitTurn({
      sessionKey: sessionId,
      projectKey: projectRoot,
      workspaceCwd: projectRoot,
      channelKey: "sdk-restarted-dialog",
      message: "Continue without a dialog.",
      mode: "bypassPermissions",
    })) nextTurnEvents.push(event);
    assert.equal(nextTurnEvents.some((event) => event.type === "turn_completed"), true);
    assert.equal(recoveryModel.requests.some((request) => request.messages.some((message) => (
      message.role === "user"
      && message.content.some((block) => block.type === "text" && block.text.includes("The user answered: pnpm test"))
    ))), true, "the next model request must include the recovered answer");

    // A handled restart record cannot be replayed as a second recovery write.
    assert.deepEqual(await client.dialogs.respond({
      sessionId,
      requestId: firstRequest.requestId,
      result: { behavior: "answered", value: "pnpm test" },
    }), { delivered: false });

    // A separate unanswered restart record remains terminal until the next
    // turn deliberately supersedes it.
    createGatewayUserDialogJournal(storage)?.record({ ...firstRequest, requestId: "unacknowledged-restart-dialog" });
    assert.equal((await client.dialogs.list({ sessionId })).length, 1);
    for await (const _event of second.gateway.submitTurn({
      sessionKey: sessionId,
      projectKey: projectRoot,
      workspaceCwd: projectRoot,
      channelKey: "sdk-restarted-dialog",
      message: "Continue without a dialog.",
      mode: "bypassPermissions",
    })) { /* terminal event is covered above */ }
    assert.deepEqual(await client.dialogs.list({ sessionId }), []);
  } finally {
    await client?.close();
    await server?.close();
    await firstIterator.return?.();
    first.dispose();
    second?.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("file host dialog store lets a second Gateway renderer continue the owning live turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-host-dialog-store-"));
  const projectRoot = join(root, "project");
  const sessionId = "sdk:host-dialog-store";
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, "pilotdeck.yaml"), TEST_CONFIG, "utf8");

  const store = new FileGatewayUserDialogStore({ directory: join(root, "host-dialog-store") });
  const storeKey: GatewayUserDialogStoreKey = { projectRoot, pilotHome: projectRoot, sessionId };
  const model = new InputDialogModel();
  const first = createLocalGateway({
    projectRoot,
    pilotHome: projectRoot,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
    userDialogStore: store,
    __testModelFactory: () => model,
  });
  let second: ReturnType<typeof createLocalGateway> | undefined;
  let server: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
  let client: ReturnType<typeof createPilotDeckClient> | undefined;
  const iterator = first.gateway.submitTurn({
    sessionKey: sessionId,
    projectKey: projectRoot,
    workspaceCwd: projectRoot,
    channelKey: "sdk-host-dialog-store",
    message: "Ask through the host dialog store.",
    mode: "bypassPermissions",
    sdkSessionConfig: { userDialogKinds: ["input"] },
  })[Symbol.asyncIterator]();
  try {
    let request: Extract<import("../../src/gateway/protocol/types.js").GatewayEvent, { type: "user_dialog_request" }> | undefined;
    for (let index = 0; index < 20; index += 1) {
      const next = await iterator.next();
      if (next.done) break;
      if (next.value.type === "user_dialog_request") {
        request = next.value;
        break;
      }
    }
    assert.ok(request);
    assert.equal((await store.list(storeKey)).length, 1, "the host store owns a durable pending record");

    // The renderer Gateway has no local journal. It discovers the owner's
    // pending request exclusively through the injected persistent store.
    const storage = createAgentProjectSessionStorage({ projectRoot, pilotHome: projectRoot, sessionId });
    await rm(`${storage.transcriptPath}.dialogs.json`, { force: true });
    second = createLocalGateway({
      projectRoot,
      pilotHome: projectRoot,
      fallbackProjectRoot: projectRoot,
      permissionMode: "bypassPermissions",
      userDialogStore: store,
      __testModelFactory: () => new PromptCaptureModel(),
    });
    server = await startGatewayServer({ gateway: second.gateway, port: 0, token: "sdk-host-dialog-store-token" });
    client = createPilotDeckClient({
      gatewayUrl: server.wsUrl,
      authToken: server.token,
      projectKey: projectRoot,
      channelKey: "sdk-host-dialog-store",
    });
    const dialogs = await client.dialogs.list({ sessionId });
    assert.equal(dialogs.length, 1);
    assert.ok(dialogs[0] && !("type" in dialogs[0]), "a complete host protocol exposes a live dialog");
    const claim = await client.dialogs.claim({ sessionId, requestId: request!.requestId, ttlMs: 1_000 });
    assert.equal(claim.claimed, true);
    if (!claim.claimed) throw new Error("expected host lease");

    assert.deepEqual(await client.dialogs.respond({
      sessionId,
      requestId: request!.requestId,
      leaseId: claim.leaseId,
      result: { behavior: "answered", value: "pnpm test" },
    }), { delivered: true });

    const completed: import("../../src/gateway/protocol/types.js").GatewayEvent[] = [];
    for (let index = 0; index < 60; index += 1) {
      const next = await Promise.race([
        iterator.next(),
        new Promise<IteratorResult<import("../../src/gateway/protocol/types.js").GatewayEvent>>((resolve) => setTimeout(() => resolve({ done: true, value: undefined as never }), 100)),
      ]);
      if (next.done) {
        if (completed.some((event) => event.type === "turn_completed")) break;
        continue;
      }
      completed.push(next.value);
      if (next.value.type === "turn_completed") break;
    }
    assert.equal(completed.some((event) => event.type === "turn_completed"), true);
    assert.equal(model.requests[1]?.messages.flatMap((message) => message.content).some((block) => (
      block.type === "tool_result" && block.toolCallId === "input-1" && block.content.some((item) => item.type === "text" && item.text.includes("pnpm test"))
    )), true);

    for (let index = 0; index < 10 && (await store.list(storeKey)).length > 0; index += 1) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    }
    assert.equal((await store.list(storeKey)).length, 0, "settling the native tool clears the persistent pending record");
  } finally {
    await client?.close();
    await server?.close();
    await iterator.return?.();
    first.dispose();
    second?.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("HTTP host dialog store lets a second Gateway validate and answer an owning JSON Schema form", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-http-host-dialog-store-"));
  const projectRoot = join(root, "project");
  const sessionId = "sdk:http-host-dialog-store";
  const storeToken = "sdk-http-host-dialog-store-token";
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, "pilotdeck.yaml"), TEST_CONFIG, "utf8");

  const storeServer = await startGatewayUserDialogStoreHttpServer({
    store: new FileGatewayUserDialogStore({ directory: join(root, "host-dialog-store") }),
    authorizationToken: storeToken,
  });
  const ownerStore = new HttpGatewayUserDialogStore({ url: storeServer.url, authorizationToken: storeToken });
  const rendererStore = new HttpGatewayUserDialogStore({ url: storeServer.url, authorizationToken: storeToken });
  const storeKey: GatewayUserDialogStoreKey = { projectRoot, pilotHome: projectRoot, sessionId };
  const model = new FormDialogModel();
  const owner = createLocalGateway({
    projectRoot,
    pilotHome: projectRoot,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
    userDialogStore: ownerStore,
    __testModelFactory: () => model,
  });
  let renderer: ReturnType<typeof createLocalGateway> | undefined;
  let gatewayServer: Awaited<ReturnType<typeof startGatewayServer>> | undefined;
  let client: ReturnType<typeof createPilotDeckClient> | undefined;
  const iterator = owner.gateway.submitTurn({
    sessionKey: sessionId,
    projectKey: projectRoot,
    workspaceCwd: projectRoot,
    channelKey: "sdk-http-host-dialog-store-owner",
    message: "Configure the test run through a remote form renderer.",
    mode: "bypassPermissions",
    sdkSessionConfig: { userDialogKinds: ["form"] },
  })[Symbol.asyncIterator]();
  try {
    let request: Extract<import("../../src/gateway/protocol/types.js").GatewayEvent, { type: "user_dialog_request" }> | undefined;
    for (let index = 0; index < 20; index += 1) {
      const next = await iterator.next();
      if (next.done) break;
      if (next.value.type === "user_dialog_request") {
        request = next.value;
        break;
      }
    }
    assert.ok(request);
    assert.equal(request.dialogKind, "form");
    assert.equal(request.schema?.type, "object");
    assert.equal((await ownerStore.list(storeKey)).length, 1);

    // This independent Gateway can only discover and answer the dialog via
    // the HTTP store; it has no local AgentLoop, journal, or tool promise.
    renderer = createLocalGateway({
      projectRoot,
      pilotHome: projectRoot,
      fallbackProjectRoot: projectRoot,
      permissionMode: "bypassPermissions",
      userDialogStore: rendererStore,
      __testModelFactory: () => new PromptCaptureModel(),
    });
    gatewayServer = await startGatewayServer({
      gateway: renderer.gateway,
      port: 0,
      token: "sdk-http-host-dialog-renderer-token",
    });
    client = createPilotDeckClient({
      gatewayUrl: gatewayServer.wsUrl,
      authToken: gatewayServer.token,
      projectKey: projectRoot,
      channelKey: "sdk-http-host-dialog-renderer",
    });

    const dialogs = await client.dialogs.list({ sessionId });
    assert.equal(dialogs.length, 1);
    assert.ok(dialogs[0] && !("type" in dialogs[0]), "a live owner must be projected as a live form");
    const claim = await client.dialogs.claim({ sessionId, requestId: request.requestId, ttlMs: 1_000 });
    assert.equal(claim.claimed, true);
    if (!claim.claimed) throw new Error("expected remote renderer lease");

    await assert.rejects(
      () => client!.dialogs.respond({
        sessionId,
        requestId: request!.requestId,
        leaseId: claim.leaseId,
        result: {
          behavior: "answered",
          value: {
            suite: "unsupported",
            contact: "release@example.com",
            delivery: "https://pilotdeck.dev/release",
            deliveryMode: "direct",
            ticket: "PD-42",
          },
        },
      }),
      /does not match the pending dialog contract/,
    );
    assert.equal((await client.dialogs.list({ sessionId })).length, 1, "invalid remote form data must leave the form pending");

    assert.deepEqual(await client.dialogs.respond({
      sessionId,
      requestId: request.requestId,
      leaseId: claim.leaseId,
      result: {
        behavior: "answered",
        value: {
          suite: "e2e",
          contact: "release@example.com",
          delivery: "https://pilotdeck.dev/release",
          deliveryMode: "direct",
          ticket: "PD-42",
        },
      },
    }), { delivered: true });

    const completed: import("../../src/gateway/protocol/types.js").GatewayEvent[] = [];
    for (let index = 0; index < 60; index += 1) {
      const next = await Promise.race([
        iterator.next(),
        new Promise<IteratorResult<import("../../src/gateway/protocol/types.js").GatewayEvent>>((resolve) => setTimeout(() => resolve({ done: true, value: undefined as never }), 100)),
      ]);
      if (next.done) {
        if (completed.some((event) => event.type === "turn_completed")) break;
        continue;
      }
      completed.push(next.value);
      if (next.value.type === "turn_completed") break;
    }
    assert.equal(completed.some((event) => event.type === "turn_completed"), true);
    const answer = model.requests[1]?.messages.flatMap((message) => message.content)
      .find((block) => block.type === "tool_result" && block.toolCallId === "form-1");
    assert.equal(answer?.type, "tool_result");
    if (answer?.type === "tool_result") {
      assert.deepEqual(answer.content, [{
        type: "text",
        text: '{"suite":"e2e","contact":"release@example.com","delivery":"https://pilotdeck.dev/release","deliveryMode":"direct","ticket":"PD-42"}',
      }]);
    }

    for (let index = 0; index < 10 && (await ownerStore.list(storeKey)).length > 0; index += 1) {
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 25));
    }
    assert.equal((await ownerStore.list(storeKey)).length, 0, "settling the original tool clears the remote pending form");
  } finally {
    await client?.close();
    await gatewayServer?.close();
    await iterator.return?.();
    owner.dispose();
    renderer?.dispose();
    await storeServer.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("HTTP host dialog store projects an expired owner as restart-terminal recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-http-host-dialog-owner-expiry-"));
  const projectRoot = join(root, "project");
  const sessionId = "sdk:http-host-dialog-owner-expiry";
  const storeToken = "sdk-http-host-dialog-owner-expiry-token";
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, "pilotdeck.yaml"), TEST_CONFIG, "utf8");

  let storeNow = new Date("2026-09-11T00:00:00.000Z");
  const storeServer = await startGatewayUserDialogStoreHttpServer({
    store: new FileGatewayUserDialogStore({
      directory: join(root, "host-dialog-store"),
      now: () => storeNow,
    }),
    authorizationToken: storeToken,
  });
  const ownerStore = new HttpGatewayUserDialogStore({ url: storeServer.url, authorizationToken: storeToken });
  const recoveryStore = new HttpGatewayUserDialogStore({ url: storeServer.url, authorizationToken: storeToken });
  const owner = createLocalGateway({
    projectRoot,
    pilotHome: projectRoot,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
    userDialogStore: ownerStore,
    __testModelFactory: () => new InputDialogModel(),
  });
  const recovery = createLocalGateway({
    projectRoot,
    pilotHome: projectRoot,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
    userDialogStore: recoveryStore,
    __testModelFactory: () => new PromptCaptureModel(),
  });
  const gatewayServer = await startGatewayServer({
    gateway: recovery.gateway,
    port: 0,
    token: "sdk-http-host-dialog-owner-expiry-renderer-token",
  });
  const client = createPilotDeckClient({
    gatewayUrl: gatewayServer.wsUrl,
    authToken: gatewayServer.token,
    projectKey: projectRoot,
    channelKey: "sdk-http-host-dialog-owner-expiry-renderer",
  });
  const iterator = owner.gateway.submitTurn({
    sessionKey: sessionId,
    projectKey: projectRoot,
    workspaceCwd: projectRoot,
    channelKey: "sdk-http-host-dialog-owner-expiry-owner",
    message: "Ask through a remote host whose owner will stop heartbeating.",
    mode: "bypassPermissions",
    sdkSessionConfig: { userDialogKinds: ["input"] },
  })[Symbol.asyncIterator]();
  try {
    let request: Extract<import("../../src/gateway/protocol/types.js").GatewayEvent, { type: "user_dialog_request" }> | undefined;
    for (let index = 0; index < 20; index += 1) {
      const next = await iterator.next();
      if (next.done) break;
      if (next.value.type === "user_dialog_request") {
        request = next.value;
        break;
      }
    }
    assert.ok(request);

    storeNow = new Date("2026-09-11T00:00:06.000Z");
    const dialogs = await client.dialogs.list({ sessionId });
    assert.equal(dialogs.length, 1);
    const terminal = dialogs[0]!;
    if (!("type" in terminal) || terminal.type !== "user_dialog_terminated") {
      throw new Error("expected an expired remote owner to become restart-terminal recovery");
    }
    assert.equal(terminal.request.requestId, request.requestId);
    assert.deepEqual(await client.dialogs.respond({
      sessionId,
      requestId: request.requestId,
      result: { behavior: "answered", value: "pnpm test" },
    }), { delivered: true, recovered: true, reason: "gateway_restarted" });
  } finally {
    await client.close();
    await gatewayServer.close();
    await iterator.return?.();
    owner.dispose();
    recovery.dispose();
    await storeServer.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("file host dialog store projects an expired owner as restart-terminal recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-host-dialog-owner-expiry-"));
  const projectRoot = join(root, "project");
  const sessionId = "sdk:host-dialog-owner-expiry";
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, "pilotdeck.yaml"), TEST_CONFIG, "utf8");

  let storeNow = new Date("2026-09-11T00:00:00.000Z");
  const store = new FileGatewayUserDialogStore({
    directory: join(root, "host-dialog-store"),
    now: () => storeNow,
  });
  const owner = createLocalGateway({
    projectRoot,
    pilotHome: projectRoot,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
    userDialogStore: store,
    __testModelFactory: () => new InputDialogModel(),
  });
  const recovery = createLocalGateway({
    projectRoot,
    pilotHome: projectRoot,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
    userDialogStore: store,
    __testModelFactory: () => new PromptCaptureModel(),
  });
  const server = await startGatewayServer({ gateway: recovery.gateway, port: 0, token: "sdk-host-dialog-owner-expiry-token" });
  const client = createPilotDeckClient({
    gatewayUrl: server.wsUrl,
    authToken: server.token,
    projectKey: projectRoot,
    channelKey: "sdk-host-dialog-owner-expiry",
  });
  const iterator = owner.gateway.submitTurn({
    sessionKey: sessionId,
    projectKey: projectRoot,
    workspaceCwd: projectRoot,
    channelKey: "sdk-host-dialog-owner-expiry-owner",
    message: "Ask through a host whose owner will stop heartbeating.",
    mode: "bypassPermissions",
    sdkSessionConfig: { userDialogKinds: ["input"] },
  })[Symbol.asyncIterator]();
  try {
    let request: Extract<import("../../src/gateway/protocol/types.js").GatewayEvent, { type: "user_dialog_request" }> | undefined;
    for (let index = 0; index < 20; index += 1) {
      const next = await iterator.next();
      if (next.done) break;
      if (next.value.type === "user_dialog_request") {
        request = next.value;
        break;
      }
    }
    assert.ok(request);

    storeNow = new Date("2026-09-11T00:00:06.000Z");
    const dialogs = await client.dialogs.list({ sessionId });
    assert.equal(dialogs.length, 1);
    const terminal = dialogs[0]!;
    if (!("type" in terminal) || terminal.type !== "user_dialog_terminated") {
      throw new Error("expected an expired host owner to become restart-terminal recovery");
    }
    assert.equal(terminal.request.requestId, request.requestId);

    assert.deepEqual(await client.dialogs.respond({
      sessionId,
      requestId: request.requestId,
      result: { behavior: "answered", value: "pnpm test" },
    }), { delivered: true, recovered: true, reason: "gateway_restarted" });
  } finally {
    await client.close();
    await server.close();
    await iterator.return?.();
    owner.dispose();
    recovery.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("Gateway host dialog store lets a second Gateway renderer answer the owning live turn", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-host-dialog-live-"));
  const projectRoot = join(root, "project");
  const sessionId = "sdk:host-dialog-live";
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, "pilotdeck.yaml"), TEST_CONFIG, "utf8");

  type Stored = GatewayStoredUserDialog & { lease?: { id: string; expiresAtMs: number }; answer?: { result: GatewayStoredUserDialogResult; submittedAt: string } };
  const records = new Map<string, Stored>();
  const storeKey = (key: GatewayUserDialogStoreKey) => `${key.projectRoot}\u0000${key.pilotHome}\u0000${key.sessionId}`;
  const recordKey = (key: GatewayUserDialogStoreKey, requestId: string) => `${storeKey(key)}\u0000${requestId}`;
  let leaseSerial = 0;
  const store: GatewayUserDialogStore = {
    async put(key, dialog) { records.set(recordKey(key, dialog.request.requestId), structuredClone(dialog)); },
    async list(key) {
      const prefix = `${storeKey(key)}\u0000`;
      return [...records.entries()].filter(([entryKey]) => entryKey.startsWith(prefix)).map(([, dialog]) => structuredClone(dialog));
    },
    async remove(key, requestId) { records.delete(recordKey(key, requestId)); },
    async listLive(key) { return await this.list(key); },
    async claimLive(key, input) {
      const record = records.get(recordKey(key, input.requestId));
      if (!record) return { claimed: false, reason: "not_pending" as const };
      const now = Date.now();
      if (record.lease && record.lease.expiresAtMs > now && record.lease.id !== input.leaseId) {
        return { claimed: false, reason: "claimed" as const, expiresAt: new Date(record.lease.expiresAtMs).toISOString() };
      }
      const id = record.lease?.id ?? `host-lease-${++leaseSerial}`;
      record.lease = { id, expiresAtMs: now + input.ttlMs };
      return { claimed: true, leaseId: id, expiresAt: new Date(record.lease.expiresAtMs).toISOString() };
    },
    async releaseLive(key, input) {
      const record = records.get(recordKey(key, input.requestId));
      if (!record?.lease || record.lease.id !== input.leaseId) return false;
      delete record.lease;
      return true;
    },
    async submitLiveAnswer(key, input) {
      const record = records.get(recordKey(key, input.requestId));
      if (!record) return false;
      const now = Date.now();
      if (record.lease && record.lease.expiresAtMs > now && record.lease.id !== input.leaseId) return false;
      record.answer = { result: structuredClone(input.result), submittedAt: new Date(now).toISOString() };
      return true;
    },
    async takeLiveAnswer(key, requestId) {
      const record = records.get(recordKey(key, requestId));
      if (!record?.answer) return undefined;
      const answer = record.answer;
      delete record.answer;
      return { requestId, result: answer.result, submittedAt: answer.submittedAt };
    },
  };
  const model = new InputDialogModel();
  const owner = createLocalGateway({
    projectRoot,
    pilotHome: projectRoot,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
    userDialogStore: store,
    __testModelFactory: () => model,
  });
  const renderer = createLocalGateway({
    projectRoot,
    pilotHome: projectRoot,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
    userDialogStore: store,
    __testModelFactory: () => new PromptCaptureModel(),
  });
  const server = await startGatewayServer({ gateway: renderer.gateway, port: 0, token: "sdk-host-dialog-live-token" });
  const client = createPilotDeckClient({
    gatewayUrl: server.wsUrl,
    authToken: server.token,
    projectKey: projectRoot,
    channelKey: "sdk-host-dialog-live",
  });
  const iterator = owner.gateway.submitTurn({
    sessionKey: sessionId,
    projectKey: projectRoot,
    workspaceCwd: projectRoot,
    channelKey: "sdk-host-dialog-live-owner",
    message: "Ask through a second Gateway renderer.",
    mode: "bypassPermissions",
    sdkSessionConfig: { userDialogKinds: ["input"] },
  })[Symbol.asyncIterator]();
  try {
    let request: Extract<import("../../src/gateway/protocol/types.js").GatewayEvent, { type: "user_dialog_request" }> | undefined;
    for (let index = 0; index < 20; index += 1) {
      const next = await iterator.next();
      if (next.done) break;
      if (next.value.type === "user_dialog_request") {
        request = next.value;
        break;
      }
    }
    assert.ok(request);
    const dialogs = await client.dialogs.list({ sessionId });
    assert.equal(dialogs.length, 1);
    assert.ok(dialogs[0] && !("type" in dialogs[0]), "a full host protocol exposes a live, not terminal, dialog");
    const claim = await client.dialogs.claim({ sessionId, requestId: request!.requestId, ttlMs: 1_000 });
    assert.equal(claim.claimed, true);
    if (!claim.claimed) throw new Error("expected host lease");
    assert.deepEqual(await client.dialogs.respond({
      sessionId,
      requestId: request!.requestId,
      leaseId: claim.leaseId,
      result: { behavior: "answered", value: "pnpm test" },
    }), { delivered: true });

    const completed: import("../../src/gateway/protocol/types.js").GatewayEvent[] = [];
    for (let index = 0; index < 60; index += 1) {
      const next = await Promise.race([
        iterator.next(),
        new Promise<IteratorResult<import("../../src/gateway/protocol/types.js").GatewayEvent>>((resolve) => setTimeout(() => resolve({ done: true, value: undefined as never }), 100)),
      ]);
      if (next.done) {
        if (completed.some((event) => event.type === "turn_completed")) break;
        continue;
      }
      completed.push(next.value);
      if (next.value.type === "turn_completed") break;
    }
    assert.equal(completed.some((event) => event.type === "turn_completed"), true);
    assert.equal(model.requests[1]?.messages.flatMap((message) => message.content).some((block) => (
      block.type === "tool_result" && block.toolCallId === "input-1" && block.content.some((item) => item.type === "text" && item.text.includes("pnpm test"))
    )), true, "the original Gateway must resume its own tool promise from the host answer");
  } finally {
    await client.close();
    await server.close();
    await iterator.return?.();
    owner.dispose();
    renderer.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("SDK validates recovered select and form answers before durable recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-recovered-dialog-validation-"));
  const projectRoot = join(root, "project");
  const sessionId = "sdk:recovered-dialog-validation";
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, "pilotdeck.yaml"), TEST_CONFIG, "utf8");
  const storage = createAgentProjectSessionStorage({ projectRoot, pilotHome: projectRoot, sessionId });
  const journal = createGatewayUserDialogJournal(storage);
  journal?.record({
    type: "user_dialog_request",
    requestId: "recovered-select",
    dialogKind: "select",
    toolCallId: "select-call",
    toolName: "request_user_choice",
    prompt: "Choose a test suite.",
    choices: [{ value: "unit" }, { value: "e2e" }],
  });
  journal?.record({
    type: "user_dialog_request",
    requestId: "recovered-form",
    dialogKind: "form",
    toolCallId: "form-call",
    toolName: "request_user_form",
    prompt: "Configure the test run.",
    schema: {
      type: "object",
      properties: { suite: { type: "string", enum: ["unit", "e2e"] } },
      required: ["suite"],
      additionalProperties: false,
    },
  });
  const local = createLocalGateway({
    projectRoot,
    pilotHome: projectRoot,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
    __testModelFactory: () => new PromptCaptureModel(),
  });
  const server = await startGatewayServer({
    gateway: local.gateway,
    port: 0,
    token: "sdk-recovered-dialog-validation-token",
  });
  const client = createPilotDeckClient({
    gatewayUrl: server.wsUrl,
    authToken: server.token,
    projectKey: projectRoot,
    channelKey: "sdk-recovered-dialog-validation",
  });
  try {
    assert.equal((await client.dialogs.list({ sessionId })).length, 2);
    await assert.rejects(
      () => client.dialogs.respond({
        sessionId,
        requestId: "recovered-select",
        result: { behavior: "answered", value: "unsupported" },
      }),
      /does not match the recovered dialog contract/,
    );
    assert.equal((await client.dialogs.list({ sessionId })).length, 2, "invalid select answer must leave recovery pending");
    await assert.rejects(
      () => client.dialogs.respond({
        sessionId,
        requestId: "recovered-form",
        result: { behavior: "answered", value: { suite: "unsupported" } },
      }),
      /does not match the recovered dialog contract/,
    );
    assert.equal((await client.dialogs.list({ sessionId })).length, 2, "invalid form answer must leave recovery pending");
    const [selectRecovery, formRecovery] = await Promise.all([
      client.dialogs.respond({
        sessionId,
        requestId: "recovered-select",
        result: { behavior: "answered", value: "e2e" },
      }),
      client.dialogs.respond({
        sessionId,
        requestId: "recovered-form",
        result: { behavior: "answered", value: { suite: "unit" } },
      }),
    ]);
    assert.deepEqual(selectRecovery, { delivered: true, recovered: true, reason: "gateway_restarted" });
    assert.deepEqual(formRecovery, { delivered: true, recovered: true, reason: "gateway_restarted" });
    assert.deepEqual(await client.dialogs.list({ sessionId }), []);

    const transcript = await readAgentProjectSessionTranscript(storage);
    const recoveryMessages = transcript.entries.filter((entry) => (
      entry.type === "durable_message"
      && entry.message.metadata?.purpose?.startsWith("gateway_user_dialog_recovery:")
    ));
    assert.equal(recoveryMessages.length, 2);
    assert.equal(new Set(recoveryMessages.map((entry) => entry.sequence)).size, 2, "concurrent recovery writes must not reuse transcript sequences");
    assert.equal(recoveryMessages.some((entry) => (
      entry.type === "durable_message"
      && entry.message.content.some((block) => block.type === "text" && block.text.includes("The user selected: e2e"))
    )), true);
    assert.equal(recoveryMessages.some((entry) => (
      entry.type === "durable_message"
      && entry.message.content.some((block) => block.type === "text" && block.text.includes('{"suite":"unit"}'))
    )), true);
  } finally {
    await client.close();
    await server.close();
    local.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("Gateway validates and resolves opt-in select and confirm dialogs", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-select-confirm-dialog-"));
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, "pilotdeck.yaml"), TEST_CONFIG, "utf8");
  const model = new SelectAndConfirmDialogModel();
  const local = createLocalGateway({
    projectRoot,
    pilotHome: projectRoot,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
    __testModelFactory: () => model,
  });
  try {
    const events: any[] = [];
    for await (const event of local.gateway.submitTurn({
      sessionKey: "sdk:select-confirm-dialog",
      workspaceCwd: projectRoot,
      channelKey: "test",
      message: "Choose a suite and confirm it.",
      mode: "bypassPermissions",
      sdkSessionConfig: { userDialogKinds: ["select", "confirm"] },
    })) {
      events.push(event);
      if (event.type !== "user_dialog_request" || (event.dialogKind !== "select" && event.dialogKind !== "confirm")) continue;
      if (event.dialogKind === "select") {
        assert.deepEqual(event.choices, [
          { value: "unit", label: "Unit tests" },
          { value: "e2e", label: "End-to-end tests", description: "Runs the complete SDK suite" },
        ]);
        await assert.rejects(
          () => local.gateway.respondUserDialog!({
            sessionKey: "sdk:select-confirm-dialog",
            requestId: event.requestId,
            result: { behavior: "answered", value: "not-a-choice" },
          }),
          { code: "INVALID_USER_DIALOG_RESPONSE" },
        );
        assert.deepEqual(await local.gateway.respondUserDialog!({
          sessionKey: "sdk:select-confirm-dialog",
          requestId: event.requestId,
          result: { behavior: "answered", value: "e2e" },
        }), { delivered: true });
      } else {
        assert.equal(event.dialogKind, "confirm");
        assert.equal(event.defaultValue, false);
        assert.deepEqual(await local.gateway.respondUserDialog!({
          sessionKey: "sdk:select-confirm-dialog",
          requestId: event.requestId,
          result: { behavior: "answered", value: true },
        }), { delivered: true });
      }
    }

    assert.equal(model.requests[0]?.tools?.some((tool) => tool.name === "request_user_choice"), true);
    assert.equal(model.requests[0]?.tools?.some((tool) => tool.name === "request_user_confirmation"), true);
    const selectAnswer = model.requests[1]?.messages.flatMap((message) => message.content)
      .find((block) => block.type === "tool_result" && block.toolCallId === "select-1");
    const confirmAnswer = model.requests[2]?.messages.flatMap((message) => message.content)
      .find((block) => block.type === "tool_result" && block.toolCallId === "confirm-1");
    assert.equal(selectAnswer?.type, "tool_result");
    assert.equal(confirmAnswer?.type, "tool_result");
    if (selectAnswer?.type === "tool_result") {
      assert.deepEqual(selectAnswer.content, [{ type: "text", text: "The user selected: e2e" }]);
    }
    if (confirmAnswer?.type === "tool_result") {
      assert.deepEqual(confirmAnswer.content, [{ type: "text", text: "The user confirmed: yes" }]);
    }
    assert.equal(events.filter((event) => event.type === "user_dialog_request").length, 2);
    assert.equal(events.some((event) => event.type === "turn_completed"), true);
    const storage = createAgentProjectSessionStorage({
      projectRoot,
      pilotHome: projectRoot,
      sessionId: "sdk:select-confirm-dialog",
    });
    const transcript = await readFile(storage.transcriptPath, "utf8");
    assert.match(transcript, /request_user_choice/);
    assert.match(transcript, /request_user_confirmation/);
    assert.doesNotMatch(transcript, /user_dialog_request/);
  } finally {
    local.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("Gateway validates a schema-backed form dialog before resuming the AgentLoop", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-form-dialog-"));
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, "pilotdeck.yaml"), TEST_CONFIG, "utf8");
  const model = new FormDialogModel();
  const local = createLocalGateway({
    projectRoot,
    pilotHome: projectRoot,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
    __testModelFactory: () => model,
  });
  try {
    const disabled: any[] = [];
    for await (const event of local.gateway.submitTurn({
      sessionKey: "sdk:form-dialog-disabled",
      workspaceCwd: projectRoot,
      channelKey: "test",
      message: "Configure the test run.",
      mode: "bypassPermissions",
    })) disabled.push(event);
    assert.equal(model.requests[0]?.tools?.some((tool) => tool.name === "request_user_form"), false);
    assert.equal(disabled.some((event) => event.type === "user_dialog_request"), false);

    model.reset();
    const events: any[] = [];
    for await (const event of local.gateway.submitTurn({
      sessionKey: "sdk:form-dialog",
      workspaceCwd: projectRoot,
      channelKey: "test",
      message: "Configure the test run.",
      mode: "bypassPermissions",
      sdkSessionConfig: { userDialogKinds: ["form"] },
    })) {
      events.push(event);
      if (event.type !== "user_dialog_request" || event.dialogKind !== "form") continue;
      assert.equal(event.dialogKind, "form");
      assert.deepEqual(event.schema, {
        type: "object",
        $defs: {
          emailAddress: { type: "string", format: "email" },
          deliveryTarget: {
            oneOf: [
              { $ref: "#/$defs/emailAddress" },
              { type: "string", format: "uri" },
            ],
          },
        },
        properties: {
          suite: { type: "string", enum: ["unit", "e2e"] },
          contact: { $ref: "#/$defs/emailAddress" },
          delivery: { $ref: "#/$defs/deliveryTarget" },
          retries: { type: "integer", minimum: 0, maximum: 5 },
          tag: { type: "string", minLength: 3, maxLength: 12, pattern: "^[a-z]+$" },
          targets: {
            type: "array",
            minItems: 1,
            maxItems: 2,
            uniqueItems: true,
            items: { type: "string", minLength: 1 },
          },
          labels: {
            type: "object",
            minProperties: 1,
            additionalProperties: { type: "string", minLength: 1 },
          },
          deliveryMode: { type: "string", enum: ["direct", "guided"] },
          ticket: { type: "string", pattern: "^PD-[0-9]+$" },
          reviewer: { type: "string", minLength: 1 },
          approved: { type: "boolean" },
        },
        required: ["suite", "contact", "delivery", "deliveryMode"],
        additionalProperties: false,
        if: {
          properties: { deliveryMode: { const: "direct" } },
          required: ["deliveryMode"],
        },
        then: {
          properties: { ticket: { type: "string", pattern: "^PD-[0-9]+$" } },
          required: ["ticket"],
        },
        dependentRequired: { reviewer: ["approved"] },
        dependentSchemas: {
          reviewer: {
            properties: { approved: { const: true } },
            required: ["approved"],
          },
        },
      });
      await assert.rejects(
        () => local.gateway.respondUserDialog!({
          sessionKey: "sdk:form-dialog",
          requestId: event.requestId,
          result: {
            behavior: "answered",
            value: {
              suite: "e2e",
              contact: "release@example.com",
              delivery: "not-a-destination",
              retries: 6,
              tag: "RELEASE",
              targets: ["unit", "unit"],
              labels: { region: "" },
              deliveryMode: "direct",
              reviewer: "owner",
              approved: false,
            },
          },
        }),
        { code: "INVALID_USER_DIALOG_RESPONSE" },
      );
      assert.deepEqual(await local.gateway.respondUserDialog!({
        sessionKey: "sdk:form-dialog",
        requestId: event.requestId,
        result: {
          behavior: "answered",
          value: {
            suite: "e2e",
            contact: "release@example.com",
            delivery: "https://pilotdeck.dev/release",
            retries: 2,
            tag: "release",
            targets: ["unit", "e2e"],
            labels: { region: "us" },
            deliveryMode: "direct",
            ticket: "PD-42",
            reviewer: "owner",
            approved: true,
          },
        },
      }), { delivered: true });
    }

    assert.equal(model.requests[0]?.tools?.some((tool) => tool.name === "request_user_form"), true);
    const answer = model.requests[1]?.messages.flatMap((message) => message.content)
      .find((block) => block.type === "tool_result" && block.toolCallId === "form-1");
    assert.equal(answer?.type, "tool_result");
    if (answer?.type === "tool_result") {
      assert.deepEqual(answer.content, [{
        type: "text",
        text: '{"suite":"e2e","contact":"release@example.com","delivery":"https://pilotdeck.dev/release","retries":2,"tag":"release","targets":["unit","e2e"],"labels":{"region":"us"},"deliveryMode":"direct","ticket":"PD-42","reviewer":"owner","approved":true}',
      }]);
    }
    assert.equal(events.filter((event) => event.type === "user_dialog_request").length, 1);
    assert.equal(events.some((event) => event.type === "turn_completed"), true);
    const storage = createAgentProjectSessionStorage({
      projectRoot,
      pilotHome: projectRoot,
      sessionId: "sdk:form-dialog",
    });
    const transcript = await readFile(storage.transcriptPath, "utf8");
    assert.match(transcript, /request_user_form/);
    assert.match(transcript, /"suite":"e2e"/);
    assert.doesNotMatch(transcript, /user_dialog_request/);
  } finally {
    local.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("form dialogs validate their declared constraint subset and reject unknown schema keywords", () => {
  const validated = validateFormDialogSchema({
    type: "object",
    properties: {
      retries: { type: "integer", minimum: 0, maximum: 5, multipleOf: 1 },
      tag: { type: "string", minLength: 3, maxLength: 8, pattern: "^[a-z]+$" },
      contact: { type: "string", format: "email" },
      targets: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", minLength: 1 } },
      labels: { type: "object", additionalProperties: { type: "string", minLength: 1 } },
    },
    required: ["retries", "tag", "targets", "contact"],
    additionalProperties: false,
  });
  assert.equal(validated.ok, true);
  if (!validated.ok) return;
  assert.equal(acceptsFormDialogAnswer(validated.schema, {
    retries: 2,
    tag: "release",
    contact: "owner@example.com",
    targets: ["unit", "e2e"],
    labels: { region: "us" },
  }), true);
  assert.equal(acceptsFormDialogAnswer(validated.schema, {
    retries: 6,
    tag: "RELEASE",
    contact: "not-an-email",
    targets: ["unit", "unit"],
    labels: { region: "" },
  }), false);
  assert.deepEqual(validateFormDialogSchema({ type: "object", oneOf: [] }), {
    ok: false,
    message: "$.oneOf must contain 1-32 schema branches.",
  });
  const composed = validateFormDialogSchema({
    type: "object",
    properties: {
      destination: {
        oneOf: [
          { type: "string", format: "email" },
          { type: "string", format: "uri" },
        ],
      },
      retryCount: {
        allOf: [
          { type: "integer", minimum: 1 },
          { maximum: 3 },
        ],
      },
      mode: {
        anyOf: [
          { const: "safe" },
          { const: "fast" },
        ],
      },
      secret: { type: "string", not: { const: "forbidden" } },
      deliveryMode: { type: "string", enum: ["direct", "guided"] },
      ticket: { type: "string", pattern: "^PD-[0-9]+$" },
      reviewer: { type: "string", minLength: 1 },
      approved: { type: "boolean" },
    },
    required: ["destination", "retryCount", "mode", "secret", "deliveryMode"],
    additionalProperties: false,
    if: {
      properties: { deliveryMode: { const: "direct" } },
      required: ["deliveryMode"],
    },
    then: {
      properties: { ticket: { type: "string", pattern: "^PD-[0-9]+$" } },
      required: ["ticket"],
    },
    dependentRequired: { reviewer: ["approved"] },
    dependentSchemas: {
      reviewer: {
        properties: { approved: { const: true } },
        required: ["approved"],
      },
    },
  });
  assert.equal(composed.ok, true);
  if (composed.ok) {
    assert.equal(acceptsFormDialogAnswer(composed.schema, {
      destination: "https://pilotdeck.dev/sdk",
      retryCount: 2,
      mode: "safe",
      secret: "allowed",
      deliveryMode: "direct",
      ticket: "PD-42",
      reviewer: "owner",
      approved: true,
    }), true);
    assert.equal(acceptsFormDialogAnswer(composed.schema, {
      destination: "not-a-destination",
      retryCount: 4,
      mode: "unsafe",
      secret: "forbidden",
      deliveryMode: "direct",
      reviewer: "owner",
      approved: false,
    }), false);
  }
  const reusableDefinitions = validateFormDialogSchema({
    type: "object",
    $defs: {
      emailAddress: { type: "string", format: "email" },
      releaseTag: { type: "string", pattern: "^PD-[0-9]+$" },
      approver: {
        type: "object",
        properties: {
          email: { $ref: "#/$defs/emailAddress" },
          ticket: { $ref: "#/$defs/releaseTag" },
        },
        required: ["email", "ticket"],
        additionalProperties: false,
      },
    },
    properties: {
      owner: { $ref: "#/$defs/approver" },
      backupEmail: { $ref: "#/$defs/emailAddress" },
    },
    required: ["owner"],
    additionalProperties: false,
  });
  assert.equal(reusableDefinitions.ok, true);
  if (reusableDefinitions.ok) {
    assert.equal(acceptsFormDialogAnswer(reusableDefinitions.schema, {
      owner: { email: "owner@example.com", ticket: "PD-42" },
      backupEmail: "backup@example.com",
    }), true);
    assert.equal(acceptsFormDialogAnswer(reusableDefinitions.schema, {
      owner: { email: "not-an-email", ticket: "not-a-ticket" },
    }), false);
  }
  const collectionConstraints = validateFormDialogSchema({
    type: "object",
    $defs: {
      releaseTarget: { const: "e2e" },
    },
    properties: {
      targets: {
        type: "array",
        contains: { $ref: "#/$defs/releaseTarget" },
        minContains: 1,
        maxContains: 1,
        items: { type: "string" },
      },
      labels: {
        type: "object",
        propertyNames: { type: "string", pattern: "^[a-z][a-z0-9_-]*$" },
        patternProperties: { "^env_": { type: "integer" } },
        additionalProperties: true,
      },
      tuple: {
        type: "array",
        prefixItems: [
          { $ref: "#/$defs/releaseTarget" },
          { type: "integer" },
        ],
        items: { type: "string" },
      },
    },
    required: ["targets", "labels", "tuple"],
    additionalProperties: false,
  });
  assert.equal(collectionConstraints.ok, true);
  if (collectionConstraints.ok) {
    assert.equal(acceptsFormDialogAnswer(collectionConstraints.schema, {
      targets: ["unit", "e2e"],
      labels: { release_2026: "ready", env_build: 3 },
      tuple: ["e2e", 3, "fallback"],
    }), true);
    assert.equal(acceptsFormDialogAnswer(collectionConstraints.schema, {
      targets: ["unit"],
      labels: { release_2026: "ready", env_build: 3 },
      tuple: ["e2e", 3],
    }), false);
    assert.equal(acceptsFormDialogAnswer(collectionConstraints.schema, {
      targets: ["e2e", "e2e"],
      labels: { release_2026: "ready", env_build: 3 },
      tuple: ["e2e", 3],
    }), false);
    assert.equal(acceptsFormDialogAnswer(collectionConstraints.schema, {
      targets: ["e2e"],
      labels: { "Release Name": "ready", env_build: 3 },
      tuple: ["e2e", 3],
    }), false);
    assert.equal(acceptsFormDialogAnswer(collectionConstraints.schema, {
      targets: ["e2e"],
      labels: { release_2026: "ready", env_build: 3 },
      tuple: ["e2e", "3"],
    }), false);
    assert.equal(acceptsFormDialogAnswer(collectionConstraints.schema, {
      targets: ["e2e"],
      labels: { release_2026: "ready", env_build: "3" },
      tuple: ["e2e", 3],
    }), false);
  }
  assert.deepEqual(validateFormDialogSchema({
    type: "object",
    properties: { targets: { type: "array", minContains: 1 } },
  }), {
    ok: false,
    message: "$.properties.targets.minContains and $.properties.targets.maxContains require $.properties.targets.contains.",
  });
  assert.deepEqual(validateFormDialogSchema({
    type: "object",
    properties: { tuple: { type: "array", prefixItems: [] } },
  }), {
    ok: false,
    message: "$.properties.tuple.prefixItems must contain 1-32 schema entries.",
  });
  assert.deepEqual(validateFormDialogSchema({
    type: "object",
    patternProperties: { "(": { type: "string" } },
  }), {
    ok: false,
    message: "$.patternProperties.( must be a valid JavaScript regular expression.",
  });
  assert.deepEqual(validateFormDialogSchema({
    type: "object",
    properties: { owner: { $ref: "#/properties/owner" } },
  }), {
    ok: false,
    message: "$.properties.owner.$ref must be a local #/$defs/<name> reference.",
  });
  assert.deepEqual(validateFormDialogSchema({
    type: "object",
    properties: { owner: { $ref: "#/$defs/missing" } },
  }), {
    ok: false,
    message: "$.properties.owner.$ref references unknown root definition missing.",
  });
  assert.deepEqual(validateFormDialogSchema({
    type: "object",
    $defs: {
      first: { $ref: "#/$defs/second" },
      second: { $ref: "#/$defs/first" },
    },
  }), {
    ok: false,
    message: "$defs contains a circular reference: first -> second -> first.",
  });
  assert.deepEqual(validateFormDialogSchema({
    type: "object",
    properties: { mode: { type: "string" } },
    then: { properties: { mode: { const: "direct" } } },
  }), {
    ok: false,
    message: "$.then and $.else require $.if.",
  });
  assert.deepEqual(validateFormDialogSchema({
    type: "object",
    properties: { mode: { type: "string" } },
    dependentRequired: { unknown: ["mode"] },
  }), {
    ok: false,
    message: "$.dependentRequired.unknown must reference a declared property.",
  });
  assert.deepEqual(validateFormDialogSchema({ type: "object", properties: { tag: { type: "string", pattern: "(" } } }), {
    ok: false,
    message: "$.properties.tag.pattern must be a valid JavaScript regular expression.",
  });
  assert.deepEqual(validateFormDialogSchema({ type: "object", properties: { value: { type: "string", format: "hostname" } } }), {
    ok: false,
    message: "$.properties.value.format must be one of email, uri, uuid, date, time, date-time.",
  });
  for (const [format, accepted, rejected] of [
    ["email", "owner@example.com", "owner.example.com"],
    ["uri", "https://pilotdeck.dev/sdk", "not a uri"],
    ["uuid", "123e4567-e89b-42d3-a456-426614174000", "123e4567-e89b-42d3-7456-426614174000"],
    ["date", "2024-02-29", "2023-02-29"],
    ["time", "23:59:59+08:00", "24:00:00"],
    ["date-time", "2024-02-29T23:59:59Z", "2023-02-29T23:59:59Z"],
  ] as const) {
    const schema = validateFormDialogSchema({ type: "object", properties: { value: { type: "string", format } }, required: ["value"] });
    assert.equal(schema.ok, true, `${format} schema must be supported`);
    if (!schema.ok) continue;
    assert.equal(acceptsFormDialogAnswer(schema.schema, { value: accepted }), true, `${format} accepts a valid value`);
    assert.equal(acceptsFormDialogAnswer(schema.schema, { value: rejected }), false, `${format} rejects an invalid value`);
  }
});

test("Gateway resumes a Draft 2020-12 form dialog through the native tool runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-draft-form-dialog-"));
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, "pilotdeck.yaml"), TEST_CONFIG, "utf8");
  const model = new Draft202012FormDialogModel();
  const local = createLocalGateway({
    projectRoot,
    pilotHome: projectRoot,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
    __testModelFactory: () => model,
  });
  try {
    const events: any[] = [];
    for await (const event of local.gateway.submitTurn({
      sessionKey: "sdk:draft-form-dialog",
      workspaceCwd: projectRoot,
      channelKey: "test",
      message: "Provide a retry count.",
      mode: "bypassPermissions",
      sdkSessionConfig: { userDialogKinds: ["form"] },
    })) {
      events.push(event);
      if (event.type !== "user_dialog_request") continue;
      if (event.dialogKind !== "form") continue;
      assert.equal(event.schema.$schema, FORM_DIALOG_DRAFT_2020_12);
      await assert.rejects(
        () => local.gateway.respondUserDialog!({
          sessionKey: "sdk:draft-form-dialog",
          requestId: event.requestId,
          result: { behavior: "answered", value: { retries: 0 } },
        }),
        { code: "INVALID_USER_DIALOG_RESPONSE" },
      );
      assert.deepEqual(await local.gateway.respondUserDialog!({
        sessionKey: "sdk:draft-form-dialog",
        requestId: event.requestId,
        result: { behavior: "answered", value: { retries: 2 } },
      }), { delivered: true });
    }
    assert.equal(model.requests.length, 2);
    assert.equal(events.some((event) => event.type === "turn_completed"), true);
    const result = model.requests[1]?.messages.flatMap((message) => message.content)
      .find((block) => block.type === "tool_result" && block.toolCallId === "draft-form-1");
    assert.deepEqual(result?.type === "tool_result" ? result.content : undefined, [
      { type: "text", text: "{\"retries\":2}" },
    ]);
  } finally {
    local.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("form dialogs accept local Draft 2020-12 schemas and fail closed for remote references", () => {
  const standard = validateFormDialogSchema({
    $schema: FORM_DIALOG_DRAFT_2020_12,
    type: "object",
    $defs: {
      positiveInteger: {
        type: "integer",
        minimum: 1,
      },
    },
    properties: {
      retries: { $ref: "#/$defs/positiveInteger" },
      modes: {
        type: "array",
        prefixItems: [{ const: "safe" }],
        items: { enum: ["safe", "fast"] },
        minItems: 1,
      },
    },
    required: ["retries"],
    unevaluatedProperties: false,
  });
  assert.equal(standard.ok, true);
  if (standard.ok) {
    assert.equal(acceptsFormDialogAnswer(standard.schema, {
      retries: 2,
      modes: ["safe", "fast"],
    }), true);
    assert.equal(acceptsFormDialogAnswer(standard.schema, { retries: 0 }), false);
    assert.equal(acceptsFormDialogAnswer(standard.schema, { retries: 2, unexpected: true }), false);
  }

  assert.deepEqual(validateFormDialogSchema({
    $schema: FORM_DIALOG_DRAFT_2020_12,
    type: "object",
    properties: { value: { $ref: "https://schemas.example.invalid/value.json" } },
  }), {
    ok: false,
    message: "$.properties.value.$ref must use a local # reference; Gateway form dialogs never fetch remote schemas.",
  });
});

test("Gateway tool_policy sandbox restricts only the configured SDK session", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-tool-policy-sandbox-"));
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, "pilotdeck.yaml"), TEST_CONFIG, "utf8");
  const model = new InputDialogModel();
  const local = createLocalGateway({
    projectRoot,
    pilotHome: projectRoot,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
    __testModelFactory: () => model,
  });
  try {
    for await (const _event of local.gateway.submitTurn({
      sessionKey: "sdk:tool-policy-sandbox",
      workspaceCwd: projectRoot,
      channelKey: "test",
      message: "Inspect the workspace safely.",
      mode: "bypassPermissions",
      sdkSessionConfig: {
        sandbox: { filesystem: "read_only", network: "deny", process: "deny" },
      },
    })) { /* consume */ }

    const sandboxTools = new Set(model.requests[0]?.tools?.map((tool) => tool.name));
    assert.equal(sandboxTools.has("read_file"), true);
    for (const name of ["write_file", "edit_file", "edit_notebook", "bash", "execute_code", "agent", "web_fetch", "web_search"]) {
      assert.equal(sandboxTools.has(name), false, `${name} must not be model-visible in tool_policy sandbox`);
    }

    model.reset();
    const noFilesystemEvents: any[] = [];
    for await (const event of local.gateway.submitTurn({
      sessionKey: "sdk:tool-policy-no-filesystem",
      workspaceCwd: projectRoot,
      channelKey: "test",
      message: "Do not access workspace files.",
      mode: "bypassPermissions",
      sdkSessionConfig: {
        sandbox: { filesystem: "deny" },
      },
    })) noFilesystemEvents.push(event);
    assert.equal(
      noFilesystemEvents.some((event) => event.type === "error"),
      false,
      `filesystem=deny must construct the SDK session: ${JSON.stringify(noFilesystemEvents)}`,
    );
    const noFilesystemTools = new Set(model.requests[0]?.tools?.map((tool) => tool.name));
    for (const name of ["read_file", "glob", "grep", "write_file", "edit_file", "edit_notebook", "send_attachment"]) {
      assert.equal(noFilesystemTools.has(name), false, `${name} must not be model-visible when filesystem=deny`);
    }
    assert.equal(noFilesystemTools.has("web_fetch"), true, "non-filesystem tools remain available when filesystem=deny");

    model.reset();
    for await (const _event of local.gateway.submitTurn({
      sessionKey: "sdk:tool-policy-default",
      workspaceCwd: projectRoot,
      channelKey: "test",
      message: "Use the default SDK tool surface.",
      mode: "bypassPermissions",
    })) { /* consume */ }
    const defaultTools = new Set(model.requests[0]?.tools?.map((tool) => tool.name));
    for (const name of ["write_file", "bash", "execute_code", "agent", "web_fetch"]) {
      assert.equal(defaultTools.has(name), true, `${name} must remain available without sandbox config`);
    }
  } finally {
    local.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("Gateway host sandbox profile owns Bash execution and removes uncontrolled process bridges", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-host-sandbox-"));
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, "pilotdeck.yaml"), TEST_CONFIG, "utf8");
  const model = new BashProgressModel();
  const commands: string[] = [];
  const profileContexts: Array<{
    profile: string;
    sessionKey: string;
    cwd: string;
    readOnly: boolean;
    workspaceMounted: boolean;
    networkDenied: boolean;
  }> = [];
  const local = createLocalGateway({
    projectRoot,
    pilotHome: projectRoot,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
    sandboxProfiles: {
      recorded: createBubblewrapSandboxProfile({
        createRunner(options, context) {
          profileContexts.push({
            profile: context.profile,
            sessionKey: context.sessionKey,
            cwd: context.cwd,
            readOnly: context.sandbox.filesystem === "read_only",
            workspaceMounted: options.mountWorkspace !== false,
            networkDenied: context.sandbox.network === "deny",
          });
          assert.equal(options.workspaceRoot, projectRoot);
          assert.equal(options.readOnlyWorkspace, context.sandbox.filesystem === "read_only");
          return {
            async run(command) {
              commands.push(command);
              return { exitCode: 0, stdout: "profile-ran\n", stderr: "", timedOut: false, durationMs: 1 };
            },
          };
        },
      }),
      untrusted: {
        createCommandRunner() {
          return {
            async run() {
              return { exitCode: 0, stdout: "unexpected\n", stderr: "", timedOut: false, durationMs: 1 };
            },
          };
        },
      },
    },
    __testModelFactory: () => model,
  });
  try {
    const events: any[] = [];
    for await (const event of local.gateway.submitTurn({
      sessionKey: "sdk:host-sandbox",
      workspaceCwd: projectRoot,
      channelKey: "test",
      message: "Run the bounded command.",
      mode: "bypassPermissions",
      sdkSessionConfig: {
        sandbox: { type: "host", profile: "recorded", filesystem: "read_only", network: "deny" },
      },
    })) events.push(event);

    assert.deepEqual(commands, ["printf progress"], JSON.stringify(events));
    assert.deepEqual(profileContexts, [{
      profile: "recorded",
      sessionKey: "sdk:host-sandbox",
      cwd: projectRoot,
      readOnly: true,
      workspaceMounted: true,
      networkDenied: true,
    }]);
    assert.match(JSON.stringify(events), /profile-ran/);
    const visible = new Set(model.requests[0]?.tools?.map((tool) => tool.name));
    assert.equal(visible.has("bash"), true, "host profile keeps the runner it owns");
    for (const name of [
      "read_file", "glob", "grep", "write_file", "edit_file", "edit_notebook", "send_attachment",
      "agent", "web_fetch", "web_search",
    ]) {
      assert.equal(visible.has(name), false, `${name} could bypass the selected host runner`);
    }
    assert.equal(visible.has("execute_code"), true, "Bubblewrap owns the Python process and removes bypassing helper RPCs");
    const restrictedExecuteCode = model.requests[0]?.tools?.find((tool) => tool.name === "execute_code");
    assert.doesNotMatch(restrictedExecuteCode?.description ?? "", /read_file|write_file|edit_file|grep|glob|web_fetch|web_search/);

    model.reset();
    for await (const _event of local.gateway.submitTurn({
      sessionKey: "sdk:host-sandbox-no-filesystem",
      workspaceCwd: projectRoot,
      channelKey: "test",
      message: "Do not expose the workspace to any process.",
      mode: "bypassPermissions",
      sdkSessionConfig: { sandbox: { type: "host", profile: "recorded", filesystem: "deny" } },
    })) { /* consume */ }
    const denyFilesystemTools = new Set(model.requests[0]?.tools?.map((tool) => tool.name));
    assert.equal(denyFilesystemTools.has("bash"), true, "Bubblewrap can retain a scratch-shell without the workspace");
    assert.equal(denyFilesystemTools.has("read_file"), false, "filesystem=deny must still hide native file tools");
    assert.deepEqual(profileContexts.at(-1), {
      profile: "recorded",
      sessionKey: "sdk:host-sandbox-no-filesystem",
      cwd: projectRoot,
      readOnly: false,
      workspaceMounted: false,
      networkDenied: false,
    });
    assert.equal(commands.filter((command) => command === "printf progress").length, 2);

    // A compatible profile may expose execute_code only in the unrestricted
    // host-sandbox case, where its helper RPC cannot bypass a deny/read-only
    // policy. The actual Python process is covered by the profile runner.
    model.reset();
    for await (const _event of local.gateway.submitTurn({
      sessionKey: "sdk:host-sandbox-execute-code",
      workspaceCwd: projectRoot,
      channelKey: "test",
      message: "Expose the profile-owned Python surface.",
      mode: "bypassPermissions",
      sdkSessionConfig: { sandbox: { type: "host", profile: "recorded" } },
    })) { /* consume */ }
    const profileExecuteCodeTools = new Set(model.requests[0]?.tools?.map((tool) => tool.name));
    assert.equal(profileExecuteCodeTools.has("bash"), true);
    assert.equal(profileExecuteCodeTools.has("execute_code"), true);

    model.reset();
    for await (const _event of local.gateway.submitTurn({
      sessionKey: "sdk:host-sandbox-untrusted-execute-code",
      workspaceCwd: projectRoot,
      channelKey: "test",
      message: "Do not expose Python through a profile that did not opt in.",
      mode: "bypassPermissions",
      sdkSessionConfig: { sandbox: { type: "host", profile: "untrusted" } },
    })) { /* consume */ }
    const untrustedExecuteCodeTools = new Set(model.requests[0]?.tools?.map((tool) => tool.name));
    assert.equal(untrustedExecuteCodeTools.has("bash"), true);
    assert.equal(untrustedExecuteCodeTools.has("execute_code"), false);

    model.reset();
    for await (const _event of local.gateway.submitTurn({
      sessionKey: "sdk:host-sandbox-untrusted-no-filesystem",
      workspaceCwd: projectRoot,
      channelKey: "test",
      message: "Do not trust an unspecified host profile with the workspace boundary.",
      mode: "bypassPermissions",
      sdkSessionConfig: { sandbox: { type: "host", profile: "untrusted", filesystem: "deny" } },
    })) { /* consume */ }
    const untrustedDenyFilesystemTools = new Set(model.requests[0]?.tools?.map((tool) => tool.name));
    assert.equal(
      untrustedDenyFilesystemTools.has("bash"),
      false,
      "a host profile must explicitly declare workspace-free execution before Bash stays visible",
    );

    model.reset();
    for await (const _event of local.gateway.submitTurn({
      sessionKey: "sdk:host-sandbox-untrusted-no-network",
      workspaceCwd: projectRoot,
      channelKey: "test",
      message: "Do not trust an unspecified host profile with network isolation.",
      mode: "bypassPermissions",
      sdkSessionConfig: { sandbox: { type: "host", profile: "untrusted", network: "deny" } },
    })) { /* consume */ }
    const untrustedDenyNetworkTools = new Set(model.requests[0]?.tools?.map((tool) => tool.name));
    assert.equal(
      untrustedDenyNetworkTools.has("bash"),
      false,
      "a host profile must explicitly declare network isolation before Bash stays visible",
    );

    model.reset();
    for await (const _event of local.gateway.submitTurn({
      sessionKey: "sdk:host-sandbox-strict",
      workspaceCwd: projectRoot,
      channelKey: "test",
      message: "Use only the OS-isolated command surface.",
      mode: "bypassPermissions",
      sdkSessionConfig: {
        sandbox: { type: "host", profile: "recorded", toolIsolation: "strict", network: "deny" },
      },
    })) { /* consume */ }
    const strictTools = new Set(model.requests[0]?.tools?.map((tool) => tool.name));
    assert.equal(strictTools.has("bash"), true, "strict host isolation retains the profile-owned runner");
    for (const name of [
      "read_file", "glob", "grep", "write_file", "edit_file", "edit_notebook",
      "send_attachment", "execute_code", "agent", "web_fetch", "web_search", "read_skill",
    ]) {
      assert.equal(strictTools.has(name), false, `${name} must not bypass strict host isolation`);
    }

    const server = await startGatewayServer({
      gateway: local.gateway,
      port: 0,
      token: "sdk-host-sandbox-strict-token",
    });
    try {
      model.reset();
      const run = query({
        prompt: "Run only through the strict host profile.",
        options: {
          gatewayUrl: server.wsUrl,
          authToken: server.token,
          projectKey: projectRoot,
          sandbox: { type: "host", profile: "recorded", toolIsolation: "strict", network: "deny" },
        },
      });
      for await (const _event of run) { /* consume */ }
      assert.equal((await run.result()).status, "completed");
      run.close();
      const publicStrictTools = new Set(model.requests[0]?.tools?.map((tool) => tool.name));
      assert.equal(publicStrictTools.has("bash"), true);
      assert.equal(publicStrictTools.has("read_file"), false);
      assert.equal(publicStrictTools.has("web_fetch"), false);
    } finally {
      await server.close();
    }

    const unavailable: any[] = [];
    for await (const event of local.gateway.submitTurn({
      sessionKey: "sdk:host-sandbox-unavailable",
      workspaceCwd: projectRoot,
      channelKey: "test",
      message: "This profile does not exist.",
      mode: "bypassPermissions",
      sdkSessionConfig: { sandbox: { type: "host", profile: "missing" } },
    })) unavailable.push(event);
    assert.match(JSON.stringify(unavailable), /SDK_SANDBOX_PROFILE_UNAVAILABLE/);
  } finally {
    local.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("Gateway runs host-profile execute_code through the profile-owned command runner", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-host-sandbox-code-"));
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, "pilotdeck.yaml"), TEST_CONFIG, "utf8");
  const model = new ExecuteCodeSandboxModel();
  const runnerCalls: Array<{ command: string; env?: NodeJS.ProcessEnv; toolsModule?: string }> = [];
  const local = createLocalGateway({
    projectRoot,
    pilotHome: projectRoot,
    fallbackProjectRoot: projectRoot,
    env: { TEST_ONLY_SECRET: "must-not-cross-the-boundary" },
    permissionMode: "bypassPermissions",
    sandboxProfiles: {
      python: createBubblewrapSandboxProfile({
        enableStrictExecuteCode: true,
        createRunner: () => ({
          async run(command, options) {
            const tempRoot = options.env?.PILOTDECK_EXECUTE_CODE_TEMP_ROOT;
            runnerCalls.push({
              command,
              env: options.env,
              ...(tempRoot ? { toolsModule: await readFile(join(tempRoot, "pilotdeck_tools.py"), "utf8") } : {}),
            });
            return {
              exitCode: 0,
              stdout: "profile-execute-code\n",
              stderr: "",
              timedOut: false,
              durationMs: 1,
            };
          },
        }),
      }),
    },
    __testModelFactory: () => model,
  });
  try {
    const events: any[] = [];
    for await (const event of local.gateway.submitTurn({
      sessionKey: "sdk:host-sandbox-execute-code-run",
      workspaceCwd: projectRoot,
      channelKey: "test",
      message: "Run the profile-owned Python script.",
      mode: "bypassPermissions",
      sdkSessionConfig: {
        sandbox: { type: "host", profile: "python", filesystem: "read_only", network: "deny" },
      },
    })) events.push(event);

    assert.equal(model.requests[0]?.tools?.some((tool) => tool.name === "execute_code"), true);
    const executeCodeTool = model.requests[0]?.tools?.find((tool) => tool.name === "execute_code");
    assert.doesNotMatch(executeCodeTool?.description ?? "", /write_file|edit_file|web_fetch|web_search/);
    assert.equal(runnerCalls.length, 1);
    assert.match(runnerCalls[0]?.command ?? "", /^python3 '.*script\.py'$/);
    assert.equal(typeof runnerCalls[0]?.env?.PILOTDECK_RPC_SOCKET, "string");
    assert.equal(typeof runnerCalls[0]?.env?.PILOTDECK_EXECUTE_CODE_TEMP_ROOT, "string");
    assert.equal(runnerCalls[0]?.env?.TEST_ONLY_SECRET, undefined);
    assert.match(JSON.stringify(events), /profile-execute-code/);

    // Strict profile execution is an explicit host opt-in. The model can use
    // Python through the profile-owned runner, but it receives no helper
    // functions and cannot route through Gateway tool RPCs.
    model.reset();
    const strictEvents: any[] = [];
    for await (const event of local.gateway.submitTurn({
      sessionKey: "sdk:host-sandbox-execute-code-strict",
      workspaceCwd: projectRoot,
      channelKey: "test",
      message: "Run Python only inside the strict profile.",
      mode: "bypassPermissions",
      sdkSessionConfig: {
        sandbox: { type: "host", profile: "python", toolIsolation: "strict", network: "deny" },
      },
    })) strictEvents.push(event);

    const strictTool = model.requests[0]?.tools?.find((tool) => tool.name === "execute_code");
    assert.ok(strictTool, "the explicitly opted-in profile retains execute_code");
    if (!strictTool) throw new Error("strict profile did not expose execute_code");
    const strictDescription = strictTool.description ?? "";
    assert.match(strictDescription, /No PilotDeck helper RPC is available/);
    assert.doesNotMatch(strictDescription, /web_fetch|web_search|read_file|write_file|edit_file|grep|glob|\bbash\b/);
    assert.equal(runnerCalls.length, 2);
    assert.equal(runnerCalls[1]?.env?.TEST_ONLY_SECRET, undefined);
    assert.match(runnerCalls[1]?.toolsModule ?? "", /No PilotDeck helper RPC is available/);
    assert.doesNotMatch(runnerCalls[1]?.toolsModule ?? "", /def (?:web_fetch|web_search|read_file|write_file|edit_file|grep|glob|bash)|socket|_call/);
    assert.match(JSON.stringify(strictEvents), /profile-execute-code/);
  } finally {
    local.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("embedded tool registry updates a local Gateway without a callback RPC", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-embedded-registry-"));
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, "pilotdeck.yaml"), TEST_CONFIG, "utf8");
  const model = new EmbeddedRegistryModel();
  const local = createLocalGateway({
    projectRoot,
    pilotHome: projectRoot,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
    __testModelFactory: () => model,
  });
  const tools = createEmbeddedToolRegistry();
  const detach = tools.attach(local);
  let calls = 0;
  try {
    tools.register(tool<{ value: string }>(
      "embedded_echo",
      "Echo a value in the local host process.",
      {
        type: "object",
        required: ["value"],
        additionalProperties: false,
        properties: { value: { type: "string" } },
      },
      async ({ value }) => {
        calls += 1;
        return { content: [{ type: "text", text: `embedded:${value}` }] };
      },
      { annotations: { readOnly: true } },
    ));

    const events: any[] = [];
    for await (const event of local.gateway.submitTurn({
      sessionKey: "sdk:embedded-registry",
      workspaceCwd: projectRoot,
      channelKey: "test",
      message: "Use the local embedded echo tool.",
      mode: "bypassPermissions",
    })) events.push(event);

    assert.equal(calls, 1);
    assert.equal(model.requests[0]?.tools?.some((entry) => entry.name === "embedded_echo"), true);
    assert.match(JSON.stringify(events), /embedded:local value/);
  } finally {
    detach();
    local.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("embedded host composes an authoritative Gateway client with local TypeScript tools", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-embedded-host-"));
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, "pilotdeck.yaml"), TEST_CONFIG, "utf8");
  const model = new EmbeddedRegistryModel();
  const local = createLocalGateway({
    projectRoot,
    pilotHome: projectRoot,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
    __testModelFactory: () => model,
  });
  const endpoint = createEmbeddedGatewayEndpoint({
    gateway: local.gateway,
    token: "embedded-host-test-token",
  });
  const mirrorSnapshots = new Map<string, any>();
  const mirrorKey = (key: { projectKey: string; sessionId: string; subpath?: string }) =>
    `${key.projectKey}\0${key.sessionId}\0${key.subpath ?? ""}`;
  let calls = 0;
  const host = createEmbeddedPilotDeckHost({
    connection: { endpoint, token: "embedded-host-test-token" },
    projectKey: projectRoot,
    channelKey: "embedded-host-test",
    permissionMode: "bypassPermissions",
    sessionStore: createEmbeddedSessionStore({
      read: async (key) => structuredClone(mirrorSnapshots.get(mirrorKey(key)) ?? null),
      write: async (snapshot) => { mirrorSnapshots.set(mirrorKey(snapshot.key), structuredClone(snapshot)); },
    }),
    sessionStoreFlush: "eager",
    gatewayHost: local,
    localTools: [tool<{ value: string }>(
      "embedded_echo",
      "Echo a local host value.",
      {
        type: "object",
        required: ["value"],
        additionalProperties: false,
        properties: { value: { type: "string" } },
      },
      async ({ value }) => {
        calls += 1;
        return { content: [{ type: "text", text: `embedded:${value}` }] };
      },
      { annotations: { readOnly: true } },
    )],
  });
  try {
    const run = host.client.query("Use the embedded host tool.");
    const result = await run.result();

    assert.equal(result.status, "completed");
    assert.equal(calls, 1);
    assert.equal(model.requests[0]?.tools?.some((entry) => entry.name === "embedded_echo"), true);
    assert.match(String(result.output ?? ""), /embedded tool completed/);
    assert.equal((await local.gateway.listSessions({ projectKey: projectRoot })).sessions.length, 1);
    assert.equal(mirrorSnapshots.size, 1, "the host persistence receives the SDK event mirror only");

    await host.close();
    assert.equal(
      (await local.gateway.listSessions({ projectKey: projectRoot })).sessions.length,
      1,
      "closing the SDK composition must not dispose the host-owned Gateway",
    );
  } finally {
    await host.close();
    local.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("embedded query runs through the authoritative Gateway wire dispatcher", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-embedded-query-"));
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, "pilotdeck.yaml"), TEST_CONFIG, "utf8");
  const local = createLocalGateway({
    projectRoot,
    pilotHome: projectRoot,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
    __testModelFactory: () => new TitleModel(),
  });
  const endpoint = createEmbeddedGatewayEndpoint({
    gateway: local.gateway,
    token: "embedded-sdk-test-token",
  });
  try {
    const run = createEmbeddedQuery({
      prompt: "Return a short embedded answer.",
      options: {
        projectKey: projectRoot,
        channelKey: "embedded-test",
        permissionMode: "bypassPermissions",
      },
      connection: { endpoint, token: "embedded-sdk-test-token" },
    });
    const events: any[] = [];
    for await (const event of run) events.push(event);
    const result = await run.result();

    assert.equal(result.status, "completed");
    assert.equal(events.length > 0, true);
    assert.equal(events.some((event) => event.type === "result"), true);
    const sessions = await local.gateway.listSessions({ projectKey: projectRoot });
    assert.equal(sessions.sessions.length, 1, "the embedded client must create a normal Gateway-owned session");
  } finally {
    endpoint.close();
    local.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("embedded client resources and runs use the authoritative Gateway without a listener", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-embedded-client-"));
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, "pilotdeck.yaml"), TEST_CONFIG, "utf8");
  const local = createLocalGateway({
    projectRoot,
    pilotHome: projectRoot,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
    __testModelFactory: () => new TitleModel(),
  });
  const endpoint = createEmbeddedGatewayEndpoint({
    gateway: local.gateway,
    token: "embedded-sdk-client-test-token",
  });
  const client = createEmbeddedPilotDeckClient({
    connection: { endpoint, token: "embedded-sdk-client-test-token" },
    projectKey: projectRoot,
    channelKey: "embedded-client-test",
    permissionMode: "bypassPermissions",
  });
  try {
    assert.equal((await client.connect()).protocolVersion, "1.1");
    const session = await client.sessions.create();
    assert.equal(session.projectKey, projectRoot);

    const run = client.runs.start({
      sessionId: session.sessionId,
      input: { type: "text", text: "Return a short embedded client answer." },
    });
    const result = await run.result();
    assert.equal(result.status, "completed");
    await client.close();
  } finally {
    endpoint.close();
    local.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("SDK last-turn replacement keeps the transaction in the Gateway", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-last-turn-replacement-"));
  const projectRoot = join(root, "project");
  const sessionKey = "sdk:last-turn-replacement";
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, "pilotdeck.yaml"), TEST_CONFIG, "utf8");
  const storage = createAgentProjectSessionStorage({
    projectRoot,
    pilotHome: projectRoot,
    sessionId: sessionKey,
  });
  await storage.transcript.recordAcceptedInput(sessionKey, "turn-original", [{
    role: "user",
    content: [{ type: "text", text: "original request" }],
  }]);
  await storage.transcript.recordDurableMessage(sessionKey, "turn-original", {
    role: "assistant",
    content: [{ type: "text", text: "original answer" }],
  });
  const original = await readFile(storage.transcriptPath, "utf8");

  const local = createLocalGateway({
    projectRoot,
    pilotHome: projectRoot,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
    __testModelFactory: () => new TitleModel(),
  });
  const server = await startGatewayServer({
    gateway: local.gateway,
    port: 0,
    token: "sdk-last-turn-replacement-token",
  });
  const client = createPilotDeckClient({
    gatewayUrl: server.wsUrl,
    authToken: server.token,
    projectKey: projectRoot,
    channelKey: "sdk-last-turn-replacement",
    permissionMode: "bypassPermissions",
  });
  try {
    const abandoned = await client.sessions.prepareLastTurnReplacement(sessionKey, {
      projectKey: projectRoot,
      expectedTurnId: "turn-original",
    });
    await abandoned.rollback();
    assert.equal(
      await readFile(storage.transcriptPath, "utf8"),
      original,
      "rollback must restore the Gateway-owned transcript before any replacement run begins.",
    );

    const replacement = await client.sessions.prepareLastTurnReplacement(sessionKey, {
      projectKey: projectRoot,
      expectedTurnId: "turn-original",
    });
    const run = replacement.start({ type: "text", text: "corrected request" });
    assert.equal((await run.result()).status, "completed");
    await assert.rejects(() => replacement.rollback(), { code: "conflict" });

    const transcript = await readFile(storage.transcriptPath, "utf8");
    assert.match(transcript, /corrected request/);
    assert.doesNotMatch(transcript, /original request|original answer/);
    assert.equal(
      (await readdir(storage.chatDir)).some((file) => file.includes(".replace.")),
      false,
      "the Gateway commits the durable transaction after accepting the replacement input.",
    );
  } finally {
    await client.close();
    await server.close();
    local.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("PilotDeckClient mcp resource configures Gateway-owned session MCP without a Query", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-mcp-resource-"));
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, "pilotdeck.yaml"), TEST_CONFIG, "utf8");

  const local = createLocalGateway({
    projectRoot,
    pilotHome: projectRoot,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
    __testModelFactory: () => new TitleModel(),
  });
  const server = await startGatewayServer({
    gateway: local.gateway,
    port: 0,
    token: "sdk-mcp-resource-token",
  });
  const client = createPilotDeckClient({
    gatewayUrl: server.wsUrl,
    authToken: server.token,
    projectKey: projectRoot,
    channelKey: "sdk-mcp-resource",
  });
  const hosted = createSdkMcpServer({
    name: "sdk-mcp-resource-test",
    tools: [tool("lookup", "Looks up a ticket.", { ticket: "string" }, async (input) => {
      const { ticket } = input as { ticket: string };
      return { content: [{ type: "text", text: `ticket:${ticket}` }] };
    })],
  });
  const sessionId = "sdk:mcp-resource";
  try {
    assert.deepEqual(await client.mcp.setServers({
      sessionId,
      servers: { tickets: hosted },
      strict: true,
    }), { added: ["tickets"], removed: [], errors: [] });
    assert.equal((await client.mcp.status({ sessionId })).find((status) => status.name === "tickets")?.status, "configured");

    await client.mcp.toggle({ sessionId, serverName: "tickets", enabled: false });
    assert.equal((await client.mcp.status({ sessionId })).find((status) => status.name === "tickets")?.status, "disabled");
    await assert.rejects(
      () => client.mcp.reconnect({ sessionId, serverName: "tickets" }),
      { code: "mcp_server_disabled" },
    );

    await client.mcp.toggle({ sessionId, serverName: "tickets", enabled: true });
    await client.mcp.reconnect({ sessionId, serverName: "tickets" });
    assert.equal((await client.mcp.status({ sessionId })).find((status) => status.name === "tickets")?.status, "configured");
    assert.match(
      (await client.mcp.setPermissionModeOverride({ sessionId, serverName: "tickets", mode: "auto" })).warning ?? "",
      /conservative ask semantics/,
    );
    assert.deepEqual(
      await client.mcp.setPermissionModeOverride({ sessionId, serverName: "tickets", mode: null }),
      {},
    );
  } finally {
    await hosted.close();
    await client.close();
    await server.close();
    local.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("Gateway nativeSessionStorage routes SDK session lifecycle through a host-owned native layout", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-native-storage-"));
  const projectRoot = join(root, "project");
  const storageHome = join(root, "native-storage");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, "pilotdeck.yaml"), TEST_CONFIG, "utf8");
  const storageResolutions: string[] = [];
  let chatDirectoryResolutions = 0;
  const local = createLocalGateway({
    projectRoot,
    pilotHome: projectRoot,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
    nativeSessionStorage: {
      getProjectChatDir: (input) => {
        chatDirectoryResolutions += 1;
        return createAgentProjectSessionStorage({ ...input, sessionId: "chat-dir", pilotHome: storageHome }).chatDir;
      },
      createSessionStorage: (input) => {
        storageResolutions.push(input.sessionId);
        return createAgentProjectSessionStorage({ ...input, pilotHome: storageHome });
      },
    },
    __testModelFactory: () => new TitleModel(),
  });
  const endpoint = createEmbeddedGatewayEndpoint({
    gateway: local.gateway,
    token: "embedded-native-storage-token",
  });
  const client = createEmbeddedPilotDeckClient({
    connection: { endpoint, token: "embedded-native-storage-token" },
    projectKey: projectRoot,
    channelKey: "embedded-native-storage",
    permissionMode: "bypassPermissions",
  });
  try {
    const session = await client.sessions.create();
    const run = client.runs.start({
      sessionId: session.sessionId,
      input: { type: "text", text: "Persist this answer in host-controlled native storage." },
    });
    assert.equal((await run.result()).status, "completed");

    const nativeStorage = createAgentProjectSessionStorage({
      projectRoot,
      pilotHome: storageHome,
      sessionId: session.sessionId,
    });
    const defaultStorage = createAgentProjectSessionStorage({
      projectRoot,
      pilotHome: projectRoot,
      sessionId: session.sessionId,
    });
    assert.equal((await stat(nativeStorage.transcriptPath)).isFile(), true);
    await assert.rejects(stat(defaultStorage.transcriptPath));

    const listed = await client.sessions.list({ projectKey: projectRoot });
    assert.equal(listed.length, 1, "session listing must scan the adapter-owned native chat directory");
    const messages = await client.sessions.messages(session.sessionId, { projectKey: projectRoot });
    assert.ok(messages.length > 0, "message read must use the adapter-owned transcript");

    const forked = await client.sessions.fork(session.sessionId, { projectKey: projectRoot });
    assert.ok(forked.sessionId, "Gateway fork must return its created session id");
    const forkedSessionId = forked.sessionId;
    const forkedStorage = createAgentProjectSessionStorage({
      projectRoot,
      pilotHome: storageHome,
      sessionId: forkedSessionId,
    });
    assert.equal((await stat(forkedStorage.transcriptPath)).isFile(), true);

    const archive = await client.sessions.exportTranscript(session.sessionId, { projectKey: projectRoot });
    const restored = await client.sessions.restoreTranscript(archive, { projectKey: projectRoot });
    const restoredStorage = createAgentProjectSessionStorage({
      projectRoot,
      pilotHome: storageHome,
      sessionId: restored.sessionId,
    });
    assert.equal((await stat(restoredStorage.transcriptPath)).isFile(), true);
    await client.sessions.delete(restored.sessionId, { projectKey: projectRoot });
    await assert.rejects(stat(restoredStorage.transcriptPath));

    assert.equal(storageResolutions.includes(session.sessionId), true);
    assert.equal(storageResolutions.includes(forkedSessionId), true);
    assert.equal(storageResolutions.includes(restored.sessionId), true);
    assert.ok(chatDirectoryResolutions > 0, "session listing must resolve the host-owned project chat directory");
  } finally {
    await client.close();
    endpoint.close();
    local.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("Gateway restores external tool-result payloads for read_file and cleans them on delete", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-async-tool-result-store-"));
  const projectRoot = join(root, "project");
  const sessionKey = "sdk:async-tool-result-store";
  const records = new Map<string, unknown[]>();
  const payloads = new Map<string, Uint8Array>();
  const payloadKey = (transcriptPath: string, artifactName: string) =>
    `${transcriptPath}\u0000${artifactName}`;
  const nativeSessionStorage = createGatewayAsyncTranscriptStorageAdapter({
    store: {
      async append(key, entry) {
        const entries = records.get(key.transcriptPath) ?? [];
        entries.push(structuredClone(entry));
        records.set(key.transcriptPath, entries);
      },
      async read(key) {
        return { entries: structuredClone(records.get(key.transcriptPath) ?? []) as any[], diagnostics: [] };
      },
      async has(key) {
        return records.has(key.transcriptPath);
      },
      async delete(key) {
        records.delete(key.transcriptPath);
      },
      toolResultArtifacts: {
        async write(key, artifactName, bytes) {
          payloads.set(payloadKey(key.transcriptPath, artifactName), bytes.slice());
        },
        async read(key, artifactName) {
          return payloads.get(payloadKey(key.transcriptPath, artifactName))?.slice();
        },
        async delete(key, artifactName) {
          payloads.delete(payloadKey(key.transcriptPath, artifactName));
        },
        async deleteAll(key) {
          const prefix = `${key.transcriptPath}\u0000`;
          for (const recordKey of payloads.keys()) {
            if (recordKey.startsWith(prefix)) payloads.delete(recordKey);
          }
        },
      },
    },
  });
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, "pilotdeck.yaml"), TEST_CONFIG, "utf8");
  const storage = nativeSessionStorage.createSessionStorage({
    projectRoot,
    pilotHome: projectRoot,
    sessionId: sessionKey,
  });
  const payload = `restart tool-result marker\n${"payload ".repeat(80)}`;
  const budget = new ToolResultBudget({
    toolResultsDir: storage.toolResultsDir,
    artifactStorage: storage.toolResultArtifactStorage,
    maxResultSizeChars: 64,
    maxResultSizeTokens: 20,
    previewBytes: 32,
  });
  const persisted = await budget.applyToMessage({
    role: "user",
    content: [{
      type: "tool_result",
      toolCallId: "seed-host-tool-result",
      content: [{ type: "text", text: payload }],
    }],
  }, { turnId: "seed-turn" });
  const reference = persisted.content.find((block) => block.type === "tool_result_reference");
  if (!reference || reference.type !== "tool_result_reference" || !reference.readFilePath) {
    throw new Error("Expected a persisted tool-result reference with a read_file alias.");
  }
  await storage.transcript.recordAcceptedInput(sessionKey, "seed-turn", [{
    role: "user",
    content: [{ type: "text", text: "seed persistent result" }],
  }]);
  await storage.transcript.recordDurableMessage(sessionKey, "seed-turn", persisted);
  await storage.transcript.recordTurnResult(sessionKey, "seed-turn", {
    type: "success",
    sessionId: sessionKey,
    turnId: "seed-turn",
    stopReason: "completed",
    usage: {},
    permissionDenials: [],
    turns: 1,
    startedAt: "2026-09-10T00:00:00.000Z",
    completedAt: "2026-09-10T00:00:01.000Z",
  });
  await rm(storage.toolResultsDir, { recursive: true, force: true });

  const local = createLocalGateway({
    projectRoot,
    pilotHome: projectRoot,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
    nativeSessionStorage,
    __testModelFactory: () => new RestoredToolResultCacheModel(reference.readFilePath!),
  });
  try {
    const events: any[] = [];
    for await (const event of local.gateway.submitTurn({
      sessionKey,
      workspaceCwd: projectRoot,
      channelKey: "test",
      message: "read the restored host payload",
      mode: "bypassPermissions",
      runId: "restore-host-payload-turn",
    })) events.push(event);
    const readResult = events.find((event) =>
      event.type === "tool_call_finished" && event.toolCallId === "read-restored-tool-result",
    );
    assert.match(readResult?.resultPreview ?? "", /restart tool-result marker/);
    assert.equal(await readFile(join(projectRoot, reference.readFilePath), "utf8"), payload);

    await local.gateway.deleteSession!({ sessionKey, projectKey: projectRoot });
    assert.equal(payloads.size, 0, "Gateway delete must clear host-owned tool-result payloads");
  } finally {
    local.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("Gateway async transcript storage resumes and projects SDK sessions through a host-owned store", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-async-transcript-store-"));
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, "pilotdeck.yaml"), TEST_CONFIG, "utf8");

  const records = new Map<string, unknown[]>();
  const sessionIndex = new Map<string, { sessionId: string; transcriptPath: string; lastModified: number }>();
  const replacementBackups = new Map<string, {
    transcriptPath: string;
    replacementTurnId: string;
    entries: unknown[];
  }>();
  let recoveryEnabled = false;
  let readCount = 0;
  const store = {
    async append(key: { sessionId: string; transcriptPath: string }, entry: unknown) {
      const entries = records.get(key.transcriptPath) ?? [];
      entries.push(structuredClone(entry));
      records.set(key.transcriptPath, entries);
      sessionIndex.set(key.sessionId, {
        sessionId: key.sessionId,
        transcriptPath: key.transcriptPath,
        lastModified: Date.now(),
      });
    },
    async read(key: { transcriptPath: string }) {
      readCount += 1;
      return { entries: structuredClone(records.get(key.transcriptPath) ?? []) as any[], diagnostics: [] };
    },
    async list() {
      return [...sessionIndex.values()].map(({ sessionId, lastModified, transcriptPath }) => ({
        sessionId,
        lastModified,
        fileSize: records.get(transcriptPath)?.length,
      }));
    },
    async has(key: { transcriptPath: string }) {
      return records.has(key.transcriptPath);
    },
    async delete(key: { transcriptPath: string }) {
      records.delete(key.transcriptPath);
      for (const [sessionId, record] of sessionIndex) {
        if (record.transcriptPath === key.transcriptPath) sessionIndex.delete(sessionId);
      }
    },
    async deleteSession(key: { sessionId: string; transcriptPath: string }) {
      const sessionDirPrefix = key.transcriptPath.replace(/\.jsonl$/i, "");
      for (const transcriptPath of records.keys()) {
        if (transcriptPath === key.transcriptPath || transcriptPath.startsWith(`${sessionDirPrefix}/`)) {
          records.delete(transcriptPath);
        }
      }
      sessionIndex.delete(key.sessionId);
    },
    async replace(key: { sessionId: string; transcriptPath: string }, entries: readonly unknown[]) {
      records.set(key.transcriptPath, structuredClone(entries) as unknown[]);
      sessionIndex.set(key.sessionId, {
        sessionId: key.sessionId,
        transcriptPath: key.transcriptPath,
        lastModified: Date.now(),
      });
    },
    async prepareReplacement(
      key: { transcriptPath: string },
      input: { transactionId: string; replacementTurnId: string; entries: readonly unknown[] },
    ) {
      replacementBackups.set(input.transactionId, {
        transcriptPath: key.transcriptPath,
        replacementTurnId: input.replacementTurnId,
        entries: structuredClone(records.get(key.transcriptPath) ?? []) as unknown[],
      });
      records.set(key.transcriptPath, structuredClone(input.entries) as unknown[]);
    },
    async finalizeReplacement(
      _key: { transcriptPath: string },
      input: { transactionId: string; action: "commit" | "rollback" },
    ) {
      const backup = replacementBackups.get(input.transactionId);
      if (!backup) throw new Error(`Missing replacement transaction ${input.transactionId}`);
      if (input.action === "rollback") records.set(backup.transcriptPath, structuredClone(backup.entries) as unknown[]);
      replacementBackups.delete(input.transactionId);
    },
    async recoverReplacements(key: { transcriptPath: string }) {
      if (!recoveryEnabled) return;
      for (const [transactionId, backup] of replacementBackups) {
        if (backup.transcriptPath !== key.transcriptPath) continue;
        const entries = records.get(key.transcriptPath) ?? [];
        const accepted = entries.some((entry) =>
          typeof entry === "object"
          && entry !== null
          && (entry as { type?: unknown }).type === "accepted_input"
          && (entry as { turnId?: unknown }).turnId === backup.replacementTurnId,
        );
        if (!accepted) {
          records.set(key.transcriptPath, structuredClone(backup.entries) as unknown[]);
        }
        replacementBackups.delete(transactionId);
      }
    },
  };
  const nativeSessionStorage = createGatewayAsyncTranscriptStorageAdapter({ store });
  const createHost = () => createLocalGateway({
    projectRoot,
    pilotHome: projectRoot,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
    nativeSessionStorage,
    __testModelFactory: () => new TitleModel(),
  });

  let local = createHost();
  let endpoint = createEmbeddedGatewayEndpoint({
    gateway: local.gateway,
    token: "embedded-async-transcript-store-token",
  });
  let client = createEmbeddedPilotDeckClient({
    connection: { endpoint, token: "embedded-async-transcript-store-token" },
    projectKey: projectRoot,
    channelKey: "embedded-async-transcript-store",
    permissionMode: "bypassPermissions",
  });
  try {
    const session = await client.sessions.create();
    const sessionId = session.sessionId;
    assert.equal((await client.runs.start({
      sessionId,
      input: { type: "text", text: "first async transcript turn" },
    }).result()).status, "completed");

    const storage = createAgentProjectSessionStorage({ projectRoot, pilotHome: projectRoot, sessionId });
    await assert.rejects(stat(storage.transcriptPath), "the async adapter must not write the primary JSONL file");
    assert.ok(records.get(storage.transcriptPath)?.length, "the host store must receive transcript records");

    await client.close();
    endpoint.close();
    local.dispose();

    local = createHost();
    endpoint = createEmbeddedGatewayEndpoint({
      gateway: local.gateway,
      token: "embedded-async-transcript-store-token",
    });
    client = createEmbeddedPilotDeckClient({
      connection: { endpoint, token: "embedded-async-transcript-store-token" },
      projectKey: projectRoot,
      channelKey: "embedded-async-transcript-store",
      permissionMode: "bypassPermissions",
    });
    assert.equal((await client.runs.start({
      sessionId,
      input: { type: "text", text: "second async transcript turn" },
    }).result()).status, "completed");

    const messages = await client.sessions.messages(sessionId, { projectKey: projectRoot });
    assert.ok(messages.some((message) => typeof message.text === "string" && message.text.includes("first async transcript turn")));
    assert.ok(messages.some((message) => typeof message.text === "string" && message.text.includes("second async transcript turn")));
    assert.ok((await client.sessions.list({ projectKey: projectRoot })).some((listed) => listed.sessionId === sessionId));
    assert.ok(readCount >= 3, "resume and message projection must read through the host store");

    const expectedTurnValue = [...messages]
      .reverse()
      .find((message) => message.text === "second async transcript turn" && typeof message.turnId === "string")
      ?.turnId;
    const expectedTurnId = typeof expectedTurnValue === "string" ? expectedTurnValue : undefined;
    if (!expectedTurnId) throw new Error("Could not locate the latest async-store user turn.");
    const abandonedReplacement = await client.sessions.prepareLastTurnReplacement(sessionId, {
      projectKey: projectRoot,
      expectedTurnId,
    });
    await abandonedReplacement.rollback();
    assert.ok((await client.sessions.messages(sessionId, { projectKey: projectRoot }))
      .some((message) => message.text === "second async transcript turn"));

    const replacement = await client.sessions.prepareLastTurnReplacement(sessionId, {
      projectKey: projectRoot,
      expectedTurnId,
    });
    assert.equal((await replacement.start({ type: "text", text: "replacement host store turn" }).result()).status, "completed");
    const messagesAfterReplacement = await client.sessions.messages(sessionId, { projectKey: projectRoot });
    assert.ok(messagesAfterReplacement.some((message) => message.text === "replacement host store turn"));
    assert.equal(messagesAfterReplacement.some((message) => message.text === "second async transcript turn"), false);
    assert.equal(replacementBackups.size, 0, "Gateway must finalize the host-owned replacement transaction after input acceptance");

    const forked = await client.sessions.fork(sessionId, { projectKey: projectRoot });
    if (!forked.sessionId) throw new Error("Gateway did not return a fork session id.");
    const forkedSessionId = forked.sessionId;
    const forkedStorage = createAgentProjectSessionStorage({
      projectRoot,
      pilotHome: projectRoot,
      sessionId: forkedSessionId,
    });
    await assert.rejects(stat(forkedStorage.transcriptPath), "external fork must not create a primary JSONL file");
    const forkedMessages = await client.sessions.messages(forkedSessionId, { projectKey: projectRoot });
    assert.ok(forkedMessages.some((message) => typeof message.text === "string" && message.text.includes("first async transcript turn")));

    const recoveryExpectedTurnValue = [...messagesAfterReplacement]
      .reverse()
      .find((message) => message.text === "replacement host store turn" && typeof message.turnId === "string")
      ?.turnId;
    const recoveryExpectedTurnId = typeof recoveryExpectedTurnValue === "string" ? recoveryExpectedTurnValue : undefined;
    if (!recoveryExpectedTurnId) throw new Error("Could not locate the host-store turn for recovery.");
    await client.sessions.prepareLastTurnReplacement(sessionId, {
      projectKey: projectRoot,
      expectedTurnId: recoveryExpectedTurnId,
    });
    assert.equal(replacementBackups.size, 1, "the simulated crash must leave a host-owned replacement transaction");
    await client.close();
    endpoint.close();
    local.dispose();
    recoveryEnabled = true;
    local = createHost();
    endpoint = createEmbeddedGatewayEndpoint({
      gateway: local.gateway,
      token: "embedded-async-transcript-store-token",
    });
    client = createEmbeddedPilotDeckClient({
      connection: { endpoint, token: "embedded-async-transcript-store-token" },
      projectKey: projectRoot,
      channelKey: "embedded-async-transcript-store",
      permissionMode: "bypassPermissions",
    });
    const recoveredMessages = await client.sessions.messages(sessionId, { projectKey: projectRoot });
    assert.ok(
      recoveredMessages.some((message) => message.text === "replacement host store turn"),
      "the new Gateway must let the host rollback an abandoned external replacement before projection",
    );
    assert.equal(replacementBackups.size, 0, "host recovery must finalize abandoned transactions before projection");

    const archive = await client.sessions.exportTranscript(sessionId, { projectKey: projectRoot });
    const deletedSessionStorage = nativeSessionStorage.createSessionStorage({
      projectRoot,
      pilotHome: projectRoot,
      sessionId,
    });
    const deletionSentinelSidechain = deletedSessionStorage.subagentTranscriptPath("delete-sentinel");
    records.set(deletionSentinelSidechain, []);
    await client.sessions.delete(sessionId, { projectKey: projectRoot });
    assert.equal(records.has(storage.transcriptPath), false, "Gateway delete must remove the host-owned transcript");
    assert.equal(records.has(deletionSentinelSidechain), false, "Gateway delete must remove host-owned sidechain payloads");
    assert.equal((await client.sessions.list({ projectKey: projectRoot })).some((listed) => listed.sessionId === sessionId), false);

    const restored = await client.sessions.restoreTranscript(archive, { projectKey: projectRoot });
    const restoredStorage = createAgentProjectSessionStorage({
      projectRoot,
      pilotHome: projectRoot,
      sessionId: restored.sessionId,
    });
    await assert.rejects(stat(restoredStorage.transcriptPath), "external restore must not create a primary JSONL file");
    const restoredMessages = await client.sessions.messages(restored.sessionId, { projectKey: projectRoot });
    assert.ok(restoredMessages.some((message) => typeof message.text === "string" && message.text.includes("first async transcript turn")));

    const sidechainStorage = nativeSessionStorage.createSessionStorage({
      projectRoot,
      pilotHome: projectRoot,
      sessionId: "sdk:async-sidechain",
    });
    const subagentId = "child-store-reader";
    await sidechainStorage.transcript.recordSubagentStarted("sdk:async-sidechain", "sidechain-turn", {
      subagentId,
      subagentType: "general-purpose",
      prompt: "Read the async sidechain transcript.",
      transcriptRelativePath: sidechainStorage.transcript.relativeSubagentPath(subagentId),
    });
    const sidechain = sidechainStorage.transcript.forSubagent(subagentId);
    await sidechain.writer.recordAcceptedInput("child-session", "child-turn", [{
      role: "user",
      content: [{ type: "text", text: "sidechain prompt" }],
    }]);
    await sidechain.writer.recordDurableMessage("child-session", "child-turn", {
      role: "assistant",
      content: [{ type: "text", text: "sidechain answer from host store" }],
    });
    const sidechainMessages = await readSubagentWebMessages({
      sessionKey: "sdk:async-sidechain",
      subagentId,
    }, {
      projectRoot,
      pilotHome: projectRoot,
      storage: sidechainStorage,
    });
    assert.ok(sidechainMessages.messages.some((message) => message.text === "sidechain answer from host store"));
  } finally {
    await client.close().catch(() => undefined);
    endpoint.close();
    local.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("Gateway async transcript storage copies referenced sidechain payloads for a session fork", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-async-sidechain-fork-"));
  const projectRoot = join(root, "project");
  const records = new Map<string, unknown[]>();
  const backupRecords = new Map<string, Uint8Array>();
  const toolResultRecords = new Map<string, Uint8Array>();
  const backupKey = (transcriptPath: string, backupFileName: string) =>
    `${transcriptPath}\u0000${backupFileName}`;
  const toolResultKey = (transcriptPath: string, artifactName: string) =>
    `${transcriptPath}\u0000${artifactName}`;
  const nativeSessionStorage = createGatewayAsyncTranscriptStorageAdapter({
    store: {
      async append(key, entry) {
        const entries = records.get(key.transcriptPath) ?? [];
        entries.push(structuredClone(entry));
        records.set(key.transcriptPath, entries);
      },
      async read(key) {
        return {
          entries: structuredClone(records.get(key.transcriptPath) ?? []) as any[],
          diagnostics: [],
        };
      },
      async replace(key, entries) {
        records.set(key.transcriptPath, structuredClone(entries) as unknown[]);
      },
      fileHistoryBackups: {
        async write(key, backupFileName, bytes) {
          backupRecords.set(backupKey(key.transcriptPath, backupFileName), bytes.slice());
        },
        async read(key, backupFileName) {
          return backupRecords.get(backupKey(key.transcriptPath, backupFileName))?.slice();
        },
        async delete(key, backupFileName) {
          backupRecords.delete(backupKey(key.transcriptPath, backupFileName));
        },
        async deleteAll(key) {
          const prefix = `${key.transcriptPath}\u0000`;
          for (const keyName of backupRecords.keys()) {
            if (keyName.startsWith(prefix)) backupRecords.delete(keyName);
          }
        },
      },
      toolResultArtifacts: {
        async write(key, artifactName, bytes) {
          toolResultRecords.set(toolResultKey(key.transcriptPath, artifactName), bytes.slice());
        },
        async read(key, artifactName) {
          return toolResultRecords.get(toolResultKey(key.transcriptPath, artifactName))?.slice();
        },
        async delete(key, artifactName) {
          toolResultRecords.delete(toolResultKey(key.transcriptPath, artifactName));
        },
        async deleteAll(key) {
          const prefix = `${key.transcriptPath}\u0000`;
          for (const keyName of toolResultRecords.keys()) {
            if (keyName.startsWith(prefix)) toolResultRecords.delete(keyName);
          }
        },
      },
    },
  });
  const storageForSession = (sessionId: string) => nativeSessionStorage.createSessionStorage({
    projectRoot,
    pilotHome: projectRoot,
    sessionId,
  });
  const sourceSessionId = "sdk:async-sidechain-fork-source";
  const sourceStorage = storageForSession(sourceSessionId);
  try {
    await sourceStorage.transcript.recordAcceptedInput(sourceSessionId, "parent-turn", [{
      role: "user",
      content: [{ type: "text", text: "Keep this parent and its child history." }],
    }]);
    const child = sourceStorage.transcript.forSubagent("child-agent");
    await sourceStorage.transcript.recordSubagentStarted(sourceSessionId, "parent-turn", {
      subagentId: child.subagentId,
      subagentType: "general-purpose",
      prompt: "Preserve this sidechain through a fork.",
      transcriptRelativePath: sourceStorage.transcript.relativeSubagentPath(child.subagentId),
    });
    await child.writer.recordAcceptedInput("child-session", "child-turn", [{
      role: "user",
      content: [{ type: "text", text: "Child sidechain input" }],
    }]);
    const grandchild = child.writer.forSubagent("grandchild-agent");
    await child.writer.recordSubagentStarted("child-session", "child-turn", {
      subagentId: grandchild.subagentId,
      subagentType: "general-purpose",
      prompt: "Preserve nested sidechain payload too.",
      transcriptRelativePath: child.writer.relativeSubagentPath(grandchild.subagentId),
    });
    await child.writer.recordDurableMessage("child-session", "child-turn", {
      role: "assistant",
      content: [{ type: "text", text: "Child sidechain answer" }],
    });
    await grandchild.writer.recordAcceptedInput("grandchild-session", "grandchild-turn", [{
      role: "user",
      content: [{ type: "text", text: "Nested sidechain input" }],
    }]);
    await grandchild.writer.recordDurableMessage("grandchild-session", "grandchild-turn", {
      role: "assistant",
      content: [{ type: "text", text: "Nested sidechain answer" }],
    });
    const checkpointFile = join(projectRoot, "forked-checkpoint.txt");
    const checkpointBackupName = "forked-checkpoint@v1";
    await sourceStorage.fileHistoryBackupStorage!.write(
      checkpointBackupName,
      new TextEncoder().encode("checkpoint before fork\n"),
    );
    await sourceStorage.transcript.recordFileSnapshot(sourceSessionId, "parent-turn", {
      messageId: "parent-turn",
      trackedFileBackups: {
        [checkpointFile]: {
          backupFileName: checkpointBackupName,
          version: 1,
          backupTime: new Date("2026-09-10T00:00:00.000Z").toISOString(),
        },
      },
      snapshotTimestamp: new Date("2026-09-10T00:00:00.000Z").toISOString(),
    });
    const sourcePayload = `forked host artifact\n${"payload ".repeat(80)}`;
    const sourceBudget = new ToolResultBudget({
      toolResultsDir: sourceStorage.toolResultsDir,
      artifactStorage: sourceStorage.toolResultArtifactStorage,
      maxResultSizeChars: 64,
      maxResultSizeTokens: 20,
      previewBytes: 32,
    });
    const sourceToolResult = await sourceBudget.applyToMessage({
      role: "user",
      content: [{
        type: "tool_result",
        toolCallId: "forked-host-artifact",
        content: [{ type: "text", text: sourcePayload }],
      }],
    }, { turnId: "parent-turn" });
    const sourceReference = sourceToolResult.content.find((block) => block.type === "tool_result_reference");
    if (!sourceReference) throw new Error("Expected host-owned tool-result reference.");
    await sourceStorage.transcript.recordDurableMessage(sourceSessionId, "parent-turn", sourceToolResult);
    await sourceStorage.transcript.recordDurableMessage(sourceSessionId, "parent-turn", {
      role: "assistant",
      content: [{ type: "text", text: "Parent answer after child execution" }],
    });

    const sourceTranscript = await sourceStorage.readTranscript!();
    const forkPoint = sourceTranscript.entries.find(
      (entry) => entry.type === "assistant_message" && entry.turnId === "parent-turn",
    );
    if (!forkPoint?.entryId) throw new Error("Expected an assistant transcript entry with an id to fork from.");

    const forked = await forkWebSession({
      sessionKey: sourceSessionId,
      projectKey: projectRoot,
      fromEntryId: forkPoint.entryId,
      resumeAt: true,
    }, {
      projectRoot,
      pilotHome: projectRoot,
      storageForSession,
    });
    const targetStorage = storageForSession(forked.newSessionKey);
    const forkedChildMessages = await readSubagentWebMessages({
      sessionKey: forked.newSessionKey,
      subagentId: child.subagentId,
      projectKey: projectRoot,
    }, {
      projectRoot,
      pilotHome: projectRoot,
      storage: targetStorage,
    });
    assert.ok(
      forkedChildMessages.messages.some((message) => message.text === "Child sidechain answer"),
      "the fork must own a copy of the child sidechain payload",
    );

    const targetGrandchildPath = targetStorage.transcript
      .forSubagent(child.subagentId)
      .writer
      .forSubagent(grandchild.subagentId)
      .transcriptPath;
    const targetGrandchild = await targetStorage.readTranscriptAtPath!(targetGrandchildPath);
    assert.ok(
      targetGrandchild.entries.some((entry) =>
        entry.type === "assistant_message" && entry.message.content.some(
          (block) => block.type === "text" && block.text === "Nested sidechain answer",
        )),
      "the fork must recursively copy nested sidechain payloads",
    );
    assert.equal(
      new TextDecoder().decode(await targetStorage.fileHistoryBackupStorage!.read(checkpointBackupName)),
      "checkpoint before fork\n",
      "the fork must copy file-history backup payloads referenced by transcript snapshots",
    );
    const targetTranscript = await targetStorage.readTranscript!();
    const targetToolMessage = targetTranscript.entries.find((entry) =>
      (entry.type === "tool_result_message" || entry.type === "durable_message")
      && entry.message.content.some((block) => block.type === "tool_result_reference"),
    );
    if (
      !targetToolMessage
      || (targetToolMessage.type !== "tool_result_message" && targetToolMessage.type !== "durable_message")
    ) {
      throw new Error("Expected the fork transcript to retain the host-owned tool-result reference.");
    }
    const targetReference = targetToolMessage.message.content.find(
      (block) => block.type === "tool_result_reference",
    );
    if (!targetReference || targetReference.type !== "tool_result_reference") {
      throw new Error("Expected a forked tool-result reference.");
    }
    assert.notEqual(targetReference.path, sourceReference.path, "fork references must target the new session cache");
    assert.equal(
      new TextDecoder().decode(await targetStorage.toolResultArtifactStorage!.read(targetReference.path.split(/[\\/]/).at(-1)!)),
      sourcePayload,
      "the fork must own a copy of the external tool-result payload",
    );
    await rm(targetStorage.toolResultsDir, { recursive: true, force: true });
    const restartedBudget = new ToolResultBudget({
      toolResultsDir: targetStorage.toolResultsDir,
      artifactStorage: targetStorage.toolResultArtifactStorage,
      maxResultSizeChars: 64,
      maxResultSizeTokens: 20,
      previewBytes: 32,
    });
    await restartedBudget.hydrateReferences([targetToolMessage.message]);
    assert.ok(targetReference.readFilePath);
    assert.equal(
      await readFile(join(projectRoot, targetReference.readFilePath), "utf8"),
      sourcePayload,
      "a restarted Gateway can rebuild the forked read_file cache from host storage",
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Gateway nativeSessionStorage recovers a prepared last-turn replacement on startup", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-native-replacement-recovery-"));
  const projectRoot = join(root, "project");
  const storageHome = join(root, "native-storage");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, "pilotdeck.yaml"), TEST_CONFIG, "utf8");
  const sessionKey = "sdk:native-replacement-recovery";
  const storage = createAgentProjectSessionStorage({
    projectRoot,
    pilotHome: storageHome,
    sessionId: sessionKey,
  });
  await storage.transcript.recordAcceptedInput(sessionKey, "turn-1", [{
    role: "user",
    content: [{ type: "text", text: "original request" }],
  }]);
  await storage.transcript.recordDurableMessage(sessionKey, "turn-1", {
    role: "assistant",
    content: [{ type: "text", text: "original answer" }],
  });
  const original = await readFile(storage.transcriptPath, "utf8");
  await replaceLastWebSessionTurn(
    {
      sessionKey,
      projectKey: projectRoot,
      expectedTurnId: "turn-1",
      replacementTurnId: "turn-2",
    },
    { projectRoot, pilotHome: projectRoot, storage },
  );

  const local = createLocalGateway({
    projectRoot,
    pilotHome: projectRoot,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
    nativeSessionStorage: {
      getProjectChatDir: (input) => createAgentProjectSessionStorage({
        ...input,
        sessionId: "chat-dir",
        pilotHome: storageHome,
      }).chatDir,
      createSessionStorage: (input) => createAgentProjectSessionStorage({ ...input, pilotHome: storageHome }),
    },
    __testModelFactory: () => new TitleModel(),
  });
  try {
    assert.equal(await readFile(storage.transcriptPath, "utf8"), original);
    const files = await readdir(storage.chatDir);
    assert.equal(files.some((file) => file.includes(".replace.")), false);
  } finally {
    local.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("Gateway nativeSessionStorage recovers a newly activated project's replacement", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-native-project-recovery-"));
  const defaultProjectRoot = join(root, "default-project");
  const recoveredProjectRoot = join(root, "recovered-project");
  const storageHome = join(root, "native-storage");
  await mkdir(defaultProjectRoot, { recursive: true });
  await mkdir(recoveredProjectRoot, { recursive: true });
  await writeFile(join(defaultProjectRoot, "pilotdeck.yaml"), TEST_CONFIG, "utf8");
  await writeFile(join(recoveredProjectRoot, "pilotdeck.yaml"), TEST_CONFIG, "utf8");
  const sessionKey = "sdk:native-project-replacement-recovery";
  const storage = createAgentProjectSessionStorage({
    projectRoot: recoveredProjectRoot,
    pilotHome: storageHome,
    sessionId: sessionKey,
  });
  await storage.transcript.recordAcceptedInput(sessionKey, "turn-1", [{
    role: "user",
    content: [{ type: "text", text: "original recovered-project request" }],
  }]);
  await storage.transcript.recordDurableMessage(sessionKey, "turn-1", {
    role: "assistant",
    content: [{ type: "text", text: "original recovered-project answer" }],
  });
  const original = await readFile(storage.transcriptPath, "utf8");
  await replaceLastWebSessionTurn(
    {
      sessionKey,
      projectKey: recoveredProjectRoot,
      expectedTurnId: "turn-1",
      replacementTurnId: "turn-2",
    },
    { projectRoot: recoveredProjectRoot, pilotHome: defaultProjectRoot, storage },
  );

  const local = createLocalGateway({
    projectRoot: defaultProjectRoot,
    pilotHome: defaultProjectRoot,
    fallbackProjectRoot: defaultProjectRoot,
    permissionMode: "bypassPermissions",
    nativeSessionStorage: {
      getProjectChatDir: (input) => createAgentProjectSessionStorage({
        ...input,
        sessionId: "chat-dir",
        pilotHome: storageHome,
      }).chatDir,
      createSessionStorage: (input) => createAgentProjectSessionStorage({ ...input, pilotHome: storageHome }),
    },
    __testModelFactory: () => new TitleModel(),
  });
  const endpoint = createEmbeddedGatewayEndpoint({
    gateway: local.gateway,
    token: "embedded-native-project-recovery-token",
  });
  const client = createEmbeddedPilotDeckClient({
    connection: { endpoint, token: "embedded-native-project-recovery-token" },
    projectKey: recoveredProjectRoot,
    channelKey: "embedded-native-project-recovery",
    permissionMode: "bypassPermissions",
  });
  try {
    const sessions = await client.sessions.list({ projectKey: recoveredProjectRoot });
    assert.equal(sessions.some((session) => session.sessionId === sessionKey), true);
    assert.equal(await readFile(storage.transcriptPath, "utf8"), original);
    const files = await readdir(storage.chatDir);
    assert.equal(files.some((file) => file.includes(".replace.")), false);
  } finally {
    await client.close();
    endpoint.close();
    local.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("Gateway applies SDK managedSettings as a restrictive session policy", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-managed-settings-"));
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, "pilotdeck.yaml"), TEST_CONFIG, "utf8");

  let receivedConfig: any;
  const local = createLocalGateway({
    projectRoot,
    pilotHome: projectRoot,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
    __testModelFactory: () => new TitleModel(),
    __testAgentLoopFactory: ({ config }) => {
      receivedConfig = config;
      return {
        snapshotFileState: () => ({}),
        async *run(options): AsyncGenerator<AgentEvent, AgentLoopRunResult, unknown> {
          const finalMessage = { role: "assistant" as const, content: [{ type: "text" as const, text: "ok" }] };
          const result: AgentLoopRunResult = {
            result: {
              type: "success", sessionId: options.sessionId, turnId: options.turnId,
              finalMessage, stopReason: "completed", usage: {}, permissionDenials: [], turns: 1,
              startedAt: "2026-09-10T00:00:00.000Z", completedAt: "2026-09-10T00:00:00.001Z",
            },
            messages: [...options.messages, finalMessage],
          };
          yield { type: "turn_completed", sessionId: options.sessionId, turnId: options.turnId, result: result.result };
          return result;
        },
      };
    },
  });
  try {
    for await (const _event of local.gateway.submitTurn({
      sessionKey: "sdk:managed-settings",
      workspaceCwd: projectRoot,
      channelKey: "test",
      message: "hello",
      mode: "bypassPermissions",
      sdkSessionConfig: {
        managedPermissions: {
          deny: ["Bash(git push *)"],
          ask: ["WebFetch"],
          defaultMode: "plan",
          canPrompt: false,
        },
      },
    })) { /* consume */ }

    assert.equal(receivedConfig.permissionContext.mode, "plan");
    assert.equal(receivedConfig.permissionContext.canPrompt, false);
    assert.deepEqual(receivedConfig.permissionContext.rules.deny, [{
      source: "policy", behavior: "deny", toolName: "bash", pattern: "git push *",
    }]);
    assert.deepEqual(receivedConfig.permissionContext.rules.ask, [{
      source: "policy", behavior: "ask", toolName: "web_fetch", pattern: undefined,
    }]);

    // A remembered session allow never wins over a managed deny rule.
    receivedConfig.permissionContext.rules.allow.push({ source: "session", behavior: "allow", toolName: "bash" });
    const permission = new PermissionRuntime();
    const denied = await permission.decide(
      { name: "bash", isReadOnly: () => false } as any,
      { command: "git push origin main" },
      { permissionContext: receivedConfig.permissionContext } as any,
      "managed-deny",
    );
    assert.equal(denied.type, "deny");
    if (denied.type === "deny" && denied.reason.type === "rule") {
      assert.equal(denied.reason.rule.source, "policy");
    }

    const asked = await permission.decide(
      { name: "web_fetch", isReadOnly: () => true } as any,
      { url: "https://example.test" },
      { permissionContext: receivedConfig.permissionContext } as any,
      "managed-ask",
    );
    assert.equal(asked.type, "deny");
    if (asked.type === "deny") assert.equal(asked.reason.type, "runtime");

    // The managed policy feeds the native runtime a one-way prompt denial;
    // it remains effective when the normal mode and rules would otherwise
    // request interactive approval.
    const promptDisabled = await permission.decide(
      { name: "bash", isReadOnly: () => false } as any,
      { command: "git status" },
      {
        permissionContext: {
          ...receivedConfig.permissionContext,
          mode: "default",
          rules: { allow: [], deny: [], ask: [] },
        },
      } as any,
      "managed-no-prompt",
    );
    assert.equal(promptDisabled.type, "deny");
    if (promptDisabled.type === "deny") assert.equal(promptDisabled.reason.type, "runtime");

    const invalid: any[] = [];
    for await (const event of local.gateway.submitTurn({
      sessionKey: "sdk:managed-settings-invalid",
      workspaceCwd: projectRoot,
      channelKey: "test",
      message: "hello",
      mode: "bypassPermissions",
      sdkSessionConfig: {
        managedPermissions: { deny: [], ask: [], canPrompt: true as any },
      },
    })) invalid.push(event);
    assert.equal(invalid.some((event) => event.type === "error" && event.code === "UNSUPPORTED_SDK_MANAGED_SETTING"), true);
  } finally {
    local.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("SDK managed tool policy only narrows the model-visible registry", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-managed-tools-"));
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, "pilotdeck.yaml"), TEST_CONFIG, "utf8");
  const model = new PromptCaptureModel();
  const local = createLocalGateway({
    projectRoot,
    pilotHome: projectRoot,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
    __testModelFactory: () => model,
  });
  const server = await startGatewayServer({ gateway: local.gateway, port: 0, token: "sdk-managed-tools-token" });
  try {
    const run = query({
      prompt: "Inspect the allowed tools and finish.",
      options: {
        gatewayUrl: server.wsUrl,
        authToken: server.token,
        projectKey: projectRoot,
        managedSettings: {
          tools: {
            allow: ["read_file", "grep"],
            deny: ["grep"],
          },
        },
      },
    });
    for await (const _event of run) { /* consume */ }
    assert.equal((await run.result()).status, "completed");
    run.close();

    const visible = new Set(model.requests[0]?.tools?.map((tool) => tool.name));
    assert.deepEqual([...visible], ["read_file"]);

    const invalid: any[] = [];
    for await (const event of local.gateway.submitTurn({
      sessionKey: "sdk:managed-tools-invalid",
      workspaceCwd: projectRoot,
      channelKey: "test",
      message: "reject malformed managed tool selectors",
      sdkSessionConfig: {
        managedTools: { allow: ["invalid selector"], deny: [] },
      },
    })) invalid.push(event);
    assert.equal(invalid.some((event) => event.type === "error" && event.code === "INVALID_SDK_MANAGED_SETTINGS"), true);
  } finally {
    await server.close();
    local.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("SDK managed model policy rejects disallowed resolved models", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-managed-models-"));
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, "pilotdeck.yaml"), TEST_CONFIG, "utf8");
  const model = new PreContentFallbackModel();
  const local = createLocalGateway({
    projectRoot,
    pilotHome: projectRoot,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
    __testModelFactory: () => model,
  });
  const server = await startGatewayServer({ gateway: local.gateway, port: 0, token: "sdk-managed-models-token" });
  try {
    const denied: any[] = [];
    for await (const event of local.gateway.submitTurn({
      sessionKey: "sdk:managed-models-denied",
      workspaceCwd: projectRoot,
      channelKey: "test",
      message: "reject this model",
      sdkSessionConfig: {
        managedModels: { allow: ["test/reviewer"], deny: [] },
        settings: { agent: { model: "test/test" } },
      },
    })) denied.push(event);
    assert.equal(denied.some((event) => event.type === "error" && event.code === "SDK_MANAGED_MODEL_DENIED"), true);

    const turnOverrideDenied: any[] = [];
    for await (const event of local.gateway.submitTurn({
      sessionKey: "sdk:managed-models-turn-override",
      workspaceCwd: projectRoot,
      channelKey: "test",
      message: "reject an explicit per-turn model override",
      modelOverride: { mode: "model", provider: "test", model: "test" },
      sdkSessionConfig: {
        managedModels: { allow: ["test/reviewer"], deny: [] },
      },
    })) turnOverrideDenied.push(event);
    assert.equal(
      turnOverrideDenied.some((event) => event.type === "error" && event.code === "SDK_MANAGED_MODEL_DENIED"),
      true,
    );

    const run = query({
      prompt: "run with the allowed model",
      options: {
        gatewayUrl: server.wsUrl,
        authToken: server.token,
        projectKey: projectRoot,
        model: "test/reviewer",
        managedSettings: { models: { allow: ["test/reviewer"], deny: [] } },
      },
    });
    for await (const _event of run) { /* consume */ }
    assert.equal((await run.result()).status, "completed");
    run.close();
    assert.deepEqual(model.attempts, ["test/reviewer"]);

    const invalid: any[] = [];
    for await (const event of local.gateway.submitTurn({
      sessionKey: "sdk:managed-models-invalid",
      workspaceCwd: projectRoot,
      channelKey: "test",
      message: "reject malformed model selector",
      sdkSessionConfig: { managedModels: { allow: ["test"], deny: [] } },
    })) invalid.push(event);
    assert.equal(invalid.some((event) => event.type === "error" && event.code === "INVALID_SDK_MANAGED_SETTINGS"), true);
  } finally {
    await server.close();
    local.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("Gateway host organization policy cannot be relaxed by SDK session controls", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-organization-policy-"));
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, "pilotdeck.yaml"), TEST_CONFIG, "utf8");
  await mkdir(join(projectRoot, ".pilotdeck"), { recursive: true });
  await writeFile(
    join(projectRoot, ".pilotdeck", "pilotdeck.yaml"),
    "agent:\n  maxContextTokens: 4096\n  thinking:\n    enabled: true\n    budgetTokens: 128\n",
    "utf8",
  );

  assert.throws(
    () => createLocalGateway({
      projectRoot,
      pilotHome: projectRoot,
      env: { ...process.env, PILOT_HOME: projectRoot },
      organizationPolicy: { settings: { sessionDefaultSources: [] } },
    }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "INVALID_SDK_SETTING_SOURCES");
      return true;
    },
  );
  assert.throws(
    () => createLocalGateway({
      projectRoot,
      pilotHome: projectRoot,
      organizationPolicy: { settings: { maxSubagentTimeoutMs: 0 } },
    }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "INVALID_GATEWAY_ORGANIZATION_POLICY");
      return true;
    },
  );
  assert.throws(
    () => createLocalGateway({
      projectRoot,
      pilotHome: projectRoot,
      organizationPolicy: { limits: { maxSubagentDepth: -1 } },
    }),
    (error: unknown) => {
      assert.equal((error as { code?: string }).code, "INVALID_GATEWAY_ORGANIZATION_POLICY");
      return true;
    },
  );

  let receivedConfig: any;
  let receivedTurnOptions: any;
  let receivedToolNames: string[] = [];
  const local = createLocalGateway({
    projectRoot,
    pilotHome: projectRoot,
    env: { ...process.env, PILOT_HOME: projectRoot },
    fallbackProjectRoot: projectRoot,
    // This would normally allow every tool; the host policy below must win.
    permissionMode: "bypassPermissions",
    organizationPolicy: {
      permissions: {
        deny: ["Bash(git push *)"],
        ask: ["WebFetch"],
        defaultMode: "plan",
        canPrompt: false,
      },
      models: { allow: ["test/test"] },
      tools: { deny: ["bash", "web_*", "organization_*"] },
      // The host can prevent an SDK caller from reading a Gateway-local
      // project/local settings layer. deny remains authoritative even when
      // that source also appears in the host allow list.
      settingSources: { allow: ["user", "project", "local"], deny: ["local"] },
      limits: { maxTurns: 3, maxBudgetUsd: 0.5, maxTaskBudgetUsd: 0.25, maxSubagentDepth: 0 },
      settings: {
        canUpdateLocalSettings: false,
        sessionDefaults: {
          agent: {
            maxContextTokens: 2048,
            maxOutputTokens: 512,
            thinking: { enabled: false },
          },
        },
        // This host source stays selected even when a remote SDK session
        // supplies a different allowed source list.
        sessionDefaultSources: ["project"],
        maxContextTokens: 4096,
        maxOutputTokens: 1024,
        maxThinkingTokens: 64,
        maxSubagentTimeoutMs: 123,
      },
    },
    extraTools: [{
      name: "organization_probe",
      description: "Must not be visible when host tool policy denies its prefix.",
      kind: "custom",
      inputSchema: { type: "object", additionalProperties: false },
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      execute: async () => ({ content: [{ type: "text", text: "unexpected" }] }),
    }],
    __testModelFactory: () => new TitleModel(),
    __testAgentLoopFactory: ({ config, dependencies }) => {
      receivedConfig = config;
      receivedToolNames = dependencies.tools.registry.list().map((tool) => tool.name);
      return {
        snapshotFileState: () => ({}),
        async *run(options): AsyncGenerator<AgentEvent, AgentLoopRunResult, unknown> {
          receivedTurnOptions = options;
          const finalMessage = { role: "assistant" as const, content: [{ type: "text" as const, text: "ok" }] };
          const result: AgentLoopRunResult = {
            result: {
              type: "success", sessionId: options.sessionId, turnId: options.turnId,
              finalMessage, stopReason: "completed", usage: {}, permissionDenials: [], turns: 1,
              startedAt: "2026-09-10T00:00:00.000Z", completedAt: "2026-09-10T00:00:00.001Z",
            },
            messages: [...options.messages, finalMessage],
          };
          yield { type: "turn_completed", sessionId: options.sessionId, turnId: options.turnId, result: result.result };
          return result;
        },
      };
    },
  });
  const server = await startGatewayServer({ gateway: local.gateway, port: 0, token: "sdk-organization-policy-token" });
  try {
    assert.equal((await local.gateway.describeServer()).capabilities?.includes("sdk_session_defaults"), true);

    // A public SDK query with no SDK-specific settings sends an empty marker
    // after capability negotiation. This makes host defaults available only
    // to the SDK session without changing the native Gateway default path.
    const defaultRun = query({
      prompt: "Use Gateway host defaults.",
      options: {
        gatewayUrl: server.wsUrl,
        authToken: server.token,
        projectKey: projectRoot,
      },
    });
    for await (const _event of defaultRun) { /* consume */ }
    assert.equal((await defaultRun.result()).status, "completed");
    defaultRun.close();
    assert.equal(receivedConfig.maxContextTokens, 4096);
    assert.equal(receivedConfig.maxOutputTokens, 512);
    assert.deepEqual(receivedConfig.thinking, { enabled: true, budgetTokens: 64 });
    assert.equal(receivedTurnOptions.maxTurns, 3);
    assert.equal(receivedTurnOptions.maxBudgetUsd, 0.5);
    assert.equal(receivedTurnOptions.taskBudgetUsd, 0.25);
    assert.equal(receivedConfig.subagentTimeoutMs, 123);
    assert.equal(receivedConfig.maxSubagentDepth, 0);

    // Direct Gateway callers do not carry the SDK marker. They retain the
    // native configuration path, subject only to pre-existing host ceilings.
    for await (const _event of local.gateway.submitTurn({
      sessionKey: "native:organization-policy",
      workspaceCwd: projectRoot,
      channelKey: "test",
      message: "Use the native Gateway path.",
      mode: "bypassPermissions",
      maxTurns: 99,
      maxBudgetUsd: 5,
    })) { /* consume */ }
    assert.equal(receivedConfig.maxContextTokens, 4096);
    assert.equal(receivedConfig.maxOutputTokens, 1024);
    assert.deepEqual(receivedConfig.thinking, { enabled: true, budgetTokens: 64 });
    assert.equal(receivedTurnOptions.maxTurns, 3);
    assert.equal(receivedTurnOptions.maxBudgetUsd, 0.5);
    assert.equal(receivedTurnOptions.taskBudgetUsd, undefined);
    assert.equal(receivedConfig.subagentTimeoutMs, 123);
    assert.equal(receivedConfig.maxSubagentDepth, 0);

    for await (const _event of local.gateway.submitTurn({
      sessionKey: "sdk:organization-policy",
      workspaceCwd: projectRoot,
      channelKey: "test",
      message: "hello",
      // A remote caller can still request this mode, but cannot relax host policy.
      mode: "bypassPermissions",
      maxTurns: 99,
      maxBudgetUsd: 5,
      sdkSessionConfig: {
        agents: {
          organization_worker: {
            description: "Verify the host turn cap for SDK subagents.",
            prompt: "Inspect the request and report a short result.",
            maxTurns: 99,
          },
        },
        taskBudget: { total: 5 },
        settings: { agent: { subagents: { timeoutMs: 999, maxDepth: 5 } } },
        managedPermissions: {
          deny: ["Bash(git status *)"],
          ask: [],
        },
      },
    })) { /* consume */ }

    assert.equal(receivedConfig.permissionContext.mode, "plan");
    assert.equal(receivedConfig.permissionContext.canPrompt, false);
    assert.equal(receivedConfig.permissionContext.policyCanPrompt, false);
    assert.equal(receivedConfig.maxContextTokens, 4096);
    assert.equal(receivedConfig.maxOutputTokens, 512);
    assert.deepEqual(receivedConfig.thinking, { enabled: true, budgetTokens: 64 });
    assert.equal(receivedTurnOptions.maxTurns, 3);
    assert.equal(receivedTurnOptions.maxBudgetUsd, 0.5);
    assert.equal(receivedTurnOptions.taskBudgetUsd, 0.25);
    assert.equal(receivedConfig.subagentTimeoutMs, 123);
    assert.equal(receivedConfig.maxSubagentDepth, 0);
    assert.equal(receivedConfig.subagentDefinitions.organization_worker.maxTurns, 3);
    assert.deepEqual(receivedConfig.permissionContext.rules.deny, [
      { source: "policy", behavior: "deny", toolName: "bash", pattern: "git push *" },
      { source: "policy", behavior: "deny", toolName: "bash", pattern: "git status *" },
    ]);
    assert.deepEqual(receivedConfig.permissionContext.rules.ask, [
      { source: "policy", behavior: "ask", toolName: "web_fetch", pattern: undefined },
    ]);
    assert.equal(receivedToolNames.includes("bash"), false);
    assert.equal(receivedToolNames.includes("web_fetch"), false);
    assert.equal(receivedToolNames.includes("web_search"), false);
    assert.equal(receivedToolNames.includes("organization_probe"), false);
    assert.equal(receivedToolNames.includes("read_file"), true);

    // A remembered SDK allow cannot override the host deny.
    receivedConfig.permissionContext.rules.allow.push({ source: "session", behavior: "allow", toolName: "bash" });
    const permission = new PermissionRuntime();
    const denied = await permission.decide(
      { name: "bash", isReadOnly: () => false } as any,
      { command: "git push origin main" },
      { permissionContext: receivedConfig.permissionContext } as any,
      "organization-deny",
    );
    assert.equal(denied.type, "deny");
    if (denied.type === "deny" && denied.reason.type === "rule") {
      assert.equal(denied.reason.rule.source, "policy");
    }

    // The policy's prompt ban remains effective even if a mutable caller
    // attempts to flip the mode and ordinary prompt flag after construction.
    const promptDisabled = await permission.decide(
      { name: "web_fetch", isReadOnly: () => true } as any,
      { url: "https://example.test" },
      {
        permissionContext: {
          ...receivedConfig.permissionContext,
          mode: "bypassPermissions",
          canPrompt: true,
        },
      } as any,
      "organization-no-prompt",
    );
    assert.equal(promptDisabled.type, "deny");
    if (promptDisabled.type === "deny") assert.equal(promptDisabled.reason.type, "runtime");

    // Gateway validates an SDK setting against the host policy before a
    // native session or provider request can be constructed.
    const rejected: any[] = [];
    for await (const event of local.gateway.submitTurn({
      sessionKey: "sdk:organization-model-denied",
      workspaceCwd: projectRoot,
      channelKey: "test",
      message: "hello",
      sdkSessionConfig: {
        settings: { agent: { model: "test/reviewer" } },
      },
    })) rejected.push(event);
    assert.equal(rejected.some((event) => event.type === "error" && event.code === "GATEWAY_ORGANIZATION_MODEL_DENIED"), true);

    // The source is rejected before Gateway reads a host-local config file
    // or constructs a native AgentSession. An explicit host deny wins over
    // the allow list.
    const deniedSource: any[] = [];
    for await (const event of local.gateway.submitTurn({
      sessionKey: "sdk:organization-source-denied",
      workspaceCwd: projectRoot,
      channelKey: "test",
      message: "Do not load the local layer.",
      sdkSessionConfig: { settingSources: ["local"] },
    })) deniedSource.push(event);
    assert.equal(deniedSource.some((event) => event.type === "error" && event.code === "GATEWAY_ORGANIZATION_SETTING_SOURCE_DENIED"), true);

    // A source that remains in the host allow list follows the existing
    // Gateway-owned source resolution and native AgentSession path.
    const allowedSource: any[] = [];
    for await (const event of local.gateway.submitTurn({
      sessionKey: "sdk:organization-source-allowed",
      workspaceCwd: projectRoot,
      channelKey: "test",
      message: "Load the user layer.",
      sdkSessionConfig: {
        settingSources: ["user"],
        settings: {
          agent: {
            maxContextTokens: 8192,
            maxOutputTokens: 2048,
            thinking: { enabled: false },
          },
        },
      },
    })) allowedSource.push(event);
    assert.equal(allowedSource.some((event) => event.type === "turn_completed"), true);
    // Gateway-local source settings take precedence over host defaults, while
    // host ceilings remain the final restrictive layer.
    assert.equal(receivedConfig.maxContextTokens, 4096);
    assert.equal(receivedConfig.maxOutputTokens, 1024);
    assert.deepEqual(receivedConfig.thinking, { enabled: false });

    // Host policy caps explicit SDK thinking controls as well. It does not
    // enable thinking if the session has not explicitly enabled it.
    await local.gateway.setSessionThinking!({
      sessionKey: "sdk:organization-thinking-cap",
      thinking: { enabled: true, mode: "high", budgetTokens: 256 },
    });
    for await (const _event of local.gateway.submitTurn({
      sessionKey: "sdk:organization-thinking-cap",
      workspaceCwd: projectRoot,
      channelKey: "test",
      message: "Cap explicit thinking.",
      sdkSessionConfig: {},
    })) { /* consume */ }
    assert.deepEqual(receivedConfig.thinking, {
      enabled: true,
      mode: "high",
      budgetTokens: 64,
    });

    // The same host policy also protects the Gateway-owned global settings
    // file from remote SDK control-plane mutation. Native config reloads are
    // not involved in this request path.
    await assert.rejects(
      () => local.gateway.updateSettings!({
        source: "localSettings",
        settings: { agent: { maxContextTokens: 4096 } },
      }),
      (error: unknown) => {
        assert.equal((error as { code?: string }).code, "GATEWAY_ORGANIZATION_SETTINGS_UPDATE_DENIED");
        return true;
      },
    );

    // Exercise the public SDK facade over the real WebSocket transport. The
    // host policy remains Gateway-owned, so the client must receive the
    // explicit server failure rather than treating the denied source as an
    // empty layer or reading a local file itself.
    const remoteDenied = query({
      prompt: "Attempt a host-denied source.",
      options: {
        gatewayUrl: server.wsUrl,
        authToken: server.token,
        projectKey: projectRoot,
        settingSources: ["local"],
      },
    });
    const remoteEvents: any[] = [];
    for await (const event of remoteDenied) remoteEvents.push(event);
    const remoteResult = await remoteDenied.result();
    remoteDenied.close();
    assert.equal(remoteResult.status, "failed");
    if (remoteResult.status === "failed") {
      assert.equal(remoteResult.error.code, "GATEWAY_ORGANIZATION_SETTING_SOURCE_DENIED");
    }
    assert.equal(remoteEvents.some((event) => event.type === "error" && event.code === "GATEWAY_ORGANIZATION_SETTING_SOURCE_DENIED"), true);

  } finally {
    await server.close();
    local.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("Gateway host provider policy blocks endpoint and credential sources before model requests", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-provider-policy-"));
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, "pilotdeck.yaml"), TEST_CONFIG, "utf8");
  const submit = async (gateway: ReturnType<typeof createLocalGateway>["gateway"], sessionKey: string) => {
    const events: any[] = [];
    for await (const event of gateway.submitTurn({
      sessionKey,
      workspaceCwd: projectRoot,
      channelKey: "test",
      message: "Use the configured provider.",
      mode: "bypassPermissions",
    })) events.push(event);
    return events;
  };

  const unguardedModel = new PromptCaptureModel();
  const unguarded = createLocalGateway({
    projectRoot,
    pilotHome: projectRoot,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
    __testModelFactory: () => unguardedModel,
  });
  try {
    const events = await submit(unguarded.gateway, "native:provider-policy-default");
    assert.equal(events.some((event) => event.type === "turn_completed"), true);
    assert.equal(unguardedModel.requests.length, 1);
  } finally {
    unguarded.dispose();
  }

  const originDeniedModel = new PromptCaptureModel();
  const originDenied = createLocalGateway({
    projectRoot,
    pilotHome: projectRoot,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
    organizationPolicy: {
      providers: { origins: { deny: ["http://127.0.0.1:1"] } },
    },
    __testModelFactory: () => originDeniedModel,
  });
  try {
    const events = await submit(originDenied.gateway, "native:provider-origin-denied");
    assert.equal(
      events.some((event) => event.type === "error" && event.code === "GATEWAY_ORGANIZATION_PROVIDER_ORIGIN_DENIED"),
      true,
    );
    assert.equal(originDeniedModel.requests.length, 0);
  } finally {
    originDenied.dispose();
  }

  const credentialDeniedModel = new PromptCaptureModel();
  const credentialDenied = createLocalGateway({
    projectRoot,
    pilotHome: projectRoot,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
    organizationPolicy: {
      providers: { credentials: { allow: ["environment"] } },
    },
    __testModelFactory: () => credentialDeniedModel,
  });
  try {
    const events = await submit(credentialDenied.gateway, "native:provider-credential-denied");
    assert.equal(
      events.some((event) => event.type === "error" && event.code === "GATEWAY_ORGANIZATION_CREDENTIAL_SOURCE_DENIED"),
      true,
    );
    assert.equal(credentialDeniedModel.requests.length, 0);
  } finally {
    credentialDenied.dispose();
  }

  await writeFile(
    join(projectRoot, "pilotdeck.yaml"),
    TEST_CONFIG.replace("apiKey: test-only", "apiKey: ${TEST_GATEWAY_PROVIDER_KEY}"),
    "utf8",
  );
  const allowedModel = new PromptCaptureModel();
  const allowed = createLocalGateway({
    projectRoot,
    pilotHome: projectRoot,
    fallbackProjectRoot: projectRoot,
    env: { ...process.env, TEST_GATEWAY_PROVIDER_KEY: "test-only" },
    permissionMode: "bypassPermissions",
    organizationPolicy: {
      providers: {
        allow: ["test"],
        origins: { allow: ["http://127.0.0.1:1"] },
        credentials: { allow: ["environment"] },
      },
    },
    __testModelFactory: () => allowedModel,
  });
  try {
    const events = await submit(allowed.gateway, "native:provider-policy-allowed");
    assert.equal(events.some((event) => event.type === "turn_completed"), true);
    assert.equal(allowedModel.requests.length, 1);
  } finally {
    allowed.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("Gateway host-managed SDK setting source is selectable without exposing host settings", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-managed-source-"));
  const projectRoot = join(root, "project");
  await mkdir(join(projectRoot, ".pilotdeck"), { recursive: true });
  await writeFile(join(projectRoot, "pilotdeck.yaml"), TEST_CONFIG, "utf8");
  await writeFile(
    join(projectRoot, ".pilotdeck", "pilotdeck.yaml"),
    [
      "agent:",
      "  maxContextTokens: 4096",
      "  maxOutputTokens: 512",
      "",
    ].join("\n"),
    "utf8",
  );

  const received: any[] = [];
  const local = createLocalGateway({
    projectRoot,
    pilotHome: projectRoot,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
    organizationPolicy: {
      settingSources: { allow: ["managed", "project"] },
      settings: {
        managedSessionSettings: {
          agent: {
            maxContextTokens: 2048,
            maxOutputTokens: 256,
            thinking: { enabled: false },
          },
        },
      },
    },
    __testModelFactory: () => new TitleModel(),
    __testAgentLoopFactory: ({ config }) => {
      received.push(config);
      return {
        snapshotFileState: () => ({}),
        async *run(options): AsyncGenerator<AgentEvent, AgentLoopRunResult, unknown> {
          const finalMessage = { role: "assistant" as const, content: [{ type: "text" as const, text: "ok" }] };
          const result: AgentLoopRunResult = {
            result: {
              type: "success", sessionId: options.sessionId, turnId: options.turnId,
              finalMessage, stopReason: "completed", usage: {}, permissionDenials: [], turns: 1,
              startedAt: "2026-09-11T00:00:00.000Z", completedAt: "2026-09-11T00:00:00.001Z",
            },
            messages: [...options.messages, finalMessage],
          };
          yield { type: "turn_completed", sessionId: options.sessionId, turnId: options.turnId, result: result.result };
          return result;
        },
      };
    },
  });
  const server = await startGatewayServer({ gateway: local.gateway, port: 0, token: "sdk-managed-source-token" });
  try {
    const managed = query({
      prompt: "Use the host managed source.",
      options: {
        gatewayUrl: server.wsUrl,
        authToken: server.token,
        projectKey: projectRoot,
        settingSources: ["managed"],
      },
    });
    for await (const _event of managed) { /* consume */ }
    assert.equal((await managed.result()).status, "completed");
    managed.close();
    assert.equal(received.at(-1)?.maxContextTokens, 2048);
    assert.equal(received.at(-1)?.maxOutputTokens, 256);
    assert.deepEqual(received.at(-1)?.thinking, { enabled: false });

    // Input order does not choose precedence: the Gateway always evaluates
    // managed before its project source.
    const project = query({
      prompt: "Use the project source after managed.",
      options: {
        gatewayUrl: server.wsUrl,
        authToken: server.token,
        projectKey: projectRoot,
        settingSources: ["project", "managed"],
      },
    });
    for await (const _event of project) { /* consume */ }
    assert.equal((await project.result()).status, "completed");
    project.close();
    assert.equal(received.at(-1)?.maxContextTokens, 4096);
    assert.equal(received.at(-1)?.maxOutputTokens, 512);

    const explicit = query({
      prompt: "Use an explicit SDK overlay after the selected source.",
      options: {
        gatewayUrl: server.wsUrl,
        authToken: server.token,
        projectKey: projectRoot,
        settingSources: ["managed"],
        settings: { agent: { maxContextTokens: 8192, maxOutputTokens: 1024 } },
      },
    });
    for await (const _event of explicit) { /* consume */ }
    assert.equal((await explicit.result()).status, "completed");
    explicit.close();
    assert.equal(received.at(-1)?.maxContextTokens, 8192);
    assert.equal(received.at(-1)?.maxOutputTokens, 1024);

    // `local` is not allowed by this host policy. The remote SDK sees a
    // typed Gateway failure instead of probing host paths itself.
    const denied = query({
      prompt: "Attempt an untrusted source.",
      options: {
        gatewayUrl: server.wsUrl,
        authToken: server.token,
        projectKey: projectRoot,
        settingSources: ["local"],
      },
    });
    for await (const _event of denied) { /* consume */ }
    const deniedResult = await denied.result();
    denied.close();
    assert.equal(deniedResult.status, "failed");
    if (deniedResult.status === "failed") {
      assert.equal(deniedResult.error.code, "GATEWAY_ORGANIZATION_SETTING_SOURCE_DENIED");
    }

    // Direct native Gateway calls never receive SDK-only managed overlays.
    for await (const _event of local.gateway.submitTurn({
      sessionKey: "native:managed-source",
      workspaceCwd: projectRoot,
      channelKey: "test",
      message: "Use the native path.",
      mode: "bypassPermissions",
    })) { /* consume */ }
    assert.notEqual(received.at(-1)?.maxContextTokens, 2048);
  } finally {
    await server.close();
    local.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("Gateway host enforced SDK settings override remote controls without changing native sessions", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-enforced-settings-"));
  const projectRoot = join(root, "project");
  await mkdir(join(projectRoot, ".pilotdeck"), { recursive: true });
  await writeFile(join(projectRoot, "pilotdeck.yaml"), TEST_CONFIG, "utf8");
  await writeFile(
    join(projectRoot, ".pilotdeck", "pilotdeck.local.yaml"),
    [
      "agent:",
      "  model: test/test",
      "  fallbackModel: test/test",
      "  maxContextTokens: 8192",
      "  maxOutputTokens: 2048",
      "  thinking:",
      "    enabled: true",
      "    budgetTokens: 999",
      "  subagents:",
      "    default: test/test",
      "    timeoutMs: 999",
      "    maxDepth: 9",
      "",
    ].join("\n"),
    "utf8",
  );

  const received: any[] = [];
  const local = createLocalGateway({
    projectRoot,
    pilotHome: projectRoot,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
    organizationPolicy: {
      settings: {
        enforcedSessionSettings: {
          agent: {
            model: "test/reviewer",
            fallbackModel: null,
            maxContextTokens: 3072,
            maxOutputTokens: 384,
            thinking: { enabled: false },
            subagents: { default: null, timeoutMs: 321, maxDepth: 0 },
          },
        },
      },
    },
    __testModelFactory: () => new TitleModel(),
    __testAgentLoopFactory: ({ config }) => {
      received.push(config);
      return {
        snapshotFileState: () => ({}),
        async *run(options): AsyncGenerator<AgentEvent, AgentLoopRunResult, unknown> {
          const finalMessage = { role: "assistant" as const, content: [{ type: "text" as const, text: "ok" }] };
          const result: AgentLoopRunResult = {
            result: {
              type: "success", sessionId: options.sessionId, turnId: options.turnId,
              finalMessage, stopReason: "completed", usage: {}, permissionDenials: [], turns: 1,
              startedAt: "2026-09-11T00:00:00.000Z", completedAt: "2026-09-11T00:00:00.001Z",
            },
            messages: [...options.messages, finalMessage],
          };
          yield { type: "turn_completed", sessionId: options.sessionId, turnId: options.turnId, result: result.result };
          return result;
        },
      };
    },
  });
  const server = await startGatewayServer({ gateway: local.gateway, port: 0, token: "sdk-enforced-settings-token" });
  try {
    assert.equal((await local.gateway.describeServer()).capabilities?.includes("sdk_session_defaults"), true);

    const run = query({
      prompt: "The Gateway host owns the effective SDK settings.",
      options: {
        gatewayUrl: server.wsUrl,
        authToken: server.token,
        projectKey: projectRoot,
        // Each value below loses to the host-only enforced layer.
        model: "test/test",
        fallbackModel: "test/test",
        settingSources: ["local"],
        settings: {
          agent: {
            model: "test/test",
            fallbackModel: "test/test",
            maxContextTokens: 16384,
            maxOutputTokens: 4096,
            thinking: { enabled: true, budgetTokens: 4096 },
            subagents: { default: "test/test", timeoutMs: 4096, maxDepth: 8 },
          },
        },
      },
    });
    for await (const _event of run) { /* consume */ }
    assert.equal((await run.result()).status, "completed");
    run.close();

    assert.equal(received.length, 1);
    assert.equal(received[0].provider, "test");
    assert.equal(received[0].model, "reviewer");
    assert.equal(received[0].fallbackModels, undefined);
    assert.equal(received[0].maxContextTokens, 3072);
    assert.equal(received[0].maxOutputTokens, 384);
    assert.deepEqual(received[0].thinking, { enabled: false });
    assert.equal(received[0].subagentModel, undefined);
    assert.equal(received[0].subagentTimeoutMs, 321);
    assert.equal(received[0].maxSubagentDepth, 0);

    // `set_session_thinking` remains a public SDK control, but it cannot
    // weaken a host value that explicitly owns thinking for this session.
    await local.gateway.setSessionThinking!({
      sessionKey: (run as any).sessionKey,
      thinking: { enabled: true, mode: "high", budgetTokens: 2048 },
    });
    for await (const _event of local.gateway.submitTurn({
      sessionKey: (run as any).sessionKey,
      workspaceCwd: projectRoot,
      channelKey: "test",
      message: "The next SDK turn keeps the host thinking setting.",
      sdkSessionConfig: {},
    })) { /* consume */ }
    assert.equal(received.length, 2);
    assert.deepEqual(received[1].thinking, { enabled: false });

    // A direct Gateway submission has no SDK marker, so host-enforced SDK
    // settings cannot leak into the existing native AgentLoop path.
    for await (const _event of local.gateway.submitTurn({
      sessionKey: "native:enforced-settings",
      workspaceCwd: projectRoot,
      channelKey: "test",
      message: "Use the native model selection.",
      modelOverride: { mode: "model", provider: "test", model: "test" },
    })) { /* consume */ }
    assert.equal(received.length, 3);
    assert.equal(received[2].provider, "test");
    assert.equal(received[2].model, "test");
    assert.notEqual(received[2].maxContextTokens, 3072);
    assert.notEqual(received[2].maxOutputTokens, 384);
  } finally {
    await server.close();
    local.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("Gateway organization maxSubagentDepth rejects agent forks without starting a child runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-organization-depth-"));
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, "pilotdeck.yaml"), TEST_CONFIG, "utf8");
  const model = new AgentDepthCapModel();
  const local = createLocalGateway({
    projectRoot,
    pilotHome: projectRoot,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
    organizationPolicy: { limits: { maxSubagentDepth: 0 } },
    __testModelFactory: () => model,
  });
  try {
    const events: any[] = [];
    for await (const event of local.gateway.submitTurn({
      sessionKey: "sdk:organization-depth-cap",
      workspaceCwd: projectRoot,
      channelKey: "test",
      message: "Attempt to delegate this task.",
      mode: "bypassPermissions",
      sdkSessionConfig: {
        agents: {
          reviewer: {
            description: "A session-supplied agent definition cannot bypass host depth policy.",
            prompt: "Inspect and report.",
          },
        },
      },
    })) events.push(event);

    assert.match(JSON.stringify(events), /subagent_depth_exceeded/);
    assert.equal(
      model.requests.some((request) => request.systemPrompt?.includes("Inspect and report.") === true),
      false,
      "the denied agent call must not create a child model request",
    );
    assert.equal(model.requests.length, 2, "the parent loop receives only the failed tool result and completes");
  } finally {
    local.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("SDK session maxDepth rejects agent forks without starting a child runtime", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-session-depth-"));
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, "pilotdeck.yaml"), TEST_CONFIG, "utf8");
  const model = new AgentDepthCapModel();
  const local = createLocalGateway({
    projectRoot,
    pilotHome: projectRoot,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
    __testModelFactory: () => model,
  });
  const server = await startGatewayServer({ gateway: local.gateway, port: 0, token: "sdk-session-depth-token" });
  try {
    const run = query({
      prompt: "Attempt to delegate this task.",
      options: {
        gatewayUrl: server.wsUrl,
        authToken: server.token,
        projectKey: projectRoot,
        settings: { agent: { subagents: { maxDepth: 0 } } },
        agents: {
          reviewer: {
            description: "A session depth setting must prevent this fork.",
            prompt: "Inspect and report.",
          },
        },
      },
    });
    const events: unknown[] = [];
    for await (const event of run) events.push(event);
    assert.equal((await run.result()).status, "completed");
    run.close();
    assert.match(JSON.stringify(events), /subagent_depth_exceeded/);
    assert.equal(
      model.requests.some((request) => request.systemPrompt?.includes("Inspect and report.") === true),
      false,
      "the session depth setting must not start a child model request",
    );
    assert.equal(model.requests.length, 2, "the parent loop receives only the failed tool result and completes");
  } finally {
    await server.close();
    local.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("SDK settings sources and session overlay are Gateway-owned and affect only the constructed session", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-session-settings-"));
  const projectRoot = join(root, "project");
  // The local test Gateway exposes its Pilot home as the default registered
  // project, which lets the public WebSocket SDK path use this project key.
  const pilotHome = projectRoot;
  await mkdir(pilotHome, { recursive: true });
  await mkdir(join(projectRoot, ".pilotdeck"), { recursive: true });
  await writeFile(join(pilotHome, "pilotdeck.yaml"), TEST_CONFIG.replace("maxContextTokens: 65536", "maxContextTokens: 2048"), "utf8");
  await writeFile(join(projectRoot, ".pilotdeck", "pilotdeck.yaml"), "agent:\n  maxContextTokens: 4096\n  thinking:\n    enabled: true\n    budgetTokens: 128\n", "utf8");
  await writeFile(
    join(projectRoot, ".pilotdeck", "pilotdeck.local.yaml"),
    "agent:\n  model: test/reviewer\n  fallbackModel: test/reviewer\n  maxOutputTokens: 512\n  subagents:\n    default: test/reviewer\n    timeoutMs: 1234\n    maxDepth: 3\n",
    "utf8",
  );

  const received: any[] = [];
  const local = createLocalGateway({
    projectRoot,
    pilotHome,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
    __testModelFactory: () => new TitleModel(),
    __testAgentLoopFactory: ({ config }) => {
      received.push(config);
      return {
        snapshotFileState: () => ({}),
        async *run(options): AsyncGenerator<AgentEvent, AgentLoopRunResult, unknown> {
          const finalMessage = { role: "assistant" as const, content: [{ type: "text" as const, text: "ok" }] };
          const result: AgentLoopRunResult = {
            result: {
              type: "success", sessionId: options.sessionId, turnId: options.turnId,
              finalMessage, stopReason: "completed", usage: {}, permissionDenials: [], turns: 1,
              startedAt: "2026-09-10T00:00:00.000Z", completedAt: "2026-09-10T00:00:00.001Z",
            },
            messages: [...options.messages, finalMessage],
          };
          yield { type: "turn_completed", sessionId: options.sessionId, turnId: options.turnId, result: result.result };
          return result;
        },
      };
    },
  });
  const server = await startGatewayServer({ gateway: local.gateway, port: 0, token: "sdk-session-settings-token" });
  let closeQuery: (() => void) | undefined;
  try {
    const run = query({
      prompt: "Use the supplied settings.",
      options: {
        gatewayUrl: server.wsUrl,
        authToken: server.token,
        projectKey: projectRoot,
        settingSources: ["local", "user", "project"],
        settings: { agent: { maxContextTokens: 8192, thinking: { enabled: false }, subagents: { maxDepth: 2 } } },
      },
    });
    closeQuery = () => run.close();
    const events: unknown[] = [];
    for await (const event of run) events.push(event);
    const result = await run.result();
    assert.equal(result.status, "completed", JSON.stringify({ result, events }));
    assert.equal(received.length, 1);
    assert.equal(received[0].maxContextTokens, 8192);
    assert.equal(received[0].maxOutputTokens, 512);
    assert.deepEqual(received[0].thinking, { enabled: false });
    assert.equal(received[0].provider, "test");
    assert.equal(received[0].model, "reviewer");
    assert.deepEqual(received[0].fallbackModels, [{ provider: "test", model: "reviewer" }]);
    // Both source values are Gateway-resolved and only affect this opted-in
    // session; the ordinary default session below remains unchanged.
    assert.equal(received[0].subagentTimeoutMs, 1234);
    assert.equal(received[0].maxSubagentDepth, 2);
    assert.equal(received[0].subagentModel?.provider, "test");
    assert.equal(received[0].subagentModel?.model, "reviewer");

    // Explicit null restores normal parent-model inheritance without
    // discarding the source-provided timeout from the same nested object.
    run.close();
    closeQuery = undefined;
    const inheritRun = query({
      prompt: "Use parent-model inheritance for forks.",
      options: {
        gatewayUrl: server.wsUrl,
        authToken: server.token,
        projectKey: projectRoot,
        settingSources: ["project", "local", "user"],
        settings: { agent: { model: null, fallbackModel: null, subagents: { default: null } } },
      },
    });
    closeQuery = () => inheritRun.close();
    for await (const _event of inheritRun) { /* consume */ }
    assert.equal((await inheritRun.result()).status, "completed");
    assert.equal(received.length, 2);
    assert.equal(received[1].provider, "test");
    assert.equal(received[1].model, "test");
    assert.equal(received[1].fallbackModels, undefined);
    assert.equal(received[1].subagentTimeoutMs, 1234);
    assert.equal(received[1].maxSubagentDepth, 3);
    assert.equal(received[1].subagentModel, undefined);

    // The explicit SDK option is more specific than a selected source layer.
    inheritRun.close();
    closeQuery = undefined;
    const directFallbackRun = query({
      prompt: "Use an explicit fallback model.",
      options: {
        gatewayUrl: server.wsUrl,
        authToken: server.token,
        projectKey: projectRoot,
        settingSources: ["local"],
        fallbackModel: "test/test",
      },
    });
    closeQuery = () => directFallbackRun.close();
    for await (const _event of directFallbackRun) { /* consume */ }
    assert.equal((await directFallbackRun.result()).status, "completed");
    assert.equal(received.length, 3);
    assert.deepEqual(received[2].fallbackModels, [{ provider: "test", model: "test" }]);

    // A default session continues to use the ordinary resolved host config;
    // SDK source/overlay state does not mutate that global runtime snapshot.
    for await (const _event of local.gateway.submitTurn({
      sessionKey: "sdk:session-settings-default",
      workspaceCwd: projectRoot,
      channelKey: "test",
      message: "Use default settings.",
      mode: "bypassPermissions",
    })) { /* consume */ }
    assert.equal(received.length, 4);
    assert.equal(received[3].maxContextTokens, 4096);
    assert.equal(received[3].maxOutputTokens, 8192);
    assert.deepEqual(received[3].thinking, { enabled: true, budgetTokens: 128 });
    assert.equal(received[3].subagentTimeoutMs, undefined);
    assert.equal(received[3].maxSubagentDepth, undefined);
    assert.equal(received[3].subagentModel, undefined);

    const invalidModel: any[] = [];
    for await (const event of local.gateway.submitTurn({
      sessionKey: "sdk:session-settings-invalid-model",
      workspaceCwd: projectRoot,
      channelKey: "test",
      message: "Reject an unavailable settings model.",
      mode: "bypassPermissions",
      sdkSessionConfig: { settings: { agent: { model: "test/not-in-catalog" } } },
    })) invalidModel.push(event);
    assert.equal(invalidModel.some((event) => event.type === "error" && event.code === "INVALID_SDK_AGENT_MODEL"), true);
  } finally {
    closeQuery?.();
    await server.close();
    local.dispose();
    await rm(root, { recursive: true, force: true });
  }
});

test("SDK MCP permission overrides inject a session-scoped ask rule and clear cleanly", async () => {
  const root = await mkdtemp(join(tmpdir(), "pilotdeck-sdk-mcp-permission-"));
  const projectRoot = join(root, "project");
  await mkdir(projectRoot, { recursive: true });
  await writeFile(join(projectRoot, "pilotdeck.yaml"), TEST_CONFIG, "utf8");

  let receivedConfig: any;
  const local = createLocalGateway({
    projectRoot,
    pilotHome: projectRoot,
    fallbackProjectRoot: projectRoot,
    permissionMode: "bypassPermissions",
    __testModelFactory: () => new TitleModel(),
    __testAgentLoopFactory: ({ config }) => {
      receivedConfig = config;
      return {
        snapshotFileState: () => ({}),
        async *run(options): AsyncGenerator<AgentEvent, AgentLoopRunResult, unknown> {
          const finalMessage = { role: "assistant" as const, content: [{ type: "text" as const, text: "ok" }] };
          const result: AgentLoopRunResult = {
            result: {
              type: "success", sessionId: options.sessionId, turnId: options.turnId,
              finalMessage, stopReason: "completed", usage: {}, permissionDenials: [], turns: 1,
              startedAt: "2026-09-08T00:00:00.000Z", completedAt: "2026-09-08T00:00:00.001Z",
            },
            messages: [...options.messages, finalMessage],
          };
          yield { type: "turn_completed", sessionId: options.sessionId, turnId: options.turnId, result: result.result };
          return result;
        },
      };
    },
  });
  const sessionKey = "sdk:mcp-permission";
  try {
    assert.deepEqual(await local.gateway.setMcpPermissionModeOverride!({ sessionKey, serverName: "tickets", mode: "default" }), {});
    for await (const _event of local.gateway.submitTurn({
      sessionKey, workspaceCwd: projectRoot, channelKey: "test", message: "hello", mode: "bypassPermissions",
    })) { /* consume */ }
    assert.equal(receivedConfig.permissionContext.rules.ask.some((rule: any) => rule.toolName === "mcp__tickets__*"), true);

    assert.deepEqual(await local.gateway.setMcpPermissionModeOverride!({ sessionKey, serverName: "tickets", mode: null }), {});
    for await (const _event of local.gateway.submitTurn({
      sessionKey, workspaceCwd: projectRoot, channelKey: "test", message: "hello again", mode: "bypassPermissions",
    })) { /* consume */ }
    assert.equal(receivedConfig.permissionContext.rules.ask.some((rule: any) => rule.toolName === "mcp__tickets__*"), false);
  } finally {
    local.dispose();
    await rm(root, { recursive: true, force: true });
  }
});
