import fs from 'node:fs/promises';
import path from 'node:path';

function normalizeText(value, caseSensitive = false) {
  const normalized = String(value ?? '')
    .normalize('NFKC')
    .replace(/\s+/g, ' ')
    .trim();
  return caseSensitive ? normalized : normalized.toLocaleLowerCase();
}

function matchesTerm(haystack, needle) {
  if (!/^[+-]?(?:\d+(?:\.\d+)?|\.\d+)%?$/.test(needle)) return haystack.includes(needle);
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?:^|[^0-9.])${escaped}(?:$|[^0-9.])`).test(haystack);
}

async function loadRequirements(source) {
  if (!source) return null;
  if (typeof source === 'object') return source;
  const file = path.resolve(source);
  return JSON.parse(await fs.readFile(file, 'utf8'));
}

function selectedSlides(manifest, selector) {
  if (selector === undefined || selector === null) return manifest.slides;
  const wanted = new Set((Array.isArray(selector) ? selector : [selector]).map(Number));
  return manifest.slides.filter((slide) => wanted.has(slide.number));
}

function termGroups(requirement) {
  const raw = requirement.terms ?? requirement.expected;
  if (!Array.isArray(raw) || !raw.length) {
    throw new Error(`Requirement ${requirement.id || '<unnamed>'} must provide a non-empty terms array`);
  }
  return raw.map((term) => {
    const aliases = Array.isArray(term) ? term : [term];
    if (!aliases.length || aliases.some((alias) => typeof alias !== 'string' || !alias.trim())) {
      throw new Error(`Requirement ${requirement.id || '<unnamed>'} contains an invalid term or alias group`);
    }
    return aliases;
  });
}

export async function evaluateRequirements(manifest, source) {
  const specification = await loadRequirements(source);
  if (!specification) {
    return {
      status: 'not_requested',
      source: null,
      counts: { total: 0, matched: 0, missingCritical: 0, missingRecommended: 0 },
      items: [],
      errors: [],
      warnings: [],
    };
  }
  if (!Array.isArray(specification.requirements)) {
    throw new Error('Requirements file must contain a requirements array');
  }

  const ids = new Set();
  const structuralItems = [];
  if (specification.slideCount !== undefined) {
    const expected = Number(specification.slideCount);
    if (!Number.isInteger(expected) || expected < 1) throw new Error('Requirements slideCount must be a positive integer');
    ids.add('slide-count');
    structuralItems.push({
      id: 'slide-count',
      label: `Exact slide count: ${expected}`,
      priority: 'critical',
      slides: manifest.slides.map((slide) => slide.number),
      mode: 'exact',
      minimum: expected,
      matchedCount: manifest.slideCount,
      matched: manifest.slideCount === expected,
      matches: [{ expected, actual: manifest.slideCount, matched: manifest.slideCount === expected }],
      missing: manifest.slideCount === expected ? [] : [`expected ${expected}, found ${manifest.slideCount}`],
    });
  }
  const textItems = specification.requirements.map((requirement, index) => {
    const id = String(requirement.id ?? `requirement-${index + 1}`).trim();
    if (!id) throw new Error(`Requirement at index ${index} has an empty id`);
    if (ids.has(id)) throw new Error(`Duplicate requirement id: ${id}`);
    ids.add(id);
    const priority = requirement.priority === 'critical' ? 'critical' : 'recommended';
    const caseSensitive = Boolean(requirement.caseSensitive);
    const groups = termGroups(requirement);
    const slides = selectedSlides(manifest, requirement.slide ?? requirement.slides);
    const haystack = normalizeText(slides.map((slide) => slide.text).join(' '), caseSensitive);
    const matches = groups.map((aliases) => {
      const normalized = aliases.map((alias) => normalizeText(alias, caseSensitive));
      const matchedAlias = normalized.find((alias) => matchesTerm(haystack, alias));
      return { aliases, matched: Boolean(matchedAlias), matchedAlias: matchedAlias || null };
    });
    const mode = requirement.match === 'any' ? 'any' : 'all';
    const defaultMinimum = mode === 'any' ? 1 : matches.length;
    const minimum = Number.isFinite(Number(requirement.minMatches))
      ? Math.max(1, Math.min(matches.length, Number(requirement.minMatches)))
      : defaultMinimum;
    const matchedCount = matches.filter((item) => item.matched).length;
    const matched = matchedCount >= minimum;
    return {
      id,
      label: requirement.label || id,
      priority,
      slides: slides.map((slide) => slide.number),
      mode,
      minimum,
      matchedCount,
      matched,
      matches,
      missing: matches.filter((item) => !item.matched).map((item) => item.aliases),
    };
  });
  const items = [...structuralItems, ...textItems];

  const errors = items
    .filter((item) => !item.matched && item.priority === 'critical')
    .map((item) => ({
      code: 'missing_requirement',
      requirement: item.id,
      label: item.label,
      missing: item.missing,
      message: `Critical requirement ${item.label} was not found in the extracted slide text`,
    }));
  const warnings = items
    .filter((item) => !item.matched && item.priority !== 'critical')
    .map((item) => ({
      code: 'missing_recommended_requirement',
      requirement: item.id,
      label: item.label,
      missing: item.missing,
      message: `Recommended requirement ${item.label} was not found in the extracted slide text`,
    }));

  return {
    // Coverage is a hard gate for critical requirements. Recommended misses
    // remain audit warnings so they can be fixed or explicitly dispositioned
    // without making the coverage result itself ambiguous.
    status: errors.length ? 'failed' : 'passed',
    source: typeof source === 'string' ? path.resolve(source) : 'inline',
    counts: {
      total: items.length,
      matched: items.filter((item) => item.matched).length,
      missingCritical: errors.length,
      missingRecommended: warnings.length,
    },
    items,
    errors,
    warnings,
  };
}
