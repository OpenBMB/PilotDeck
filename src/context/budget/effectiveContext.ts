export function effectiveInputContextTokens(maxContextTokens: number, maxOutputTokens?: number): number {
  if (!Number.isFinite(maxContextTokens) || maxContextTokens <= 0) return maxContextTokens;
  const output = typeof maxOutputTokens === "number" && Number.isFinite(maxOutputTokens) && maxOutputTokens > 0
    ? Math.floor(maxOutputTokens)
    : 0;
  const effective = Math.floor(maxContextTokens) - output;
  return Math.max(1, effective);
}
