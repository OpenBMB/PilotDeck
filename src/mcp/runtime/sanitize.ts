/**
 * M9 — recursively strip "ambient" unicode characters (zero-width joiner,
 * BiDi overrides, RTL/LTR marks, BOM, replacement characters) from any
 * string that came from the network. Mirrors legacy
 * `recursivelySanitizeUnicode` (services/mcp/client.ts:1768).
 *
 * Why: an MCP server can advertise a tool name or description containing
 * RTL override characters that flip how a description renders in the
 * permission prompt — used in real-world phishing attacks. We strip the
 * dangerous code points; visible non-ASCII text (CJK, accents) is kept.
 */

const STRIPPED_CODE_POINTS = new Set<string>([
  "\u200B", // ZERO WIDTH SPACE
  "\u200C", // ZERO WIDTH NON-JOINER
  "\u200D", // ZERO WIDTH JOINER
  "\u200E", // LEFT-TO-RIGHT MARK
  "\u200F", // RIGHT-TO-LEFT MARK
  "\u202A", // LEFT-TO-RIGHT EMBEDDING
  "\u202B", // RIGHT-TO-LEFT EMBEDDING
  "\u202C", // POP DIRECTIONAL FORMATTING
  "\u202D", // LEFT-TO-RIGHT OVERRIDE
  "\u202E", // RIGHT-TO-LEFT OVERRIDE
  "\u2066", // LEFT-TO-RIGHT ISOLATE
  "\u2067", // RIGHT-TO-LEFT ISOLATE
  "\u2068", // FIRST STRONG ISOLATE
  "\u2069", // POP DIRECTIONAL ISOLATE
  "\uFEFF", // ZERO WIDTH NO-BREAK SPACE / BOM
  "\uFFFC", // OBJECT REPLACEMENT CHARACTER
  "\uFFFD", // REPLACEMENT CHARACTER
]);

export function sanitizeUnicodeString(s: string): string {
  if (s.length === 0) return s;
  let out = "";
  for (const ch of s) {
    if (STRIPPED_CODE_POINTS.has(ch)) continue;
    out += ch;
  }
  return out;
}

export function recursivelySanitizeUnicode<T>(value: T): T {
  if (typeof value === "string") {
    return sanitizeUnicodeString(value) as unknown as T;
  }
  if (Array.isArray(value)) {
    return value.map((v) => recursivelySanitizeUnicode(v)) as unknown as T;
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[sanitizeUnicodeString(k)] = recursivelySanitizeUnicode(v);
    }
    return out as unknown as T;
  }
  return value;
}
