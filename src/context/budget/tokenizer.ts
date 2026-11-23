import { createHash } from "node:crypto";
import { Tiktoken } from "js-tiktoken/lite";
import o200k_base from "js-tiktoken/ranks/o200k_base";

const TOKEN_CACHE_MAX_ENTRIES = 4096;
const SHORT_TEXT_KEY_LIMIT = 256;

let _instance: Tiktoken | null = null;
const _tokenCache = new Map<string, number>();

export function getTokenizer(): Tiktoken {
  if (!_instance) {
    _instance = new Tiktoken(o200k_base);
  }
  return _instance;
}

function cacheKeyFor(text: string): string {
  if (text.length <= SHORT_TEXT_KEY_LIMIT) {
    return text;
  }
  const digest = createHash("sha256").update(text).digest("base64url");
  return `${text.length}:${digest}`;
}

/**
 * Count the number of tokens in a text string using o200k_base encoding.
 * Treat special-token spellings in user text, history, and tool output as
 * ordinary text rather than rejecting them or counting them as control tokens.
 * Returns 0 for empty strings without invoking the tokenizer.
 */
export function countTokens(text: string): number {
  if (text.length === 0) return 0;
  const key = cacheKeyFor(text);
  const cached = _tokenCache.get(key);
  if (cached !== undefined) {
    // Refresh insertion order for LRU eviction.
    _tokenCache.delete(key);
    _tokenCache.set(key, cached);
    return cached;
  }
  const count = getTokenizer().encode(text, [], []).length;
  if (_tokenCache.size >= TOKEN_CACHE_MAX_ENTRIES) {
    const oldest = _tokenCache.keys().next().value;
    if (oldest !== undefined) {
      _tokenCache.delete(oldest);
    }
  }
  _tokenCache.set(key, count);
  return count;
}
