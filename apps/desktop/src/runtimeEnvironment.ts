import path from 'node:path';

type BundledGit = { bash: string; git: string; pathEntries: string[] };

/** Electron's resources directory sits inside the tree replaced by upgrades. */
export function desktopInstallationRoot(resourcesPath: string, platform = process.platform): string {
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  return pathApi.resolve(resourcesPath, platform === 'darwin' ? '../..' : '..');
}

/** Environment for app-owned runtimes; explicit tool/MCP environments remain separate. */
export function withRuntimeCommandPath(
  env: NodeJS.ProcessEnv,
  runtimeRoot: string,
  nodeBinary: string,
  bundledGit?: BundledGit,
  { platform = process.platform, packaged = false }: { platform?: NodeJS.Platform; packaged?: boolean } = {},
): NodeJS.ProcessEnv {
  const nextEnv: NodeJS.ProcessEnv = {};
  const seen = new Set<string>();
  // Match Node's Windows selection rule, then remove duplicate spellings so
  // adding the bundled tools cannot leave a stale PATH winning over Path.
  for (const key of Object.keys(env).sort()) {
    if (env[key] === undefined) continue;
    const identity = platform === 'win32' ? key.toUpperCase() : key;
    if (seen.has(identity)) continue;
    seen.add(identity);
    if (packaged && ['NODE_OPTIONS', 'NODE_PATH', 'ELECTRON_RUN_AS_NODE'].includes(identity)) continue;
    nextEnv[key] = env[key];
  }
  const pathKey = platform === 'win32'
    ? Object.keys(nextEnv).find(key => key.toUpperCase() === 'PATH') ?? 'Path' : 'PATH';
  const pathApi = platform === 'win32' ? path.win32 : path.posix;
  nextEnv[pathKey] = [pathApi.dirname(nodeBinary), ...(bundledGit?.pathEntries ?? []),
    pathApi.join(runtimeRoot, 'node_modules', '.bin'), nextEnv[pathKey],
  ].filter(Boolean).join(pathApi.delimiter);
  if (bundledGit) {
    nextEnv.PILOTDECK_GIT_BASH_PATH = bundledGit.bash;
    nextEnv.PILOTDECK_GIT_PATH = bundledGit.git;
    nextEnv.CHERE_INVOKING ||= '1';
    nextEnv.MSYSTEM ||= 'MINGW64';
  }
  return nextEnv;
}
