import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildModelRequest } from "../../../src/model/request/buildModelRequest.js";
import { parseModelConfig } from "../../../src/model/config/parseModelConfig.js";
import { normalizeGoogleModelId } from "../../../src/model/providers/google/modelId.js";
import { normalizeGoogleToolSchema } from "../../../src/model/providers/google/schema.js";
import type { CanonicalModelRequest } from "../../../src/model/protocol/canonical.js";

describe("Google model request adaptation", () => {
  it("accepts native google protocol configs and defaults Gemini model capabilities", () => {
    const config = parseModelConfig({
      providers: {
        google: {
          protocol: "google",
          url: "https://generativelanguage.googleapis.com",
          apiKey: "${GEMINI_API_KEY}",
          models: {
            "gemini-3-pro": {},
          },
        },
      },
    }, { env: { GEMINI_API_KEY: " test-key\n" } });

    assert.equal(config.providers.google?.protocol, "google");
    assert.equal(config.providers.google?.apiKey, "test-key");
    assert.equal(config.providers.google?.models["gemini-3-pro"]?.capabilities.supportsToolUse, true);
  });

  it("keeps Google OpenAI-compatible configs on the legacy default URL", () => {
    const config = parseModelConfig({
      providers: {
        google: {
          protocol: "openai",
          apiKey: "key",
          models: {
            "gemini-2.5-flash": {},
          },
        },
      },
    });

    assert.equal(config.providers.google?.protocol, "openai");
    assert.equal(
      config.providers.google?.url,
      "https://generativelanguage.googleapis.com/v1beta/openai",
    );
  });

  it("normalizes common Gemini aliases to preview ids", () => {
    assert.equal(normalizeGoogleModelId("gemini-3-pro"), "gemini-3-pro-preview");
    assert.equal(normalizeGoogleModelId("gemini-3.1-pro"), "gemini-3.1-pro-preview");
    assert.equal(normalizeGoogleModelId("gemini-3.1-flash"), "gemini-3-flash-preview");
    assert.equal(normalizeGoogleModelId("google/gemini-2.5-flash"), "gemini-2.5-flash");
  });

  it("cleans tool JSON Schema for Gemini function declarations", () => {
    const cleaned = normalizeGoogleToolSchema({
      type: "object",
      additionalProperties: false,
      required: ["pattern", "-A", "mode", "refValue"],
      properties: {
        pattern: { type: "string", minLength: 1, pattern: "x+" },
        "-A": { type: "integer", minimum: 0 },
        mode: {
          anyOf: [
            { const: "content", type: "string" },
            { const: "count", type: "string" },
          ],
        },
        refValue: { $ref: "#/$defs/RefValue", description: "Resolved reference." },
      },
      $defs: {
        RefValue: { type: "string", format: "uri" },
      },
    });

    assert.equal(cleaned.type, "object");
    assert.deepEqual(cleaned.required, ["pattern", "mode", "refValue"]);
    assert.equal("additionalProperties" in cleaned, false);
    const properties = cleaned.properties as Record<string, unknown>;
    assert.equal("-A" in properties, false);
    assert.deepEqual(properties.pattern, { type: "string" });
    assert.deepEqual(properties.mode, { type: "string", enum: ["content", "count"] });
    assert.deepEqual(properties.refValue, {
      type: "string",
      description: "Resolved reference.",
    });
  });

  it("flattens top-level object unions before sending tools", () => {
    const cleaned = normalizeGoogleToolSchema({
      anyOf: [
        {
          type: "object",
          required: ["action"],
          properties: {
            action: { const: "read", type: "string" },
            path: { type: "string" },
          },
        },
        {
          type: "object",
          required: ["action"],
          properties: {
            action: { const: "write", type: "string" },
            content: { type: "string" },
          },
        },
      ],
      additionalProperties: false,
    });

    assert.equal(cleaned.type, "object");
    assert.deepEqual(cleaned.required, ["action"]);
    const properties = cleaned.properties as Record<string, unknown>;
    assert.deepEqual(properties.action, { type: "string", enum: ["read", "write"] });
    assert.deepEqual(properties.path, { type: "string" });
    assert.deepEqual(properties.content, { type: "string" });
    assert.equal("additionalProperties" in cleaned, false);
  });

  it("builds native Gemini requests with cleaned tools, thinking, and history order", () => {
    const config = parseModelConfig({
      providers: {
        google: {
          protocol: "google",
          url: "https://generativelanguage.googleapis.com",
          apiKey: "key",
          models: {
            "gemini-3-pro": {
              capabilities: { supportsThinking: true },
            },
          },
        },
      },
    });

    const request: CanonicalModelRequest = {
      provider: "google",
      model: "gemini-3-pro",
      systemPrompt: "Be terse.",
      thinking: { enabled: true, budgetTokens: -1 } as never,
      messages: [
        {
          role: "assistant",
          content: [
            { type: "text", text: "Earlier answer." },
            { type: "tool_call", id: "call 1", name: "lookup", input: { query: "x" } },
          ],
        },
        {
          role: "user",
          content: [
            {
              type: "tool_result",
              toolCallId: "call 1",
              content: [{ type: "text", text: "result" }],
            },
            { type: "text", text: "Continue." },
          ],
        },
      ],
      tools: [{
        name: "lookup",
        inputSchema: {
          type: "object",
          properties: {
            query: { type: "string", minLength: 1 },
            "-A": { type: "integer" },
          },
          required: ["query", "-A"],
          additionalProperties: false,
        },
      }],
    };

    const body = buildModelRequest(request, config) as Record<string, unknown>;
    assert.equal(body.model, "gemini-3-pro-preview");

    const contents = body.contents as Array<{ role: string; parts: Array<Record<string, unknown>> }>;
    assert.equal(contents[0]?.role, "user");
    assert.equal(contents[1]?.role, "model");
    assert.equal(contents[2]?.role, "user");
    assert.deepEqual(contents[2]?.parts[0]?.functionResponse, {
      id: "call_1",
      name: "lookup",
      response: { output: "result" },
    });

    const configBody = body.config as Record<string, unknown>;
    assert.deepEqual(configBody.thinkingConfig, { includeThoughts: true });
    assert.deepEqual(configBody.systemInstruction, { text: "Be terse." });
    const tools = configBody.tools as Array<{ functionDeclarations: Array<Record<string, unknown>> }>;
    const schema = tools[0]?.functionDeclarations[0]?.parametersJsonSchema as Record<string, unknown>;
    assert.deepEqual(schema.required, ["query"]);
    assert.equal("-A" in (schema.properties as Record<string, unknown>), false);
  });
});
