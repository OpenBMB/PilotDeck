#!/usr/bin/env node
import assert from "node:assert/strict";

const RUN = process.env.PILOTDECK_RUN_LIVE_LLM_CENTER === "1";
if (!RUN) {
  console.log("Skipping live LLM Center smoke tests. Set PILOTDECK_RUN_LIVE_LLM_CENTER=1 to run.");
  process.exit(0);
}

const apiKey = requiredEnv("PILOTDECK_LLM_CENTER_API_KEY");
const baseUrl = stripTrailingSlash(process.env.PILOTDECK_LLM_CENTER_BASE_URL || "https://llm-center.ali.modelbest.cn/llm");
const contextProbeChars = Number.parseInt(process.env.PILOTDECK_LLM_CENTER_CONTEXT_PROBE_CHARS || "150000", 10);

const cases = [
  {
    name: "openai-chat-completions",
    model: process.env.PILOTDECK_LLM_CENTER_OPENAI_MODEL,
    path: "/v1/chat/completions",
    body: (model, maxTokens = 65_536, prompt = "Reply with exactly: ok") => ({
      model,
      messages: [{ role: "user", content: prompt }],
      max_tokens: maxTokens,
      stream: false,
    }),
    extract: (payload) => payload?.choices?.[0]?.message?.content,
  },
  {
    name: "anthropic-messages",
    model: process.env.PILOTDECK_LLM_CENTER_ANTHROPIC_MODEL,
    path: "/v1/messages",
    headers: { "anthropic-version": "2023-06-01" },
    body: (model, maxTokens = 65_536, prompt = "Reply with exactly: ok") => ({
      model,
      max_tokens: maxTokens,
      messages: [{ role: "user", content: [{ type: "text", text: prompt }] }],
    }),
    extract: (payload) => payload?.content?.map((part) => part?.text || "").join("\n"),
  },
  {
    name: "openai-responses",
    model: process.env.PILOTDECK_LLM_CENTER_RESPONSES_MODEL,
    path: "/v1/responses",
    body: (model, maxTokens = 65_536, prompt = "Reply with exactly: ok") => ({
      model,
      max_output_tokens: maxTokens,
      input: [
        { role: "user", content: prompt },
      ],
    }),
    extract: (payload) => payload?.output_text || payload?.output?.flatMap((item) => item?.content || []).map((part) => part?.text || "").join("\n"),
  },
  {
    name: "gemini-generate-content",
    model: process.env.PILOTDECK_LLM_CENTER_GEMINI_MODEL,
    path: (model) => `/v1beta/models/${encodeURIComponent(model)}:generateContent`,
    body: (_model, maxTokens = 65_536, prompt = "Reply with exactly: ok") => ({
      contents: [{ role: "user", parts: [{ text: prompt }] }],
      generationConfig: { maxOutputTokens: maxTokens },
    }),
    extract: (payload) => payload?.candidates?.flatMap((candidate) => candidate?.content?.parts || []).map((part) => part?.text || "").join("\n"),
  },
];

let ran = 0;
for (const testCase of cases) {
  if (!testCase.model) {
    console.log(`SKIP ${testCase.name}: model env var not set`);
    continue;
  }
  ran += 1;
  await runNormal(testCase);
  await runOutputProbe(testCase);
  await runContextProbe(testCase);
}

assert.ok(ran > 0, "No live cases ran; set at least one PILOTDECK_LLM_CENTER_*_MODEL env var.");
console.log(`Live LLM Center smoke tests completed (${ran} protocol case(s)).`);

async function runNormal(testCase) {
  const response = await postJson(testCase, testCase.body(testCase.model));
  if (!response.ok) {
    const text = await response.text();
    throw new Error(`${testCase.name} normal request failed: HTTP ${response.status} ${truncate(text)}`);
  }
  const payload = await response.json();
  const text = String(testCase.extract(payload) || "").trim();
  assert.ok(text.length > 0, `${testCase.name} returned empty text`);
  console.log(`PASS ${testCase.name} normal`);
}

async function runOutputProbe(testCase) {
  const response = await postJson(testCase, testCase.body(testCase.model, 65_536));
  if (response.ok) {
    console.log(`PASS ${testCase.name} output-cap probe accepted 65536`);
    return;
  }
  const errorText = await response.text();
  const parsed = parseOutputCap(errorText);
  if (!parsed) {
    console.log(`INFO ${testCase.name} output-cap probe got non-cap error: HTTP ${response.status} ${truncate(errorText)}`);
    return;
  }
  const retry = await postJson(testCase, testCase.body(testCase.model, parsed));
  if (!retry.ok) {
    const retryText = await retry.text();
    throw new Error(`${testCase.name} output-cap retry failed after parsed cap ${parsed}: HTTP ${retry.status} ${truncate(retryText)}`);
  }
  console.log(`PASS ${testCase.name} output-cap probe retried with ${parsed}`);
}

