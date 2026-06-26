/**
 * `web_fetch` builtin tool — full-fat parity port. See
 * `docs/pilotdeck-deferred-feature-implementation-guide.md` §5.2 (B2) for
 * the 13-behaviour alignment checklist this implementation tracks.
 */

import type {
  CanonicalModelRequest,
  CanonicalUsage,
} from "../../model/index.js";
import type { PermissionResult } from "../../permission/index.js";
import { PilotDeckToolRuntimeError } from "../protocol/errors.js";
import type {
  PilotDeckToolDefinition,
  PilotDeckToolExecutionOutput,
  PilotDeckToolModelClient,
  PilotDeckToolRuntimeContext,
} from "../protocol/types.js";
import { isPreapprovedUrl } from "./web/preapprovedHosts.js";
import {
  makeSecondaryModelPrompt,
  WEB_FETCH_DESCRIPTION,
} from "./web/secondaryPrompt.js";
import {
  getURLMarkdownContent,
  MAX_MARKDOWN_LENGTH,
  type RedirectInfo,
  type WebFetchHttpResult,
  truncateMarkdown,
} from "./web/urlFetcher.js";
import { validateURL } from "./web/urlValidation.js";

function isRedirectInfo(
  result: WebFetchHttpResult,
): result is RedirectInfo {
  return (result as RedirectInfo).type === "redirect";
}

export type WebFetchMode = "llm" | "raw";

export type WebFetchInput = {
  url: string;
  prompt?: string;
  mode?: WebFetchMode;
};

export type WebFetchOutput = {
  url: string;
  fromCache: boolean;
  mode: WebFetchMode;
  llmUsed: boolean;
  contentType?: string;
  bytes?: number;
  status?: number;
  truncated?: boolean;
  rawLength?: number;
  returnedLength?: number;
  modelResponse?: string;
  redirect?: { redirectUrl: string; statusCode: number };
};

export type CreateWebFetchToolOptions = {
  /**
   * Override the model used for content extraction. Falls back to
   * `context.model` (provided by AgentLoop). When neither is available
   * the tool returns the raw markdown without summarization.
   */
  model?: PilotDeckToolModelClient;
  /** Provider id used for the secondary model call. Default: openrouter. */
  provider?: string;
  /** Model id used for the secondary model call. Default: kimi/k2.6. */
  modelId?: string;
  /** Max output tokens for the secondary call. Default: 1024. */
  maxOutputTokens?: number;
  /** Temperature for the secondary call. Default: 0. */
  temperature?: number;
  /** Test seam for replacing the low-level URL fetcher. */
  fetchUrl?: typeof getURLMarkdownContent;
};

const DEFAULT_PROVIDER = "openrouter";
const DEFAULT_MODEL_ID = "moonshotai/kimi-k2.6";
const DEFAULT_MAX_OUTPUT_TOKENS = 1024;
const DEFAULT_MODE: WebFetchMode = "llm";

function resolveMode(mode: WebFetchInput["mode"]): WebFetchMode {
  return mode ?? DEFAULT_MODE;
}

function isTruncated(rawLength: number): boolean {
  return rawLength > MAX_MARKDOWN_LENGTH;
}

