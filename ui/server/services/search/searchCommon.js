import { createHash } from 'node:crypto';

export const SEARCH_KINDS = ['chats', 'files'];
export const EXCLUDED_DIRECTORIES = new Set(['.git', '.pilotdeck', 'node_modules', 'dist', 'build', 'coverage', '.next', '.venv', 'vendor']);
export const TEXT_FILES = /\.(?:md|markdown|txt|text|csv|tsv|json|jsonc|jsonl|ya?ml|toml|ini|conf|cfg|log|xml|html?|css|scss|less|[cm]?[jt]sx?|py|go|rs|java|kt|swift|c|h|cpp|hpp|cs|sh|bash|zsh|sql|vue|svelte|rb|php|r|tex|bib|svg)$/i;
export const INTERNAL_SESSION = /^always-on-(discovery|workspace|report)[:\-]/;
export const normalize = value => String(value || '').toLowerCase();
export const supportedText = name => TEXT_FILES.test(name) || /^(Dockerfile|Makefile|LICENSE|README|\.gitignore)$/i.test(name);
export const signature = info => [info.dev, info.ino, info.size, info.mtimeMs, info.ctimeMs].join(':');
export const digest = value => createHash('sha256').update(value).digest('hex');
export const stableId = (...parts) => digest(JSON.stringify(parts));

export function relevance(value, query) {
  const text = normalize(value);
  return text === query ? 100 : text.startsWith(query) ? 80 : text.includes(query) ? 60 : 0;
}

export function snippet(text, query) {
  const compact = String(text || '').replace(/\s+/g, ' ').trim();
  const at = Math.max(0, normalize(compact).indexOf(query));
  const start = Math.max(0, at - 55);
  const end = Math.min(compact.length, at + query.length + 100);
  return (start ? '…' : '') + compact.slice(start, end) + (end < compact.length ? '…' : '');
}

export function validateInput(input = {}) {
  const query = String(input.query || '').trim();
  if (!query || query.length > 256 || query.includes('\0')) {
    throw Object.assign(new Error('Query must contain 1–256 characters.'), { status: 400 });
  }
  return { ...input, query, kind: SEARCH_KINDS.includes(input.kind) ? input.kind : 'all',
    offset: Math.max(0, Math.floor(Number(input.offset) || 0)),
    limit: Math.min(100, Math.max(1, Math.floor(Number(input.limit) || 30))) };
}

export const emptyResults = () => ({ groups: { chats: [], files: [] }, counts: { chats: 0, files: 0 },
  hasMore: { chats: false, files: false }, partial: [] });

export function sortResults(items) {
  return items.sort((a, b) => b.score - a.score || Number(b.timestamp || 0) - Number(a.timestamp || 0) || a.id.localeCompare(b.id));
}

export function pageResults(result, input) {
  const output = { ...result, query: input.query, groups: {}, counts: {}, hasMore: {} };
  output.partial = (result.partial || []).filter(kind => input.kind === 'all' || input.kind === kind);
  for (const kind of SEARCH_KINDS) {
    const items = input.kind === 'all' || input.kind === kind ? result.groups[kind] || [] : [];
    output.groups[kind] = items.slice(input.offset, input.offset + input.limit);
    output.counts[kind] = items.length;
    output.hasMore[kind] = items.length > input.offset + input.limit;
  }
  return output;
}

export class ByteLru {
  constructor(maxBytes = 64 * 1024 * 1024, maxEntries = 128) {
    this.maxBytes = maxBytes; this.maxEntries = maxEntries; this.bytes = 0; this.entries = new Map();
  }
  get(key) {
    const entry = this.entries.get(key);
    if (!entry) return undefined;
    this.entries.delete(key); this.entries.set(key, entry);
    return entry.value;
  }
  set(key, value, bytes = Buffer.byteLength(JSON.stringify(value))) {
    this.delete(key);
    if (bytes > this.maxBytes) return;
    this.entries.set(key, { value, bytes }); this.bytes += bytes;
    while (this.bytes > this.maxBytes || this.entries.size > this.maxEntries) this.delete(this.entries.keys().next().value);
  }
  delete(key) {
    const item = this.entries.get(key);
    if (item) this.bytes -= item.bytes;
    this.entries.delete(key);
  }
  clear() { this.entries.clear(); this.bytes = 0; }
}

export async function mapConcurrent(items, callback, concurrency = 4) {
  let index = 0;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) await callback(items[index++]);
  }));
}

export function textChunks(text, size = 16384) {
  const chunks = [];
  let start = 0, line = 1, column = 1;
  while (start < text.length) {
    let end = Math.min(start + size, text.length);
    if (end < text.length && /[\uD800-\uDBFF]/.test(text[end - 1])) end--;
    chunks.push({ body: text.slice(start, end), offset: start, line, column });
    if (end === text.length) break;
    let next = end - 256;
    if (/[\uDC00-\uDFFF]/.test(text[next])) next--;
    const advance = text.slice(start, next);
    const lastNewline = advance.lastIndexOf('\n');
    line += advance.split('\n').length - 1;
    column = lastNewline < 0 ? column + advance.length : advance.length - lastNewline;
    start = next;
  }
  return chunks;
}
