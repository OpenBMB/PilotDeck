import type { CatalogModel } from './catalogProviders';

/** Rank exact, prefix and word matches before subsequence matches. */
export function searchCatalogModels(models: CatalogModel[], query: string): CatalogModel[] {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return models;
  return models.map((model, index) => {
    const text = `${model.id} ${model.displayName} ${(model.aliases ?? []).join(' ')}`.toLocaleLowerCase();
    let score = 0;
    for (const word of words) {
      const position = text.indexOf(word);
      if (position >= 0) { score += position; continue; }
      let cursor = -1;
      for (const char of word) {
        cursor = text.indexOf(char, cursor + 1);
        if (cursor < 0) return { model, score: Infinity, index };
      }
      score += 1000 + cursor;
    }
    return { model, score, index };
  }).filter(item => Number.isFinite(item.score)).sort((a, b) => a.score - b.score || a.index - b.index).map(item => item.model);
}
