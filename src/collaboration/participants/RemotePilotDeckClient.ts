import { networkPostJson } from "../../network/fetch.js";
import type { GroupChatInvocation } from "../protocol/types.js";

type OpenAiChatCompletion = {
  choices?: Array<{
    message?: {
      content?: unknown;
    };
  }>;
};

export type RemotePilotDeckClientOptions = {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
};

export class RemotePilotDeckClient {
  private readonly fetchImpl?: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: RemotePilotDeckClientOptions = {}) {
    this.fetchImpl = options.fetchImpl;
    this.timeoutMs = options.timeoutMs ?? 300_000;
  }

  async invoke(
    invocation: GroupChatInvocation,
    prompt: string,
    env: NodeJS.ProcessEnv,
    signal?: AbortSignal,
  ): Promise<string> {
    const endpoint = invocation.participant.endpoint;
    if (!endpoint) throw new Error("Remote PilotDeck participant is missing endpoint.");
    const token = invocation.participant.tokenEnv
      ? env[invocation.participant.tokenEnv]
      : undefined;
    const headers: Record<string, string> = {
      "X-Hermes-Session-Id": remoteSessionId(invocation.room.id, invocation.participant.id),
    };
    if (token) headers.Authorization = `Bearer ${token}`;

    const { json } = await networkPostJson<OpenAiChatCompletion>(
      chatCompletionsUrl(endpoint),
      {
        model: "pilotdeck-gateway",
        stream: false,
        messages: [{ role: "user", content: prompt }],
      },
      { headers },
      {
        fetchImpl: this.fetchImpl,
        signal,
        timeoutMs: this.timeoutMs,
        // Chat turns are not idempotent; never retry a POST automatically.
        retry: { maxRetries: 0 },
      },
    );
    const content = json.choices?.[0]?.message?.content;
    const text = normalizeOpenAiContent(content).trim();
    if (!text) throw new Error("Remote PilotDeck returned an empty response.");
    return text;
  }
}

function chatCompletionsUrl(endpoint: string): string {
  const trimmed = endpoint.replace(/\/$/u, "");
  return trimmed.endsWith("/v1/chat/completions")
    ? trimmed
    : `${trimmed}/v1/chat/completions`;
}

function remoteSessionId(roomId: string, participantId: string): string {
  return encodeURIComponent(`group:${roomId}:${participantId}`).slice(0, 240);
}

function normalizeOpenAiContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      if (typeof item === "string") return item;
      if (!item || typeof item !== "object") return "";
      const record = item as Record<string, unknown>;
      return (record.type === "text" || record.type === "output_text") && typeof record.text === "string"
        ? record.text
        : "";
    })
    .filter(Boolean)
    .join("\n");
}