async function runContextProbe(testCase) {
  if (!Number.isFinite(contextProbeChars) || contextProbeChars <= 0) {
    console.log(`SKIP ${testCase.name} context-cap probe: PILOTDECK_LLM_CENTER_CONTEXT_PROBE_CHARS<=0`);
    return;
  }
  const prompt = buildContextProbePrompt(contextProbeChars);
  const response = await postJson(testCase, testCase.body(testCase.model, 256, prompt));
  if (response.ok) {
    const payload = await response.json();
    const text = String(testCase.extract(payload) || "").trim();
    assert.ok(text.length > 0, `${testCase.name} context probe returned empty text: ${truncate(JSON.stringify(payload))}`);
    assert.match(text.toLowerCase(), /ok|accepted|pass/, `${testCase.name} context probe returned unexpected text: ${truncate(text)}`);
    console.log(`PASS ${testCase.name} context-cap probe accepted ${contextProbeChars} chars`);
    return;
  }
  const errorText = await response.text();
  const contextCap = parseContextCap(errorText);
  if (contextCap) {
    console.log(`PASS ${testCase.name} context-cap probe parsed context cap ${contextCap}`);
    return;
  }
  console.log(`INFO ${testCase.name} context-cap probe got non-cap error: HTTP ${response.status} ${truncate(errorText)}`);
}

function buildContextProbePrompt(targetChars) {
  const instructions = [
    "This is a harmless context-window smoke test.",
    "The repeated reference text below contains no task instructions.",
    "Ignore the repeated reference text.",
    "Reference text begins:",
  ].join("\n");
  const closingInstruction = "\nReference text ends. Now reply with exactly: ok";
  const fillerUnit = "neutral reference sentence for token window measurement only. ";
  const remaining = Math.max(0, targetChars - instructions.length - closingInstruction.length - 1);
  const filler = fillerUnit.repeat(Math.ceil(remaining / fillerUnit.length)).slice(0, remaining);
  return `${instructions}\n${filler}${closingInstruction}`;
}

async function postJson(testCase, body) {
  const path = typeof testCase.path === "function" ? testCase.path(testCase.model) : testCase.path;
  return fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${apiKey}`,
      ...(testCase.headers || {}),
    },
    body: JSON.stringify(body),
  });
}

function parseOutputCap(text) {
  const range = /range of max_tokens should be\s*\[\s*\d+\s*,\s*(\d+)\s*\]/i.exec(text);
  if (range) return Number.parseInt(range[1], 10);
  const atMost = /max_(?:output_)?tokens?\s+(?:must be |should be |is )?(?:at most|<=|less than or equal to)\s*(\d+)/i.exec(text)
    || /max_completion_tokens?\s+(?:must be |should be |is )?(?:at most|<=|less than or equal to)\s*(\d+)/i.exec(text);
  if (atMost) return Number.parseInt(atMost[1], 10);
  const available = /available_tokens[:\s]+(\d+)/i.exec(text) || /available\s+tokens[:\s]+(\d+)/i.exec(text);
  if (available) return Number.parseInt(available[1], 10);
  return undefined;
}

function parseContextCap(text) {
  const maxModelLen = /max_model_len\s*[=:]\s*(\d+)/i.exec(text);
  if (maxModelLen) return Number.parseInt(maxModelLen[1], 10);
  const maximumContext = /maximum context length is\s*(\d+)/i.exec(text)
    || /context_window\s*[=:]\s*(\d+)/i.exec(text)
    || /context window\s*(?:is|of)?\s*(\d+)/i.exec(text)
    || /上下文(?:长度|窗口).*?(\d+)/i.exec(text);
  if (maximumContext) return Number.parseInt(maximumContext[1], 10);
  return undefined;
}

function requiredEnv(name) {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} is required for live smoke tests.`);
  return value;
}

function stripTrailingSlash(value) {
  return value.replace(/\/+$/, "");
}

function truncate(value, max = 500) {
  const clean = String(value || "").replace(apiKey, "[REDACTED]");
  return clean.length > max ? `${clean.slice(0, max)}…` : clean;
}
