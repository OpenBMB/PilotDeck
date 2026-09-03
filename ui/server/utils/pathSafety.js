import path from 'path';

export function isPathInsideOrEqual(rootPath, candidatePath, pathApi = path) {
  const root = pathApi.resolve(rootPath);
  const candidate = pathApi.resolve(candidatePath);
  const relative = pathApi.relative(root, candidate);
  return (
    relative === '' ||
    (
      relative !== '..' &&
      !relative.startsWith(`..${pathApi.sep}`) &&
      !pathApi.isAbsolute(relative)
    )
  );
}

export function normalizePathForComparison(value, pathApi = path, platform = process.platform) {
  const normalized = pathApi.normalize(pathApi.resolve(value));
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
}
