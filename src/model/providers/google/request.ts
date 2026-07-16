import {
  FunctionCallingConfigMode,
  type Content,
  type FunctionDeclaration,
  type FunctionResponsePart,
  type GenerateContentConfig,
  type GenerateContentParameters,
  type Part,
  type Tool,
} from "@google/genai";
import type {
  CanonicalContentBlock,
  CanonicalMessage,
  CanonicalModelRequest,
  CanonicalToolChoice,
  CanonicalToolResultContentBlock,
  CanonicalToolSchema,
  ModelDefinition,
} from "../../protocol/canonical.js";
import { flattenToolResultBlockText } from "../../protocol/toolResultContent.js";
import { messageContent } from "../../protocol/clone.js";
import { normalizeGoogleModelId } from "./modelId.js";
import { cleanSchemaForGoogle, normalizeGoogleToolSchema } from "./schema.js";
import { resolveThinkingPlan, throwIfUnsupportedThinkingPlan } from "../../thinking/registry.js";
import { formatToolResultReferenceText } from "../toolResultReferenceText.js";

export type GoogleRequestBody = GenerateContentParameters;

export function buildGoogleRequest(
  request: CanonicalModelRequest,
  model: ModelDefinition,
): GoogleRequestBody {
  const tools = request.tools?.map(toGoogleFunctionDeclaration) ?? [];
  const config: GenerateContentConfig = {
    maxOutputTokens: request.maxOutputTokens ?? model.capabilities.maxOutputTokens,
    temperature: request.temperature,
    systemInstruction: request.systemPrompt ? { text: request.systemPrompt } : undefined,
    automaticFunctionCalling: { disable: true },
    tools: tools.length > 0 ? [{ functionDeclarations: tools } satisfies Tool] : undefined,
    toolConfig: toGoogleToolConfig(request.toolChoice),
    thinkingConfig: toGoogleThinkingConfig(request, model),
  };

  if (request.outputSchema) {
    config.responseMimeType = "application/json";
    config.responseJsonSchema = cleanSchemaForGoogle(request.outputSchema.schema);
  }

  return {
    model: normalizeGoogleModelId(request.model),
    contents: sanitizeGoogleContents(toGoogleContents(request.messages)),
    config: compactObject(config) as GenerateContentConfig,
  };
}

function toGoogleFunctionDeclaration(tool: CanonicalToolSchema): FunctionDeclaration {
  return {
    name: tool.name,
    description: tool.description,
    parametersJsonSchema: normalizeGoogleToolSchema(tool.inputSchema),
  };
}

function toGoogleToolConfig(toolChoice: CanonicalToolChoice | undefined): GenerateContentConfig["toolConfig"] {
  if (!toolChoice) {
    return undefined;
  }
  if (toolChoice === "auto") {
    return { functionCallingConfig: { mode: FunctionCallingConfigMode.AUTO } };
  }
  if (toolChoice === "none") {
    return { functionCallingConfig: { mode: FunctionCallingConfigMode.NONE } };
  }
  if (toolChoice === "required") {
    return { functionCallingConfig: { mode: FunctionCallingConfigMode.ANY } };
  }
  return {
    functionCallingConfig: {
      mode: FunctionCallingConfigMode.ANY,
      allowedFunctionNames: [toolChoice.name],
    },
  };
}

function toGoogleThinkingConfig(
  request: CanonicalModelRequest,
  model: ModelDefinition,
): GenerateContentConfig["thinkingConfig"] {
  const thinkingPlan = resolveThinkingPlan(request.thinking, { id: "google", protocol: "google", url: "", apiKey: "", headers: {}, models: {} }, model);
  throwIfUnsupportedThinkingPlan(thinkingPlan, request);
  if (!thinkingPlan.enabled || !model.capabilities.supportsThinking) {
    return undefined;
  }
  if (thinkingPlan.useGeminiLevel && thinkingPlan.thinkingLevel) {
    return {
      includeThoughts: true,
      thinkingLevel: thinkingPlan.thinkingLevel,
    } as unknown as GenerateContentConfig["thinkingConfig"];
  }
  const budget = thinkingPlan.budgetTokens;
  return {
    includeThoughts: true,
    ...(typeof budget === "number" && Number.isFinite(budget) && budget >= 0
      ? { thinkingBudget: budget }
      : {}),
  };
}

