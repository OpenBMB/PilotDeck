export type ToolNameRepairResult = {
  name: string;
  reason: "alias" | "case_insensitive" | "normalized" | "edit_distance";
};

export function repairToolName(
  name: string,
  validNames: Iterable<string>,
  aliases: Record<string, string> = {},
): ToolNameRepairResult | undefined {
  const raw = name.trim();
  if (raw.length === 0) return undefined;

  const valid = [...validNames];
  if (valid.includes(raw)) return undefined;

  const aliasTarget = aliases[raw] ?? aliases[raw.toLowerCase()];
  if (aliasTarget && valid.includes(aliasTarget)) {
    return { name: aliasTarget, reason: "alias" };
  }

  const lower = raw.toLowerCase();
  const caseMatch = valid.find((candidate) => candidate.toLowerCase() === lower);
  if (caseMatch) {
    return { name: caseMatch, reason: "case_insensitive" };
  }

  const normalized = normalizeToolName(raw);
  const normalizedMatch = valid.find((candidate) => normalizeToolName(candidate) === normalized);
  if (normalizedMatch) {
    return { name: normalizedMatch, reason: "normalized" };
  }

  const best = bestEditDistanceMatch(raw, valid);
  if (best && best.distance <= maxSafeEditDistance(raw, best.name)) {
    return { name: best.name, reason: "edit_distance" };
  }

  return undefined;
}

function normalizeToolName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function maxSafeEditDistance(a: string, b: string): number {
  const shortest = Math.min(a.length, b.length);
  if (shortest < 5) return 0;
  if (shortest < 9) return 1;
  return 2;
}

function bestEditDistanceMatch(
  raw: string,
  valid: string[],
): { name: string; distance: number } | undefined {
  let best: { name: string; distance: number } | undefined;
  for (const candidate of valid) {
    const distance = levenshtein(raw.toLowerCase(), candidate.toLowerCase());
    if (!best || distance < best.distance) {
      best = { name: candidate, distance };
    } else if (best && distance === best.distance) {
      best = undefined;
    }
  }
  return best;
}

function levenshtein(a: string, b: string): number {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  const current = Array.from({ length: b.length + 1 }, () => 0);

  for (let i = 1; i <= a.length; i++) {
    current[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const substitution = previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1);
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, substitution);
    }
    for (let j = 0; j <= b.length; j++) {
      previous[j] = current[j];
    }
  }

  return previous[b.length] ?? Number.POSITIVE_INFINITY;
}
