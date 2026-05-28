export function matchHookMatcher(matcher: string | undefined, query: string | undefined): boolean {
  if (!matcher || matcher === "*") {
    return true;
  }
  if (!query) {
    return false;
  }

  const alternatives = matcher.split("|").map((part) => part.trim()).filter(Boolean);
  if (alternatives.length > 1) {
    return alternatives.some((alternative) => matchHookMatcher(alternative, query));
  }

  if (matcher.startsWith("/") && matcher.endsWith("/") && matcher.length > 2) {
    try {
      return new RegExp(matcher.slice(1, -1)).test(query);
    } catch {
      return false;
    }
  }

  return matcher === query;
}
