import type { ModelRuntime } from "../../model/index.js";
import type { PilotAgentModelSelection } from "../../pilot/config/types.js";

export const PROMPT_SUGGESTION_MAX_INPUT_CHARS = 6_000;
export const PROMPT_SUGGESTION_MAX_OUTPUT_CHARS = 320;
export const PROMPT_SUGGESTION_TIMEOUT_MS = 15_000;

const PROMPT_SUGGESTION_SYSTEM_PROMPT = `Suggest the single most useful next message the human user could send after this completed agent turn.

Write the suggestion in the user's voice and in the same natural language as the original request. It must be a short, concrete follow-up request, not advice to the user and not a summary of the completed work. Do not claim an action already happened. Return only the suggested prompt, without quotes, labels, Markdown, code fences, analysis, or explanation.`;

export type PromptSuggestionGeneratorInput = {
  userPrompt: string;
  assistantResponse: string;
  sessionId: string;
  turnId: string;
  signal: AbortSignal;
};

/**
 * Gateway-owned post-turn generator for the opt-in SDK `promptSuggestions`
 * event. Its request is deliberately isolated from the AgentLoop transcript:
 * a suggestion is UI guidance, never conversational state.
 */
export type PromptSuggestionGenerator = (input: PromptSuggestionGeneratorInput) => Promise<string | null>;

export type CreatePromptSuggestionGeneratorOptions = {
  modelRuntime: Pick<ModelRuntime, "complete">;
  agentModel: PilotAgentModelSelection;
  timeoutMs?: number;
};

export function createPromptSuggestionGenerator(
  options: CreatePromptSuggestionGeneratorOptions,
): PromptSuggestionGenerator {
  const timeoutMs = options.timeoutMs ?? PROMPT_SUGGESTION_TIMEOUT_MS;
  return async ({ userPrompt, assistantResponse, sessionId, turnId, signal }) => {
    const prompt = normalizePromptSuggestionInput(userPrompt, assistantResponse);
    if (!prompt) return null;

    const timeoutSignal = AbortSignal.timeout(timeoutMs);
    const combinedSignal = AbortSignal.any([signal, timeoutSignal]);
    try {
      const response = await options.modelRuntime.complete(
        {
          provider: options.agentModel.provider,
          model: options.agentModel.model,
          systemPrompt: PROMPT_SUGGESTION_SYSTEM_PROMPT,
          messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
          maxOutputTokens: 160,
          temperature: 0.2,
          metadata: {
            purpose: "prompt_suggestion_generation",
            sessionId,
            turnId,
          },
        },
        { signal: combinedSignal },
      );
      return sanitizePromptSuggestion(response.content);
    } catch (error) {
      logPromptSuggestionFailure("provider_error", error);
      return null;
    }
  };
}

export function normalizePromptSuggestionInput(
  userPrompt: string,
  assistantResponse: string,
): string | null {
  const user = truncate(userPrompt);
  const assistant = truncate(assistantResponse);
  if (!user || !assistant) return null;
  return `Original user request:\n${user}\n\nCompleted agent response:\n${assistant}`;
}

function sanitizePromptSuggestion(content: Awaited<ReturnType<ModelRuntime["complete"]>>["content"]): string | null {
  const text = content
    .filter((block) => block.type === "text")
    .map((block) => (block.type === "text" ? block.text : ""))
    .join("\n")
    .replace(/^```(?:text|markdown)?\s*/i, "")
    .replace(/\s*```$/i, "")
    .replace(/^(?:suggestion|prompt)\s*:\s*/i, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(["'])|(["'])$/g, "");
  if (!text) {
    logPromptSuggestionFailure("empty_content");
    return null;
  }
  return text.length > PROMPT_SUGGESTION_MAX_OUTPUT_CHARS
    ? text.slice(0, PROMPT_SUGGESTION_MAX_OUTPUT_CHARS).trim()
    : text;
}

function truncate(value: string): string {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= PROMPT_SUGGESTION_MAX_INPUT_CHARS) return normalized;
  const marker = " ... ";
  const available = PROMPT_SUGGESTION_MAX_INPUT_CHARS - marker.length;
  const head = Math.floor(available / 2);
  return `${normalized.slice(0, head)}${marker}${normalized.slice(-(available - head))}`;
}

function logPromptSuggestionFailure(reason: string, error?: unknown): void {
  const message = error instanceof Error ? error.message : String(error ?? "");
  const suffix = message ? `: ${message.slice(0, 200)}` : "";
  console.debug(`[prompt-suggestion] generation skipped (${reason})${suffix}`);
}