function toGoogleContents(messages: CanonicalMessage[]): Content[] {
  const toolNamesById = collectToolCallNames(messages);
  const contents: Content[] = [];

  for (const message of messages) {
    let currentRole: "user" | "model" | undefined;
    let currentParts: Part[] = [];

    const flush = () => {
      if (currentRole && currentParts.length > 0) {
        contents.push({ role: currentRole, parts: currentParts });
      }
      currentRole = undefined;
      currentParts = [];
    };

    const push = (role: "user" | "model", parts: Part[]) => {
      if (parts.length === 0) {
        return;
      }
      if (currentRole !== role) {
        flush();
        currentRole = role;
      }
      currentParts.push(...parts);
    };

    for (const block of messageContent(message)) {
      const role = googleRoleForBlock(message.role, block);
      push(role, toGoogleParts(block, toolNamesById));
    }

    flush();
  }

  return contents;
}

function googleRoleForBlock(
  messageRole: CanonicalMessage["role"],
  block: CanonicalContentBlock,
): "user" | "model" {
  if (block.type === "tool_result" || block.type === "tool_result_reference") {
    return "user";
  }
  return messageRole === "assistant" ? "model" : "user";
}

function toGoogleParts(block: CanonicalContentBlock, toolNamesById: Map<string, string>): Part[] {
  switch (block.type) {
    case "text":
      return block.text.length > 0 ? [{ text: block.text }] : [];
    case "thinking":
      return [{
        text: block.text,
        thought: true,
        ...(block.signature ? { thoughtSignature: block.signature } : {}),
      }];
    case "image":
    case "pdf":
    case "audio":
      return [toGoogleMediaPart(block)];
    case "tool_call":
      return [{
        functionCall: {
          id: sanitizeGoogleToolCallId(block.id),
          name: block.name,
          args: toGoogleArgs(block.input),
        },
      }];
    case "tool_result":
      return [toGoogleFunctionResponsePart(
        sanitizeGoogleToolCallId(block.toolCallId),
        toolNamesById.get(sanitizeGoogleToolCallId(block.toolCallId)) ?? block.toolCallId,
        flattenToolResultBlockText(block),
        block.isError,
        block.content,
      )];
    case "tool_result_reference":
      return [toGoogleFunctionResponsePart(
        sanitizeGoogleToolCallId(block.toolCallId),
        toolNamesById.get(sanitizeGoogleToolCallId(block.toolCallId)) ?? block.toolCallId,
        formatToolResultReferenceText(block),
        block.isError,
        [],
      )];
    case "media_reference":
      return [{ text: block.preview }];
  }
}

function toGoogleMediaPart(
  block: Extract<CanonicalContentBlock, { type: "image" | "pdf" | "audio" }>,
): Part {
  if (block.source === "url") {
    return { fileData: { fileUri: block.data, mimeType: block.mimeType } };
  }
  return { inlineData: { data: block.data, mimeType: block.mimeType } };
}

function toGoogleFunctionResponsePart(
  id: string,
  name: string,
  output: string,
  isError: boolean | undefined,
  content: CanonicalToolResultContentBlock[],
): Part {
  const response: Record<string, unknown> = isError
    ? { error: output || "Tool execution failed." }
    : { output };
  const parts = content.flatMap(toGoogleFunctionResponseMediaPart);
  return {
    functionResponse: {
      id,
      name,
      response,
      ...(parts.length > 0 ? { parts } : {}),
    },
  };
}

function toGoogleFunctionResponseMediaPart(
  block: CanonicalToolResultContentBlock,
): FunctionResponsePart[] {
  if (block.type === "text") {
    return [];
  }
  if (block.source === "url") {
    return [{ fileData: { fileUri: block.data, mimeType: block.mimeType } }];
  }
  return [{ inlineData: { data: block.data, mimeType: block.mimeType } }];
}

function sanitizeGoogleContents(contents: Content[]): Content[] {
  const merged: Content[] = [];
  for (const content of contents) {
    if (!content.parts?.length) {
      continue;
    }
    const prev = merged.length > 0 ? merged[merged.length - 1] : undefined;
    if (prev !== undefined && prev.role === content.role) {
      prev.parts = [...(prev.parts ?? []), ...(content.parts ?? [])];
    } else {
      merged.push({ ...content, parts: [...content.parts] });
    }
  }

  if (merged[0]?.role === "model") {
    merged.unshift({
      role: "user",
      parts: [{ text: "Continue the conversation from the available context." }],
    });
  }

  return merged.length > 0 ? merged : [{ role: "user", parts: [{ text: "" }] }];
}

function collectToolCallNames(messages: CanonicalMessage[]): Map<string, string> {
  const map = new Map<string, string>();
  for (const message of messages) {
    for (const block of messageContent(message)) {
      if (block.type === "tool_call") {
        map.set(sanitizeGoogleToolCallId(block.id), block.name);
      }
    }
  }
  return map;
}

function sanitizeGoogleToolCallId(id: string): string {
  return id.trim().replace(/[^A-Za-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "call";
}

function toGoogleArgs(input: unknown): Record<string, unknown> {
  return input && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : { value: input };
}

function compactObject<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined),
  ) as Partial<T>;
}
