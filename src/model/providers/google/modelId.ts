export function normalizeGoogleModelId(id: string): string {
  const trimmed = id.trim();
  const withoutProvider = trimmed.startsWith("google/") ? trimmed.slice("google/".length) : trimmed;

  if (withoutProvider === "gemini-4" || withoutProvider === "gemini-4-argon") {
    return "gemini-4-argon";
  }
  if (withoutProvider === "gemini-3-pro") {
    return "gemini-3-pro-preview";
  }
  if (withoutProvider === "gemini-3-flash") {
    return "gemini-3-flash-preview";
  }
  if (withoutProvider === "gemini-3.1-pro") {
    return "gemini-3.1-pro-preview";
  }
  if (withoutProvider === "gemini-3.1-flash" || withoutProvider === "gemini-3.1-flash-preview") {
    return "gemini-3-flash-preview";
  }

  return withoutProvider;
}
