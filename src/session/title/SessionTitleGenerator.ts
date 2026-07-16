import type { ModelRuntime } from "../../model/index.js";
import type { PilotAgentModelSelection } from "../../pilot/config/types.js";

export const SESSION_TITLE_MAX_INPUT_CHARS = 1200;
export const SESSION_TITLE_MAX_OUTPUT_CHARS = 80;
export const SESSION_TITLE_TIMEOUT_MS = 30_000;

const SESSION_TITLE_SYSTEM_PROMPT = `Generate a concise, sentence-case title (3-7 words) that captures the main topic or goal of this coding session. The title should be clear enough that the user recognizes the session in a list. Use sentence case: capitalize only the first word and proper nouns.

Return JSON with a single "title" field.

Good examples:
{"title": "Fix login button on mobile"}
{"title": "Add OAuth authentication"}
{"title": "Debug failing CI tests"}
{"title": "Refactor API client error handling"}

Bad (too vague): {"title": "Code changes"}
Bad (too long): {"title": "Investigate and fix the issue where the login button does not respond on mobile devices"}
Bad (wrong case): {"title": "Fix Login Button On Mobile"}

Do not output Markdown, code fences, explanations, analysis, thinking text, <think> tags, or extra fields.`;

export type SessionTitleGeneratorInput = {
  text: string;
  sessionId: string;
  turnId: string;
  signal: AbortSignal;
};

export type SessionTitleGenerator = (input: SessionTitleGeneratorInput) => Promise<string | null>;

export type CreateSessionTitleGeneratorOptions = {
  modelRuntime: Pick<ModelRuntime, "complete">;
  agentModel: PilotAgentModelSelection;
  timeoutMs?: number;
};

export function createSessionTitleGenerator(
  options: CreateSessionTitleGeneratorOptions,
): SessionTitleGenerator {
  const timeoutMs = options.timeoutMs ?? SESSION_TITLE_TIMEOUT_MS;
  return async ({ text, sessionId, turnId, signal }) => {
    const prompt = normalizeSessionTitleInput(text);
    if (!prompt) {
      return null;
    }

    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const combinedSignal = AbortSignal.any([signal, timeoutSignal]);

    try {
      const response = await options.modelRuntime.complete(
        {
          provider: options.agentModel.provider,
          model: options.agentModel.model,
          systemPrompt: SESSION_TITLE_SYSTEM_PROMPT,
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: prompt }],
            },
          ],
          maxOutputTokens: 4096,
          temperature: 0,
          metadata: {
            purpose: "session_title_generation",
            sessionId,
            turnId,
          },
        },
        { signal: combinedSignal },
      );

      return parseGeneratedTitle(response.content);
    } catch (error) {
      logSessionTitleFailure("provider_error", error);
      return null;
    }
  };
}

export function normalizeSessionTitleInput(text: string): string | null {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (!normalized) {
    return null;
  }
  return normalized.length > SESSION_TITLE_MAX_INPUT_CHARS
    ? normalized.slice(0, SESSION_TITLE_MAX_INPUT_CHARS)
    : normalized;
}

function parseGeneratedTitle(content: Awaited<ReturnType<ModelRuntime["complete"]>>["content"]): string | null {
  const text = content
    .filter((block) => block.type === "text")
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("")
    .trim();
  if (!text) {
    logSessionTitleFailure("empty_content");
    return null;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripJsonFence(text));
  } catch (error) {
    logSessionTitleFailure("invalid_json", error);
    return null;
  }

  if (
    typeof parsed !== "object"
    || parsed === null
    || typeof (parsed as { title?: unknown }).title !== "string"
  ) {
    logSessionTitleFailure("missing_title");
    return null;
  }
  return sanitizeGeneratedTitle((parsed as { title: string }).title);
}

function stripJsonFence(text: string): string {
  const match = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(text.trim());
  return (match?.[1] ?? text).trim();
}

function sanitizeGeneratedTitle(title: string): string | null {
  const normalized = title.replace(/\s+/g, " ").trim();
  if (!normalized) {
    logSessionTitleFailure("missing_title");
    return null;
  }
  return normalized.length > SESSION_TITLE_MAX_OUTPUT_CHARS
    ? normalized.slice(0, SESSION_TITLE_MAX_OUTPUT_CHARS)
    : normalized;
}

function logSessionTitleFailure(reason: string, error?: unknown): void {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const suffix = message ? `: ${message.slice(0, 200)}` : "";
  console.debug(`[session-title] generation skipped (${reason})${suffix}`);
}
