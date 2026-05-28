/**
 * Lightweight provider connectivity tester for the onboarding window.
 *
 * Mirrors the three most critical checks from
 * ui/server/services/providerTester.js but runs inside the Electron main
 * process (before the PilotDeck ui/server starts). Keeps the same result
 * shape so the renderer can display identical UI.
 *
 * Checks performed:
 *   1. network   — HEAD request to baseUrl
 *   2. keyAuth   — POST max_tokens=1 "ping" to the resolved endpoint
 *   3. keyFormat — regex-based advisory hint
 */

const NETWORK_TIMEOUT_MS = 5000;
const API_TIMEOUT_MS = 8000;
const TRUNCATE_BYTES = 240;

export type CheckLevel = "ok" | "warning" | "error" | "skipped";
export interface Check {
  id: string;
  label: string;
  level: CheckLevel;
  detail: string;
  hint?: string;
  durationMs?: number;
}
export interface TestResult {
  endpoint: string;
  overall: CheckLevel;
  checks: Check[];
}

interface ProviderInput {
  type: string;
  baseUrl: string;
  apiKey: string;
  model: string;
}

function stripTrailingSlash(s: string): string {
  return s.replace(/\/+$/, "");
}

function truncate(text: string, max = TRUNCATE_BYTES): string {
  if (text.length <= max) return text;
  return `${text.slice(0, max)}…(+${text.length - max} bytes)`;
}

type EndpointMode = "anthropic" | "openai-chat" | "openai-responses" | "unknown";

function resolveEndpoint(p: ProviderInput): { url: string; mode: EndpointMode } {
  const baseUrl = stripTrailingSlash(p.baseUrl);
  if (!baseUrl) return { url: "", mode: "unknown" };
  const t = (p.type || "openai-chat").trim();
  switch (t) {
    case "anthropic":
      return { url: `${baseUrl}/v1/messages`, mode: "anthropic" };
    case "openai-responses":
      return { url: `${baseUrl}/responses`, mode: "openai-responses" };
    default:
      return { url: `${baseUrl}/chat/completions`, mode: "openai-chat" };
  }
}

function buildHeaders(p: ProviderInput, mode: EndpointMode): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (mode === "anthropic") {
    headers["x-api-key"] = p.apiKey;
    headers["anthropic-version"] = "2023-06-01";
  } else {
    headers["Authorization"] = `Bearer ${p.apiKey}`;
  }
  return headers;
}

