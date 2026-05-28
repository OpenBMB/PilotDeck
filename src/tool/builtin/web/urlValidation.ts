/**
 * URL hygiene helpers for `web_fetch` (mirrors §5.2 W1, W2, W3, W7).
 */

/** W1: max URL length permitted. Legacy parity = 2000. */
export const MAX_URL_LENGTH = 2000;

/**
 * W2: validate that the URL is well-formed, has no embedded credentials,
 * and resolves to a publicly-routable hostname (multi-part DNS name).
 */
export function validateURL(url: string): boolean {
  if (url.length > MAX_URL_LENGTH) return false;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }

  if (parsed.username || parsed.password) return false;

  const parts = parsed.hostname.split(".").filter((p) => p.length > 0);
  if (parts.length < 2) return false;

  return true;
}

/**
 * W3: upgrade `http://` to `https://`. Returns the upgraded URL string and
 * the parsed URL for reuse.
 */
export function upgradeHttpToHttps(url: string): { upgraded: string; parsed: URL } {
  const parsed = new URL(url);
  if (parsed.protocol === "http:") {
    parsed.protocol = "https:";
  }
  return { upgraded: parsed.toString(), parsed };
}

/**
 * W7: a redirect is "permitted" when:
 *   - protocol matches,
 *   - port matches,
 *   - destination has no embedded credentials,
 *   - hostname differs only in the optional `www.` prefix (or matches
 *     exactly).
 *
 * This is checked *before* following the redirect; if it fails, the caller
 * should surface the redirect target to the user (one-shot redirect info)
 * rather than auto-following.
 */
export function isPermittedRedirect(originalUrl: string, redirectUrl: string): boolean {
  let original: URL;
  let redirect: URL;
  try {
    original = new URL(originalUrl);
    redirect = new URL(redirectUrl);
  } catch {
    return false;
  }
  if (redirect.protocol !== original.protocol) return false;
  if (redirect.port !== original.port) return false;
  if (redirect.username || redirect.password) return false;

  const stripWww = (h: string) => h.replace(/^www\./, "");
  return stripWww(original.hostname) === stripWww(redirect.hostname);
}
