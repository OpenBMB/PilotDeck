export type CodexJwtClaims = Record<string, unknown> & {
  exp?: number;
  email?: string;
  "https://api.openai.com/auth"?: {
    chatgpt_account_id?: string;
    chatgpt_plan_type?: string;
  };
};

export function decodeCodexJwtClaims(token: unknown): CodexJwtClaims {
  if (typeof token !== "string" || !token.trim()) return {};
  const parts = token.split(".");
  if (parts.length < 2 || !parts[1]) return {};
  try {
    const value = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return isRecord(value) ? value as CodexJwtClaims : {};
  } catch {
    return {};
  }
}

export function extractChatGptAccountId(token: unknown): string | undefined {
  const auth = decodeCodexJwtClaims(token)["https://api.openai.com/auth"];
  const accountId = isRecord(auth) ? auth.chatgpt_account_id : undefined;
  return typeof accountId === "string" && accountId.trim()
    ? accountId.trim()
    : undefined;
}

export function codexAccessTokenExpiresAt(token: unknown): number | undefined {
  const exp = decodeCodexJwtClaims(token).exp;
  return typeof exp === "number" && Number.isFinite(exp) ? exp * 1000 : undefined;
}

export function isCodexAccessTokenExpiring(
  token: unknown,
  skewMs = 0,
  now = Date.now(),
): boolean {
  const expiresAt = codexAccessTokenExpiresAt(token);
  return expiresAt === undefined || expiresAt <= now + Math.max(0, skewMs);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
