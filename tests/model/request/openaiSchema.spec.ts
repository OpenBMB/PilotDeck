import assert from "node:assert/strict";
import test from "node:test";

import { CRON_SCHEDULE_SCHEMA } from "../../../src/cron/tool/CronSchemas.js";
import { buildModelRequest } from "../../../src/model/index.js";
import type {
  CanonicalModelRequest,
  ModelCapabilities,
  ModelConfig,
  ModelDefinition,
  ModelProtocol,
  ProviderConfig,
} from "../../../src/model/index.js";
import { normalizeOpenAISchema } from "../../../src/model/providers/openai/schema.js";
import type { OpenAIResponsesRequestBody } from "../../../src/model/providers/openai-responses/request.js";

test("openai schema normalization adds explicit types to cron literal variants", () => {
  const normalized = normalizeOpenAISchema({
    type: "object",
    required: ["schedule"],
    additionalProperties: false,
    properties: {
      schedule: CRON_SCHEDULE_SCHEMA,
    },
  });

  const properties = normalized.properties as Record<string, Record<string, unknown>>;
  const schedule = properties.schedule;
  const variants = schedule.anyOf as Array<Record<string, unknown>>;

  const onceProperties = variants[0]?.properties as Record<string, Record<string, unknown>>;
  assert.equal(onceProperties.type.type, "string");
  assert.equal(onceProperties.type.const, "once");

  const cronProperties = variants[1]?.properties as Record<string, Record<string, unknown>>;
  assert.equal(cronProperties.type.type, "string");
  assert.equal(cronProperties.type.const, "cron");

  const delayProperties = variants[2]?.properties as Record<string, Record<string, unknown>>;
  assert.equal(delayProperties.type.type, "string");
  assert.equal(delayProperties.type.const, "delay");
  assert.equal(delayProperties.unit.type, "string");
  assert.deepEqual(delayProperties.unit.enum, ["second", "minute", "hour", "day"]);
});

test("openai schema normalization preserves array item fallback", () => {
  const normalized = normalizeOpenAISchema({
    type: "object",
    additionalProperties: false,
    properties: {
      value: {
        type: ["string", "array"],
      },
    },
  });

  const properties = normalized.properties as Record<string, Record<string, unknown>>;
  assert.deepEqual(properties.value.items, {});
});

test("openai response_format schemas get literal types normalized", () => {
  const body = buildModelRequest(outputSchemaRequest("openai"), modelConfig("openai")) as {
    response_format?: { json_schema: { schema: Record<string, unknown> } };
  };

  const schema = body.response_format?.json_schema.schema;
  assert.ok(schema);
  assertLiteralTypes(schema);
});

test("openai responses output schemas get literal types normalized", () => {
  const body = buildModelRequest(outputSchemaRequest("openai-responses"), modelConfig("openai-responses")) as {
    text?: { format: { schema: Record<string, unknown> } };
  };

  const schema = body.text?.format.schema;
  assert.ok(schema);
  assertLiteralTypes(schema);
});

test("openai responses tools preserve optional parameters without strict validation", () => {
  const inputSchema = {
    type: "object",
    additionalProperties: false,
    required: ["description", "prompt"],
    properties: {
      description: { type: "string" },
      prompt: { type: "string" },
      subagentType: { type: "string" },
      options: {
        type: "object",
        properties: { label: { type: "string" } },
      },
    },
  };
  const originalSchema = structuredClone(inputSchema);
  const request = outputSchemaRequest("openai-responses");
  request.tools = [{ name: "agent", description: "Run an agent", inputSchema }];
  const body = buildModelRequest(request, modelConfig("openai-responses")) as {
    tools: Array<{ strict: boolean; parameters: Record<string, unknown> }>;
    text: { format: { strict: boolean } };
  };

  assert.equal(body.tools[0].strict, false);
  assert.deepEqual(body.tools[0].parameters, originalSchema);
  assert.deepEqual(inputSchema, originalSchema);
  assert.equal(body.text.format.strict, true);
});

test("openai responses tools allow free-form object arguments", () => {
  const request = outputSchemaRequest("openai-responses");
  request.tools = [{ name: "custom", description: "Accept metadata", inputSchema: {
    type: "object",
    properties: { metadata: { type: "object", additionalProperties: { type: "string" } } },
  } }];
  const body = buildModelRequest(request, modelConfig("openai-responses")) as {
    tools: Array<{ strict: boolean; parameters: Record<string, unknown> }>;
  };

  assert.equal(body.tools[0].strict, false);
  assert.deepEqual(body.tools[0].parameters, request.tools[0].inputSchema);
});

test("openai responses encodes assistant history as output text", () => {
  const request = outputSchemaRequest("openai-responses");
  request.messages = [
    { role: "user", content: [{ type: "text", text: "hello" }] },
    { role: "assistant", content: [{ type: "text", text: "hi" }] },
    { role: "user", content: [{ type: "text", text: "continue" }] },
  ];
  const body = buildModelRequest(request, modelConfig("openai-responses")) as OpenAIResponsesRequestBody;

  assert.deepEqual(body.input, [
    { role: "user", content: [{ type: "input_text", text: "hello" }] },
    { role: "assistant", content: [{ type: "output_text", text: "hi" }] },
    { role: "user", content: [{ type: "input_text", text: "continue" }] },
  ]);
});

function outputSchemaRequest(provider: string): CanonicalModelRequest {
  return {
    provider,
    model: "test-model",
    stream: true,
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    outputSchema: {
      name: "result",
      schema: {
        type: "object",
        additionalProperties: false,
        required: ["status", "kind"],
        properties: {
          status: { enum: ["ok", "failed"] },
          kind: { const: "report" },
        },
      },
    },
  };
}

function assertLiteralTypes(schema: Record<string, unknown>): void {
  const properties = schema.properties as Record<string, Record<string, unknown>>;
  assert.equal(properties.status.type, "string");
  assert.deepEqual(properties.status.enum, ["ok", "failed"]);
  assert.equal(properties.kind.type, "string");
  assert.equal(properties.kind.const, "report");
}

function modelConfig(protocol: ModelProtocol): ModelConfig {
  const capabilities: ModelCapabilities = {
    supportsToolUse: true,
    supportsStreaming: true,
    supportsParallelToolCalls: true,
    supportsThinking: false,
    supportsJsonSchema: true,
    supportsSystemPrompt: true,
    supportsPromptCache: false,
    maxContextTokens: 128_000,
    maxOutputTokens: 4_096,
  };
  const models: Record<string, ModelDefinition> = {
    "test-model": {
      id: "test-model",
      capabilities,
      multimodal: { input: ["text"] },
    },
  };
  const provider: ProviderConfig = {
    id: protocol,
    protocol,
    url: "https://example.invalid/v1",
    apiKey: "test",
    headers: {},
    models,
  };
  return { providers: { [protocol]: provider } };
}
