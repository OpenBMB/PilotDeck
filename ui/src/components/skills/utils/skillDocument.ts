import { parse, parseDocument } from 'yaml';

const FRONTMATTER = /^\uFEFF?---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/;

/** Extract metadata for display without changing the source saved by the editor. */
export function splitSkillDocument(content: string): {
  body: string;
  metadata: Record<string, unknown>;
} {
  const match = content.match(FRONTMATTER);
  if (!match) return { body: content, metadata: {} };
  try {
    const metadata: unknown = parse(match[1]);
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata))
      return { body: content, metadata: {} };
    return { body: content.slice(match[0].length), metadata: metadata as Record<string, unknown> };
  } catch {
    // Invalid metadata remains visible; it must never disappear from the preview.
    return { body: content, metadata: {} };
  }
}

export function canEditSkillForm(content: string): boolean {
  const match = content.match(FRONTMATTER);
  if (!match) return !/^\uFEFF?---[ \t]*\r?\n/.test(content);
  try {
    const document = parseDocument(match[1]);
    const metadata: unknown = document.toJSON();
    return (
      document.errors.length === 0 &&
      Boolean(metadata) &&
      typeof metadata === 'object' &&
      !Array.isArray(metadata)
    );
  } catch {
    return false;
  }
}

/** YAML's document model retains comments, unknown fields and scalar styles. */
export function updateSkillDocument(
  content: string,
  patch: { name?: string; description?: string; body?: string },
): string {
  if (!canEditSkillForm(content)) throw new Error('Invalid metadata; use the source editor.');
  const match = content.match(FRONTMATTER);
  const current = splitSkillDocument(content);
  const metadataChanged =
    (patch.name !== undefined && patch.name !== current.metadata.name) ||
    (patch.description !== undefined && patch.description !== current.metadata.description);
  if (!metadataChanged) return (match?.[0] ?? '') + (patch.body ?? current.body);
  const document = parseDocument(match?.[1] ?? '{}');
  if (patch.name !== undefined) document.set('name', patch.name);
  if (patch.description !== undefined) document.set('description', patch.description);
  const newline = content.includes('\r\n') ? '\r\n' : '\n';
  const yaml = document.toString().trimEnd().replace(/\r?\n/g, newline);
  return `${content.startsWith('\uFEFF') ? '\uFEFF' : ''}---${newline}${yaml}${newline}---${newline}${patch.body ?? current.body}`;
}
