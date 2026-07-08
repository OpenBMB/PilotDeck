/** File extensions we treat as openable project files when linked from markdown. */
const OPENABLE_FILE_EXTENSION = /\.[a-z0-9]{1,10}$/i;

const looksLikeProjectFilePath = (path: string): boolean => {
  const normalized = path.replace(/\\/g, '/').replace(/^\/+/, '');
  if (!normalized || normalized.includes('..')) return false;
  return OPENABLE_FILE_EXTENSION.test(normalized);
};

const decodePath = (value: string): string => {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
};

const resolveRelativeToFile = (href: string, baseFilePath: string): string => {
  const baseDir = baseFilePath.replace(/\\/g, '/').split('/').slice(0, -1);
  const parts = href.replace(/\\/g, '/').split('/');
  const resolved = [...baseDir];
  for (const part of parts) {
    if (!part || part === '.') continue;
    if (part === '..') {
      resolved.pop();
      continue;
    }
    resolved.push(part);
  }
  return resolved.join('/');
};

const resolveProjectPathFromPathname = (pathname: string): string | null => {
  const normalizedPathname = pathname.replace(/\\/g, '/');

  // Assistant sometimes emits /session/<filename.md> even though /session is
  // reserved for conversation ids.
  const sessionPrefix = '/session/';
  if (normalizedPathname.startsWith(sessionPrefix)) {
    const filePath = normalizedPathname.slice(sessionPrefix.length);
    if (looksLikeProjectFilePath(filePath)) return filePath;
  }

  // Optional deep-link shape: /p/:project/f/:encoded/path
  const projectFileMatch = normalizedPathname.match(/^\/p\/[^/]+\/f\/(.+)$/);
  if (projectFileMatch) {
    const filePath = decodePath(projectFileMatch[1]);
    if (looksLikeProjectFilePath(filePath)) return filePath;
  }

  const rootRelativePath = normalizedPathname.replace(/^\/+/, '');
  return looksLikeProjectFilePath(rootRelativePath) ? rootRelativePath : null;
};

/**
 * Returns a project-relative file path when `href` points at a local workspace
 * file. Handles common assistant-generated shapes such as
 * `http://localhost:5173/session/report.md` (misrouted session URL) and plain
 * relative paths like `docs/report.md`.
 */
export function resolveMarkdownFileHref(
  href: string | undefined | null,
  options?: { origin?: string; baseFilePath?: string },
): string | null {
  if (!href) return null;

  const trimmed = href.trim();
  if (!trimmed || trimmed.startsWith('#')) return null;

  const hasProtocol = /^([a-z][a-z0-9+.-]*:|\/\/)/i.test(trimmed);

  if (/^file:\/\//i.test(trimmed)) {
    try {
      const url = new URL(trimmed);
      return decodePath(url.pathname) || null;
    } catch {
      return null;
    }
  }

  if (trimmed.startsWith('/')) {
    return resolveProjectPathFromPathname(decodePath(trimmed));
  }

  // Relative paths (no protocol).
  if (!hasProtocol) {
    const decoded = decodePath(trimmed);
    const normalized = decoded.replace(/^\.\//, '').replace(/^\/+/, '');
    const candidate = options?.baseFilePath && !decoded.startsWith('/')
      ? resolveRelativeToFile(normalized, options.baseFilePath)
      : normalized;
    return looksLikeProjectFilePath(candidate) ? candidate : null;
  }

  try {
    const origin =
      options?.origin ?? (typeof window !== 'undefined' ? window.location.origin : '');
    const url = new URL(trimmed, origin || undefined);
    if (origin && url.origin !== origin) return null;

    const pathname = decodePath(url.pathname);
    return resolveProjectPathFromPathname(pathname);
  } catch {
    return null;
  }
}
