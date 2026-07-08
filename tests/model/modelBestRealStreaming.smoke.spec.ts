import assert from "node:assert/strict";
import test from "node:test";

const BASE_URL = "https://llm-center.ali.modelbest.cn/llm";
const API_KEY = process.env.MODELBEST_API_KEY;
const RUN_REAL = process.env.PILOTDECK_RUN_MODELBEST_REAL_E2E === "1";

type SmokeResult = {
  protocol: string;
  model: string;
  endpoint: string;
  ok: boolean;
  status: number | null;
  contentType: string | null;
  firstChunkMs: number | null;
  chunks: number;
  bytes: number;
  completionMarker: string;
  sample: string;
  error?: string;
};

type SmokeCase = {
  protocol: string;
  model: string;
  endpoint: string;
  headers: Record<string, string>;
  body: Record<string, unknown>;
  completionMarker: string;
  isComplete: (text: string) => boolean;
};

const prompt = "Reply with exactly: STREAM_OK";

const realSmokeCases: SmokeCase[] = [
  {
    protocol: "OpenAI Chat / GPT",
    model: "GPT_pgikl3",
    endpoint: "/v1/chat/completions",
    headers: bearerHeaders(),
    body: { model: "GPT_pgikl3", stream: true, max_tokens: 24, messages: [{ role: "user", content: prompt }] },
    completionMarker: "[DONE]",
    isComplete: (text) => text.includes("[DONE]"),
  },
  {
    protocol: "OpenAI Chat / DeepSeek",
    model: "DEEPSEEK_rtwgny",
    endpoint: "/v1/chat/completions",
    headers: bearerHeaders(),
    body: { model: "DEEPSEEK_rtwgny", stream: true, max_tokens: 24, messages: [{ role: "user", content: prompt }] },
    completionMarker: "[DONE]",
    isComplete: (text) => text.includes("[DONE]"),
  },
  {
    protocol: "OpenAI Chat / Gemini",
    model: "GEMINI_mo7jqq",
    endpoint: "/v1/chat/completions",
    headers: bearerHeaders(),
    body: { model: "GEMINI_mo7jqq", stream: true, max_tokens: 24, messages: [{ role: "user", content: prompt }] },
    completionMarker: "[DONE]",
    isComplete: (text) => text.includes("[DONE]"),
  },
  {
    protocol: "OpenAI Responses / Qwen",
    model: "QWEN_36ltx6",
    endpoint: "/v1/responses",
    headers: bearerHeaders(),
    body: { model: "QWEN_36ltx6", stream: true, max_output_tokens: 24, input: prompt },
    completionMarker: "response.completed",
    isComplete: (text) => text.includes("response.completed"),
  },
  {
    protocol: "Anthropic / Claude",
    model: "CLAUDE_osm7oh",
    endpoint: "/v1/messages",
    headers: anthropicHeaders(),
    body: { model: "CLAUDE_osm7oh", stream: true, max_tokens: 24, messages: [{ role: "user", content: prompt }] },
    completionMarker: "message_stop",
    isComplete: (text) => text.includes("message_stop"),
  },
  {
    protocol: "Anthropic / DeepSeek",
    model: "DEEPSEEK_rtwgny",
    endpoint: "/v1/messages",
    headers: anthropicHeaders(),
    body: { model: "DEEPSEEK_rtwgny", stream: true, max_tokens: 24, messages: [{ role: "user", content: prompt }] },
    completionMarker: "message_stop",
    isComplete: (text) => text.includes("message_stop"),
  },
  {
    protocol: "Gemini Native / Gemini",
    model: "GEMINI_mo7jqq",
    endpoint: "/v1beta/models/GEMINI_mo7jqq:streamGenerateContent",
    headers: googleHeaders(),
    body: { contents: [{ role: "user", parts: [{ text: prompt }] }], generationConfig: { maxOutputTokens: 24 } },
    completionMarker: "finishReason",
    isComplete: (text) => text.includes("finishReason"),
  },
];

