const TIER_TAG_PATTERN = /<tier>\s*([a-z0-9_-]+)\s*<\/tier>/i;

export function parseTier(judgeOutput: string, knownTiers: string[]): string | undefined {
  const cleaned = judgeOutput.replace(/```[a-z]*\n?/g, "").replace(/```/g, "").trim();

  const match = TIER_TAG_PATTERN.exec(cleaned);
  if (match) {
    const candidate = match[1];
    const found = knownTiers.find(t => t.toLowerCase() === candidate.toLowerCase());
    if (found) return found;
  }

  const exact = knownTiers.find(t => t.toLowerCase() === cleaned.toLowerCase());
  if (exact) return exact;

  // Longest tiers first: `-` is a word boundary, so a shorter tier that is a
  // word-prefix of a hyphenated tier (e.g. "fast" vs "fast-pro") would
  // otherwise match inside the longer name.
  const byLength = [...knownTiers].sort((a, b) => b.length - a.length);
  for (const tier of byLength) {
    const pattern = new RegExp(`\\b${escapeRegex(tier)}\\b`, "i");
    if (pattern.test(cleaned)) {
      return tier;
    }
  }

  return undefined;
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