function buildPingBody(mode: EndpointMode, modelName: string) {
  if (mode === "anthropic") {
    return { model: modelName, max_tokens: 1, messages: [{ role: "user", content: "ping" }] };
  }
  if (mode === "openai-responses") {
    return { model: modelName, max_output_tokens: 1, input: "ping" };
  }
  return { model: modelName, max_tokens: 1, messages: [{ role: "user", content: "ping" }] };
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

function classifyNetworkError(err: unknown): { detail: string; hint: string } {
  const e = err as { name?: string; message?: string; code?: string; cause?: { code?: string } };
  const code = e?.cause?.code || e?.code || "";
  if (e?.name === "AbortError")
    return { detail: `连接超时 (>${NETWORK_TIMEOUT_MS}ms)`, hint: "检查 baseUrl 是否可达，或网络是否需要代理。" };
  if (code === "ENOTFOUND")
    return { detail: `DNS 解析失败：${e.message}`, hint: "检查 baseUrl 域名拼写是否正确。" };
  if (code === "ECONNREFUSED")
    return { detail: `连接被拒绝：${e.message}`, hint: "上游服务可能未启动；本地网关请确认端口正确。" };
  if (code === "ECONNRESET")
    return { detail: `连接被重置：${e.message}`, hint: "可能是 TLS/HTTP 协议不匹配。" };
  return { detail: e?.message || String(err), hint: "" };
}

async function checkNetwork(p: ProviderInput): Promise<Check> {
  const start = Date.now();
  const baseUrl = stripTrailingSlash(p.baseUrl);
  if (!baseUrl) return { id: "network", label: "网络连接", level: "error", detail: "baseUrl 未配置", durationMs: 0 };
  try {
    const res = await fetchWithTimeout(baseUrl, { method: "HEAD" }, NETWORK_TIMEOUT_MS);
    return { id: "network", label: "网络连接", level: "ok", detail: `已连通 (HTTP ${res.status})`, durationMs: Date.now() - start };
  } catch (err) {
    const { detail, hint } = classifyNetworkError(err);
    return { id: "network", label: "网络连接", level: "error", detail, hint, durationMs: Date.now() - start };
  }
}

async function checkKeyAuth(p: ProviderInput): Promise<{ compat: Check; auth: Check }> {
  const start = Date.now();
  const { url, mode } = resolveEndpoint(p);
  if (!url) {
    return {
      compat: { id: "apiCompat", label: "API 兼容", level: "error", detail: "无法构造 endpoint（baseUrl 缺失）" },
      auth: { id: "keyAuth", label: "Key 验证", level: "skipped", detail: "前置检查未通过" },
    };
  }

  let res: Response, body: string, parsed: Record<string, unknown> | null;
  try {
    res = await fetchWithTimeout(url, {
      method: "POST",
      headers: buildHeaders(p, mode),
      body: JSON.stringify(buildPingBody(mode, p.model)),
    }, API_TIMEOUT_MS);
    body = await res.text();
    try { parsed = body ? JSON.parse(body) : null; } catch { parsed = null; }
  } catch (err) {
    const { detail, hint } = classifyNetworkError(err);
    return {
      compat: { id: "apiCompat", label: "API 兼容", level: "error", detail, hint, durationMs: Date.now() - start },
      auth: { id: "keyAuth", label: "Key 验证", level: "skipped", detail: "API 探测失败" },
    };
  }

  const status = res.status;
  const dur = Date.now() - start;
  const looksLikeLlm = parsed && (parsed.error || parsed.choices || parsed.content || parsed.id || parsed.object || parsed.model);

  let compat: Check;
  if (status >= 200 && status < 300) {
    compat = { id: "apiCompat", label: "API 兼容", level: "ok", detail: mode === "anthropic" ? "支持 Messages API" : `支持 ${mode}`, durationMs: dur };
  } else if (status === 401 || status === 403 || status === 429 || (status >= 400 && status < 500 && looksLikeLlm)) {
    compat = { id: "apiCompat", label: "API 兼容", level: "ok", detail: mode === "anthropic" ? "支持 Messages API" : `支持 ${mode}`, durationMs: dur };
  } else if (status === 404 || status === 405) {
    const hint = mode === "anthropic" && /\/v1$/.test(stripTrailingSlash(p.baseUrl))
      ? "Messages API 类型的 baseUrl 不需要带 /v1，会被自动追加。"
      : `检查协议类型是否匹配；当前按 ${mode} 调用 ${url}。`;
    compat = { id: "apiCompat", label: "API 兼容", level: "error", detail: `${status}：endpoint 不存在 — ${truncate(body)}`, hint, durationMs: dur };
  } else if (status >= 500) {
    compat = { id: "apiCompat", label: "API 兼容", level: "error", detail: `${status}：上游错误 — ${truncate(body)}`, hint: "可能是上游故障，稍后再试。", durationMs: dur };
  } else {
    compat = { id: "apiCompat", label: "API 兼容", level: "warning", detail: `HTTP ${status} — ${truncate(body)}`, durationMs: dur };
  }

  let auth: Check;
  if (status >= 200 && status < 300) {
    auth = { id: "keyAuth", label: "Key 验证", level: "ok", detail: "调用成功 (HTTP 200)" };
  } else if (status === 401) {
    const msg = (parsed?.error as Record<string, string>)?.message || (parsed?.message as string) || truncate(body, 120);
    auth = { id: "keyAuth", label: "Key 验证", level: "error", detail: `401 未授权：${msg}`, hint: "apiKey 无效或已过期。" };
  } else if (status === 403) {
    const msg = (parsed?.error as Record<string, string>)?.message || (parsed?.message as string) || truncate(body, 120);
    auth = { id: "keyAuth", label: "Key 验证", level: "error", detail: `403 禁止：${msg}`, hint: "账号无权限访问该模型，或 IP 被限制。" };
  } else if (status === 429) {
    auth = { id: "keyAuth", label: "Key 验证", level: "warning", detail: "429 限流（key 有效，已被限速）" };
  } else if (compat.level === "error") {
    auth = { id: "keyAuth", label: "Key 验证", level: "skipped", detail: "API 兼容性检查未通过" };
  } else {
    auth = { id: "keyAuth", label: "Key 验证", level: "warning", detail: `HTTP ${status} — ${truncate(body, 120)}` };
  }

  return { compat, auth };
}

function checkKeyFormat(apiKey: string): Check {
  const k = apiKey.trim();
  if (!k) return { id: "keyFormat", label: "Key 格式", level: "error", detail: "API key 缺失" };
  if (/^Bearer\s+/i.test(k))
    return { id: "keyFormat", label: "Key 格式", level: "warning", detail: "已包含 \"Bearer \" 前缀（建议去掉）", hint: "apiKey 只填裸 token，\"Bearer \" 前缀由系统自动添加。" };
  if (/^sk-ant-/i.test(k)) return { id: "keyFormat", label: "Key 格式", level: "ok", detail: "官方格式 (sk-ant-…)" };
  if (/^sk-proj-/i.test(k)) return { id: "keyFormat", label: "Key 格式", level: "ok", detail: "OpenAI 项目密钥 (sk-proj-…)" };
  if (/^sk-[A-Za-z0-9]{20,}$/.test(k)) return { id: "keyFormat", label: "Key 格式", level: "ok", detail: "OpenAI 或兼容格式 (sk-…)" };
  return { id: "keyFormat", label: "Key 格式", level: "ok", detail: "第三方格式" };
}

export async function testProviderOnboarding(p: ProviderInput): Promise<TestResult> {
  if (process.env.PILOTDECK_E2E_MOCK_PROVIDER === "1") {
    const { url } = resolveEndpoint(p);
    return {
      endpoint: url,
      overall: "ok",
      checks: [
        {
          id: "e2eMock",
          label: "E2E mock",
          level: "ok",
          detail: "PILOTDECK_E2E_MOCK_PROVIDER=1",
        },
      ],
    };
  }

  const { url } = resolveEndpoint(p);
  const network = await checkNetwork(p);

  let compat: Check;
  let auth: Check;
  if (network.level === "error") {
    compat = { id: "apiCompat", label: "API 兼容", level: "skipped", detail: "网络不通，跳过" };
    auth = { id: "keyAuth", label: "Key 验证", level: "skipped", detail: "网络不通，跳过" };
  } else {
    ({ compat, auth } = await checkKeyAuth(p));
  }

  const keyFormat = checkKeyFormat(p.apiKey);
  const checks = [network, compat, auth, keyFormat];

  let overall: CheckLevel = "ok";
  for (const c of checks) {
    if (c.level === "error") { overall = "error"; break; }
    if (c.level === "warning") overall = "warning";
  }

  return { endpoint: url, overall, checks };
}