export function createWebFetchTool(
  options: CreateWebFetchToolOptions = {},
): PilotDeckToolDefinition<WebFetchInput, WebFetchOutput> {
  return {
    name: "web_fetch",
    aliases: ["WebFetch"],
    description: WEB_FETCH_DESCRIPTION,
    kind: "network",
    inputSchema: {
      type: "object",
      required: ["url"],
      additionalProperties: false,
      properties: {
        url: {
          type: "string",
          description: "Fully-formed URL to fetch. HTTP URLs will be upgraded to HTTPS before the request is issued.",
        },
        prompt: {
          type: "string",
          description:
            "Question or extraction directive to apply to the fetched markdown. When no model client is available, the tool returns raw markdown instead of a prompted summary.",
        },
        mode: {
          type: "string",
          enum: ["llm", "raw"],
          description:
            'Fetch mode. "llm" (default) applies prompt with the secondary model. "raw" returns fetched markdown directly without any model processing.',
        },
      },
    },
    maxResultBytes: 200_000,
    isReadOnly: () => true,
    isConcurrencySafe: () => true,
    isOpenWorld: () => true,
    checkPermissions: async (): Promise<PermissionResult> => ({
      type: "ask",
      reason: {
        type: "tool",
        toolName: "web_fetch",
        message: "Network fetch requires permission.",
      },
      request: {
        toolCallId: "",
        toolName: "web_fetch",
        inputSummary: "web fetch",
        reason: {
          type: "tool",
          toolName: "web_fetch",
          message: "Network fetch requires permission.",
        },
        options: [
          { id: "allow_once", label: "Allow fetch" },
          { id: "deny", label: "Deny" },
        ],
      },
    }),
    validateInput: async (input) => {
      if (!input || typeof input !== "object") {
        return {
          ok: false,
          issues: [{ path: "", code: "invalid_type", message: "input must be an object" }],
        };
      }
      const url = (input as Partial<WebFetchInput>).url;
      const prompt = (input as Partial<WebFetchInput>).prompt;
      const mode = (input as Partial<WebFetchInput>).mode;
      if (typeof url !== "string" || url.length === 0) {
        return {
          ok: false,
          issues: [{ path: "url", code: "required", message: "url is required" }],
        };
      }
      if (!validateURL(url)) {
        return {
          ok: false,
          issues: [
            {
              path: "url",
              code: "invalid_type",
              message:
                "url failed validation (length > 2000, malformed, embedded credentials, or non-public hostname).",
            },
          ],
        };
      }
      if (mode !== undefined && mode !== "llm" && mode !== "raw") {
        return {
          ok: false,
          issues: [{ path: "mode", code: "invalid_enum", message: 'mode must be "llm" or "raw"' }],
        };
      }
      const resolvedMode = resolveMode(mode);
      if (resolvedMode === "llm" && (typeof prompt !== "string" || prompt.length === 0)) {
        return {
          ok: false,
          issues: [{ path: "prompt", code: "required", message: 'prompt is required when mode is "llm"' }],
        };
      }
      return { ok: true, input };
    },
    execute: async (input, context): Promise<PilotDeckToolExecutionOutput<WebFetchOutput>> => {
      const { url } = input;
      const mode = resolveMode(input.mode);
      const prompt = input.prompt ?? "";
      const signal = context.abortSignal ?? new AbortController().signal;
      if (mode === "llm" && prompt.length === 0) {
        throw new PilotDeckToolRuntimeError(
          "invalid_tool_input",
          'web_fetch prompt is required when mode is "llm". Use mode "raw" to fetch markdown without a secondary model.',
        );
      }

      const fetchUrl = options.fetchUrl ?? getURLMarkdownContent;
      let httpResult: WebFetchHttpResult;
      try {
        httpResult = await fetchUrl(url, signal);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        throw new PilotDeckToolRuntimeError(
          "tool_execution_failed",
          `web_fetch failed: ${message}`,
        );
      }

      if (isRedirectInfo(httpResult)) {
        const r = httpResult;
        const text =
          `Redirect detected (status ${r.statusCode}).\n` +
          `Original URL: ${r.originalUrl}\n` +
          `Redirect target: ${r.redirectUrl}\n` +
          `The redirect target is on a different host and was not auto-followed. ` +
          `If you trust the destination, call web_fetch again with that URL.`;
        return {
          content: [{ type: "text", text }],
          data: {
            url,
            fromCache: false,
            mode,
            llmUsed: false,
            redirect: { redirectUrl: r.redirectUrl, statusCode: r.statusCode },
          },
        };
      }

      const fetched = httpResult;
      const truncated = truncateMarkdown(fetched.content);
      const rawLength = fetched.content.length;
      const sourceTruncated = isTruncated(rawLength);
      const isPreapproved = isPreapprovedUrl(url);

      if (mode === "raw") {
        return {
          content: [{ type: "text", text: truncated }],
          data: {
            url,
            fromCache: fetched.fromCache,
            mode,
            llmUsed: false,
            contentType: fetched.contentType,
            bytes: fetched.bytes,
            status: fetched.code,
            truncated: sourceTruncated,
            rawLength,
            returnedLength: truncated.length,
          },
        };
      }

      const model = options.model ?? context.model;
      if (!model) {
        return {
          content: [{ type: "text", text: truncated }],
          data: {
            url,
            fromCache: fetched.fromCache,
            mode,
            llmUsed: false,
            contentType: fetched.contentType,
            bytes: fetched.bytes,
            status: fetched.code,
            truncated: sourceTruncated,
            rawLength,
            returnedLength: truncated.length,
          },
        };
      }

      const secondaryPrompt = makeSecondaryModelPrompt(truncated, prompt, isPreapproved);
      const request: CanonicalModelRequest = {
        provider: options.provider ?? DEFAULT_PROVIDER,
        model: options.modelId ?? DEFAULT_MODEL_ID,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: secondaryPrompt }],
          },
        ],
        maxOutputTokens: options.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
        temperature: options.temperature ?? 0,
        stream: true,
        metadata: { tool: "web_fetch", url },
      };

      let modelText = "";
      let _usage: CanonicalUsage | undefined;
      try {
        for await (const event of model.stream(request, signal)) {
          if (signal.aborted) {
            throw new PilotDeckToolRuntimeError(
              "tool_aborted",
              "web_fetch aborted before completion.",
            );
          }
          switch (event.type) {
            case "text_delta":
              modelText += event.text;
              break;
            case "usage":
              _usage = event.usage;
              break;
            case "error":
              throw new PilotDeckToolRuntimeError(
                "tool_execution_failed",
                `web_fetch secondary model error: ${event.error.message}`,
                { errorCode: event.error.code },
              );
            default:
              break;
          }
        }
      } catch (err) {
        if (err instanceof PilotDeckToolRuntimeError) throw err;
        const message = err instanceof Error ? err.message : String(err);
        throw new PilotDeckToolRuntimeError(
          "tool_execution_failed",
          `web_fetch secondary model failed: ${message}`,
        );
      }

      const finalText = modelText.length > 0 ? modelText : "[No response from secondary model]";
      return {
        content: [{ type: "text", text: finalText }],
        data: {
          url,
          fromCache: fetched.fromCache,
          mode,
          llmUsed: true,
          contentType: fetched.contentType,
          bytes: fetched.bytes,
          status: fetched.code,
          truncated: sourceTruncated,
          rawLength,
          returnedLength: finalText.length,
          modelResponse: finalText,
        },
      };
    },
  };
}