test("ModelBest real streaming endpoints smoke test", { skip: !RUN_REAL || !API_KEY }, async () => {
  const results: SmokeResult[] = [];
  for (const testCase of realSmokeCases) {
    results.push(await runSmokeCase(testCase));
  }

  console.table(results.map(({ sample: _sample, ...result }) => result));
  for (const result of results) {
    assert.equal(result.ok, true, `${result.protocol} failed: ${JSON.stringify(result)}`);
    assert.equal(result.status, 200, `${result.protocol} returned unexpected status`);
    assert.match(result.contentType ?? "", /text\/event-stream/i, `${result.protocol} did not stream SSE`);
    assert.equal(typeof result.firstChunkMs, "number", `${result.protocol} did not receive a first chunk`);
    assert.equal(result.chunks > 0, true, `${result.protocol} did not receive chunks`);
  }
});

test("ModelBest model list exposes protocol endpoints", { skip: !RUN_REAL || !API_KEY }, async () => {
  const response = await fetch(`${BASE_URL}/v1/models`, { headers: bearerHeaders() });
  assert.equal(response.status, 200);
  const raw = await response.json() as { data?: Array<{ id?: string; supported_protocols?: Array<{ code?: string; endpoint?: string }> }> };
  const models = raw.data ?? [];
  assert.equal(models.some((model) => model.supported_protocols?.some((protocol) => protocol.code === "OPENAI_HTTP" && protocol.endpoint === "/v1/chat/completions")), true);
  assert.equal(models.some((model) => model.supported_protocols?.some((protocol) => protocol.code === "OPENAI_RESPONSE" && protocol.endpoint === "/v1/responses")), true);
  assert.equal(models.some((model) => model.supported_protocols?.some((protocol) => protocol.code === "ANTHROPIC" && protocol.endpoint === "/v1/messages")), true);
  assert.equal(models.some((model) => model.supported_protocols?.some((protocol) => protocol.code === "GEMINI" && protocol.endpoint === "/v1beta/models/{model}:generateContent")), true);

  const geminiListResponse = await fetch(`${BASE_URL}/v1beta/models`, { headers: googleHeaders() });
  assert.equal(geminiListResponse.status, 404);
});

async function runSmokeCase(testCase: SmokeCase): Promise<SmokeResult> {
  const startedAt = Date.now();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 60_000);
  let status: number | null = null;
  let contentType: string | null = null;
  let firstChunkMs: number | null = null;
  let chunks = 0;
  let bytes = 0;
  let sample = "";
  let completionSeen = false;

  try {
    const response = await fetch(`${BASE_URL}${testCase.endpoint}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...testCase.headers },
      body: JSON.stringify(testCase.body),
      signal: controller.signal,
    });
    status = response.status;
    contentType = response.headers.get("content-type");
    if (!response.body) {
      throw new Error("Missing response body");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        firstChunkMs ??= Date.now() - startedAt;
        chunks += 1;
        bytes += value.byteLength;
        const text = decoder.decode(value, { stream: true });
        if (sample.length < 1500) {
          sample += text.slice(0, 1500 - sample.length);
        }
        completionSeen ||= testCase.isComplete(text) || testCase.isComplete(sample);
        if (completionSeen) {
          break;
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }

    return {
      protocol: testCase.protocol,
      model: testCase.model,
      endpoint: testCase.endpoint,
      ok: response.ok && completionSeen,
      status,
      contentType,
      firstChunkMs,
      chunks,
      bytes,
      completionMarker: testCase.completionMarker,
      sample: sample.replace(/\s+/g, " ").slice(0, 500),
    };
  } catch (error) {
    return {
      protocol: testCase.protocol,
      model: testCase.model,
      endpoint: testCase.endpoint,
      ok: false,
      status,
      contentType,
      firstChunkMs,
      chunks,
      bytes,
      completionMarker: testCase.completionMarker,
      sample: sample.replace(/\s+/g, " ").slice(0, 500),
      error: error instanceof Error ? `${error.name}: ${error.message}` : String(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

function bearerHeaders(): Record<string, string> {
  return { authorization: `Bearer ${API_KEY ?? ""}` };
}

function anthropicHeaders(): Record<string, string> {
  return { "x-api-key": API_KEY ?? "", "anthropic-version": "2023-06-01" };
}

function googleHeaders(): Record<string, string> {
  return { "x-goog-api-key": API_KEY ?? "" };
}
