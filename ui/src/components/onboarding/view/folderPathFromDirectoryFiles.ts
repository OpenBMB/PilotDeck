type FileWithLocalPath = File & {
  path?: string;
};

const toPosix = (value: string) => value.replace(/\\/g, '/');

export function folderPathFromDirectoryFiles(files: File[]): string | null {
  const file = files[0] as FileWithLocalPath | undefined;
  if (!file) return null;

  const relative = toPosix(file.webkitRelativePath || file.name).replace(/^\/+/, '');
  const rootName = relative.split('/').filter(Boolean)[0];
  const absolute = typeof file.path === 'string' ? file.path.trim() : '';
  if (!absolute) {
    return rootName || null;
  }

  const absPosix = toPosix(absolute);
  const usesBackslash = absolute.includes('\\');
  const restore = (value: string) => (usesBackslash ? value.replace(/\//g, '\\') : value);

  if (rootName && (absPosix === rootName || absPosix.endsWith(`/${rootName}`))) {
    return restore(absPosix);
  }

  if (relative && absPosix.toLowerCase().endsWith(`/${relative.toLowerCase()}`)) {
    const folderPosix = absPosix.slice(0, absPosix.length - relative.length).replace(/\/+$/, '');
    const withRoot = rootName ? `${folderPosix}/${rootName}` : folderPosix;
    return restore(withRoot.replace(/\/{2,}/g, '/'));
  }

  return restore(absPosix.replace(/\/[^/]+$/, ''));
}
