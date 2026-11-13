import fs from 'fs';
import path from 'path';
import os from 'os';
import { spawn } from 'child_process';
import { fileURLToPath } from 'url';
import { prepareCliSpawn } from './processSpawn.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// User-installed plugins (git/marketplace). This is the only *writable* plugin
// root — installs and uninstalls target it.
const PLUGINS_DIR = path.join(os.homedir(), '.pilotdeck', 'plugins');
const PLUGINS_CONFIG_PATH = path.join(os.homedir(), '.pilotdeck', 'plugins.json');

// Plugins bundled with the runtime/product. `npm run build` copies
// `src/extension/plugins/builtin` into `dist/src/extension/plugins/builtin`,
// so a plugin folder dropped in the source tree ships with the packaged app.
// The same relative layout holds in dev, in `dist/`, and inside the desktop
// runtime (`resources/runtime/`), so one relative resolution covers all three.
const BUILTIN_PLUGINS_RELATIVE_PATH = ['src', 'extension', 'plugins', 'builtin'];

// UI page plugins bundled with the product. These live under `ui/plugins` —
// the frontend counterpart of the core builtin dir above, kept out of the
// server-side plugin tree. `npm run build` copies them to `dist/ui/plugins`.
const UI_PLUGINS_RELATIVE_PATH = ['plugins'];

const REQUIRED_MANIFEST_FIELDS = ['name', 'displayName', 'entry'];

/** Strip embedded credentials from a repo URL before exposing it to the client. */
function sanitizeRepoUrl(raw) {
  try {
    const u = new URL(raw);
    u.username = '';
    u.password = '';
    return u.toString().replace(/\/$/, '');
  } catch {
    // Not a parseable URL (e.g. SSH shorthand) — strip user:pass@ segment
    return raw.replace(/\/\/[^@/]+@/, '//');
  }
}
const ALLOWED_TYPES = ['react', 'module'];
const ALLOWED_SLOTS = ['tab'];

export function getPluginsDir() {
  if (!fs.existsSync(PLUGINS_DIR)) {
    fs.mkdirSync(PLUGINS_DIR, { recursive: true });
  }
  return PLUGINS_DIR;
}

/**
 * Locate the bundled builtin plugins directory, or null when none exists.
 *
 * An explicit runtime-root env wins; otherwise we resolve relative to this
 * module, which lands on `src/extension/plugins/builtin` in a repo checkout
 * and on `dist/src/extension/plugins/builtin` in a built/packaged runtime.
 */
export function resolveBuiltinPluginsDir(env = process.env) {
  const candidates = [];
  const runtimeRoot = env.PILOTDECK_RUNTIME_ROOT || env.PILOTDECK_DESKTOP_RUNTIME_ROOT;
  if (runtimeRoot) {
    candidates.push(path.join(runtimeRoot, 'dist', ...BUILTIN_PLUGINS_RELATIVE_PATH));
  }
  candidates.push(path.resolve(__dirname, '../../..', ...BUILTIN_PLUGINS_RELATIVE_PATH));

  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch { /* try next candidate */ }
  }
  return null;
}

/**
 * Locate the bundled UI page plugins directory (`ui/plugins`), or null.
 *
 * `npm run build` copies `ui/plugins` into `dist/ui/plugins`, and resolving
 * relative to this module (`ui/server/utils`) lands on the right place in dev,
 * in a built `dist/`, and inside the desktop runtime alike.
 */
export function resolveUiPluginsDir(env = process.env) {
  const candidates = [];
  const runtimeRoot = env.PILOTDECK_RUNTIME_ROOT || env.PILOTDECK_DESKTOP_RUNTIME_ROOT;
  if (runtimeRoot) {
    candidates.push(path.join(runtimeRoot, 'dist', 'ui', ...UI_PLUGINS_RELATIVE_PATH));
  }
  candidates.push(path.resolve(__dirname, '../..', ...UI_PLUGINS_RELATIVE_PATH));

  for (const candidate of candidates) {
    try {
      if (fs.statSync(candidate).isDirectory()) return candidate;
    } catch { /* try next candidate */ }
  }
  return null;
}

/**
 * Directories to scan for UI plugins, in precedence order (first match on a
 * plugin name wins). User-installed plugins override bundled ones, mirroring
 * the gateway's global-over-builtin resolution.
 */
export function getPluginSearchDirs() {
  const dirs = [{ dir: PLUGINS_DIR, source: 'global' }];
  const uiDir = resolveUiPluginsDir();
  if (uiDir) {
    dirs.push({ dir: uiDir, source: 'bundled' });
  }
  const builtinDir = resolveBuiltinPluginsDir();
  if (builtinDir) {
    dirs.push({ dir: builtinDir, source: 'builtin' });
  }
  return dirs;
}

export function getPluginsConfig() {
  try {
    if (fs.existsSync(PLUGINS_CONFIG_PATH)) {
      return JSON.parse(fs.readFileSync(PLUGINS_CONFIG_PATH, 'utf-8'));
    }
  } catch {
    // Corrupted config, start fresh
  }
  return {};
}

export function savePluginsConfig(config) {
  const dir = path.dirname(PLUGINS_CONFIG_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(PLUGINS_CONFIG_PATH, JSON.stringify(config, null, 2), { mode: 0o600 });
}

export function validateManifest(manifest) {
  if (!manifest || typeof manifest !== 'object') {
    return { valid: false, error: 'Manifest must be a JSON object' };
  }

  for (const field of REQUIRED_MANIFEST_FIELDS) {
    if (!manifest[field] || typeof manifest[field] !== 'string') {
      return { valid: false, error: `Missing or invalid required field: ${field}` };
    }
  }

  // Sanitize name — only allow alphanumeric, hyphens, underscores
  if (!/^[a-zA-Z0-9_-]+$/.test(manifest.name)) {
    return { valid: false, error: 'Plugin name must only contain letters, numbers, hyphens, and underscores' };
  }

  if (manifest.type && !ALLOWED_TYPES.includes(manifest.type)) {
    return { valid: false, error: `Invalid plugin type: ${manifest.type}. Must be one of: ${ALLOWED_TYPES.join(', ')}` };
  }

  if (manifest.slot && !ALLOWED_SLOTS.includes(manifest.slot)) {
    return { valid: false, error: `Invalid plugin slot: ${manifest.slot}. Must be one of: ${ALLOWED_SLOTS.join(', ')}` };
  }

  // Validate entry is a relative path without traversal
  if (manifest.entry.includes('..') || path.isAbsolute(manifest.entry)) {
    return { valid: false, error: 'Entry must be a relative path without ".."' };
  }

  if (manifest.server !== undefined && manifest.server !== null) {
    if (typeof manifest.server !== 'string' || manifest.server.includes('..') || path.isAbsolute(manifest.server)) {
      return { valid: false, error: 'Server entry must be a relative path string without ".."' };
    }
  }

  if (manifest.permissions !== undefined) {
    if (!Array.isArray(manifest.permissions) || !manifest.permissions.every(p => typeof p === 'string')) {
      return { valid: false, error: 'Permissions must be an array of strings' };
    }
  }

  return { valid: true };
}

const BUILD_TIMEOUT_MS = 60_000;

/** Run `npm run build` if the plugin's package.json declares a build script. */
function runBuildIfNeeded(dir, packageJsonPath, onSuccess, onError) {
  try {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, 'utf-8'));
    if (!pkg.scripts?.build) {
      return onSuccess();
    }
  } catch {
    return onSuccess(); // Unreadable package.json — skip build
  }

  const buildSpawn = prepareCliSpawn('npm', ['run', 'build'], {
    cwd: dir,
    stdio: ['ignore', 'pipe', 'pipe'],
    shell: true,
  });
  const buildProcess = spawn(buildSpawn.command, buildSpawn.args, buildSpawn.options);

  let stderr = '';
  let settled = false;

  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    buildProcess.removeAllListeners();
    buildProcess.kill();
    onError(new Error('npm run build timed out'));
  }, BUILD_TIMEOUT_MS);

  buildProcess.stderr.on('data', (data) => { stderr += data.toString(); });

  buildProcess.on('close', (code) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    if (code !== 0) {
      return onError(new Error(`npm run build failed (exit code ${code}): ${stderr.trim()}`));
    }
    onSuccess();
  });

  buildProcess.on('error', (err) => {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    onError(new Error(`Failed to spawn build: ${err.message}`));
  });
}

/**
 * Read a plugin's unified manifest: `manifest.json` (legacy UI format) wins,
 * otherwise `plugin.json` (DSH format) is mapped when it declares a `ui`
 * contribution. Returns null when the directory holds no renderable plugin.
 */
function readPluginManifest(dir) {
  const legacyPath = path.join(dir, 'manifest.json');
  if (fs.existsSync(legacyPath)) {
    try {
      return JSON.parse(fs.readFileSync(legacyPath, 'utf-8'));
    } catch (err) {
      console.warn(`[Plugins] Failed to parse manifest.json in ${dir}:`, err.message);
      return null;
    }
  }

  const dshPath = path.join(dir, 'plugin.json');
  if (!fs.existsSync(dshPath)) return null;

  try {
    const dshManifest = JSON.parse(fs.readFileSync(dshPath, 'utf-8'));
    // A DSH plugin without a ui contribution has no frontend page — skip it.
    if (!dshManifest.ui) return null;
    return {
      name: dshManifest.name,
      displayName: dshManifest.ui.displayName || dshManifest.name,
      version: dshManifest.version || '0.0.0',
      description: dshManifest.description || '',
      author: '',
      icon: dshManifest.ui.icon || 'Puzzle',
      type: 'module',
      slot: dshManifest.ui.slot || 'tab',
      entry: dshManifest.ui.entry,
      server: dshManifest.server || null,
      serverRoutes: Array.isArray(dshManifest.serverRoutes)
        ? dshManifest.serverRoutes.filter((r) => typeof r === 'string' && r.startsWith('/api/'))
        : [],
      permissions: [],
    };
  } catch (err) {
    console.warn(`[Plugins] Failed to parse plugin.json in ${dir}:`, err.message);
    return null;
  }
}

/** Read the plugin's git remote URL (drives the "update" affordance), if any. */
function readRepoUrl(dir) {
  try {
    const gitConfigPath = path.join(dir, '.git', 'config');
    if (!fs.existsSync(gitConfigPath)) return null;
    const match = fs.readFileSync(gitConfigPath, 'utf-8').match(/url\s*=\s*(.+)/);
    if (!match) return null;
    let repoUrl = match[1].trim().replace(/\.git$/, '');
    // Convert SSH URLs to HTTPS
    if (repoUrl.startsWith('git@')) {
      repoUrl = repoUrl.replace(/^git@([^:]+):/, 'https://$1/');
    }
    // Strip embedded credentials (e.g. https://user:pass@host/...)
    return sanitizeRepoUrl(repoUrl);
  } catch {
    return null;
  }
}

export function scanPlugins() {
  const config = getPluginsConfig();
  const plugins = [];
  const seenNames = new Set();

  for (const { dir: searchDir, source } of getPluginSearchDirs()) {
    let entries;
    try {
      entries = fs.readdirSync(searchDir, { withFileTypes: true });
    } catch {
      // Missing/unreadable directory — this source contributes nothing.
      continue;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      // Skip transient temp directories from in-progress installs
      if (entry.name.startsWith('.tmp-')) continue;

      const dir = path.join(searchDir, entry.name);
      const manifest = readPluginManifest(dir);
      if (!manifest) continue;

      const validation = validateManifest(manifest);
      if (!validation.valid) {
        console.warn(`[Plugins] Skipping ${entry.name} (${source}): ${validation.error}`);
        continue;
      }

      // Skip duplicate manifest names — the first source to claim a name wins,
      // so user-installed plugins override bundled ones.
      if (seenNames.has(manifest.name)) {
        console.warn(`[Plugins] Skipping ${entry.name} (${source}): duplicate plugin name "${manifest.name}"`);
        continue;
      }
      seenNames.add(manifest.name);

      plugins.push({
        name: manifest.name,
        displayName: manifest.displayName,
        version: manifest.version || '0.0.0',
        description: manifest.description || '',
        author: manifest.author || '',
        icon: manifest.icon || 'Puzzle',
        type: manifest.type || 'module',
        slot: manifest.slot || 'tab',
        entry: manifest.entry,
        server: manifest.server || null,
        serverRoutes: Array.isArray(manifest.serverRoutes) ? manifest.serverRoutes : [],
        permissions: manifest.permissions || [],
        enabled: config[manifest.name]?.enabled !== false, // enabled by default
        dirName: entry.name,
        dir,
        source,
        repoUrl: readRepoUrl(dir),
      });
    }
  }

  return plugins;
}

export function getPluginDir(name) {
  const plugin = scanPlugins().find(p => p.name === name);
  return plugin ? plugin.dir : null;
}

export function resolvePluginAssetPath(name, assetPath) {
  const pluginDir = getPluginDir(name);
  if (!pluginDir) return null;

  const resolved = path.resolve(pluginDir, assetPath);

  // Prevent path traversal — canonicalize via realpath to defeat symlink bypasses
  if (!fs.existsSync(resolved)) return null;

  const realResolved = fs.realpathSync(resolved);
  const realPluginDir = fs.realpathSync(pluginDir);
  if (!realResolved.startsWith(realPluginDir + path.sep) && realResolved !== realPluginDir) {
    return null;
  }

  return realResolved;
}

export function installPluginFromGit(url) {
  return new Promise((resolve, reject) => {
    if (typeof url !== 'string' || !url.trim()) {
      return reject(new Error('Invalid URL: must be a non-empty string'));
    }
    if (url.startsWith('-')) {
      return reject(new Error('Invalid URL: must not start with "-"'));
    }

    // Extract repo name from URL for directory name
    const urlClean = url.replace(/\.git$/, '').replace(/\/$/, '');
    const repoName = urlClean.split('/').pop();

    if (!repoName || !/^[a-zA-Z0-9_.-]+$/.test(repoName)) {
      return reject(new Error('Could not determine a valid directory name from the URL'));
    }

    const pluginsDir = getPluginsDir();
    const targetDir = path.resolve(pluginsDir, repoName);

    // Ensure the resolved target directory stays within the plugins directory
    if (!targetDir.startsWith(pluginsDir + path.sep)) {
      return reject(new Error('Invalid plugin directory path'));
    }

    if (fs.existsSync(targetDir)) {
      return reject(new Error(`Plugin directory "${repoName}" already exists`));
    }

    // Clone into a temp directory so scanPlugins() never sees a partially-installed plugin
    const tempDir = fs.mkdtempSync(path.join(pluginsDir, `.tmp-${repoName}-`));

    const cleanupTemp = () => {
      try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}
    };

    const finalize = (manifest) => {
      try {
        fs.renameSync(tempDir, targetDir);
      } catch (err) {
        cleanupTemp();
        return reject(new Error(`Failed to move plugin into place: ${err.message}`));
      }
      resolve(manifest);
    };

    const gitProcess = spawn('git', ['clone', '--depth', '1', '--', url, tempDir], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: process.platform === 'win32',
    });

    let stderr = '';
    gitProcess.stderr.on('data', (data) => { stderr += data.toString(); });

    gitProcess.on('close', (code) => {
      if (code !== 0) {
        cleanupTemp();
        return reject(new Error(`git clone failed (exit code ${code}): ${stderr.trim()}`));
      }

      // Validate manifest exists
      const manifestPath = path.join(tempDir, 'manifest.json');
      if (!fs.existsSync(manifestPath)) {
        cleanupTemp();
        return reject(new Error('Cloned repository does not contain a manifest.json'));
      }

      let manifest;
      try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      } catch {
        cleanupTemp();
        return reject(new Error('manifest.json is not valid JSON'));
      }

      const validation = validateManifest(manifest);
      if (!validation.valid) {
        cleanupTemp();
        return reject(new Error(`Invalid manifest: ${validation.error}`));
      }

      // Reject if another installed plugin already uses this name
      const existing = scanPlugins().find(p => p.name === manifest.name);
      if (existing) {
        cleanupTemp();
        return reject(new Error(`A plugin named "${manifest.name}" is already installed (in "${existing.dirName}")`));
      }

      // Run npm install if package.json exists.
      // --ignore-scripts prevents postinstall hooks from executing arbitrary code.
      const packageJsonPath = path.join(tempDir, 'package.json');
      if (fs.existsSync(packageJsonPath)) {
        const npmSpawn = prepareCliSpawn('npm', ['install', '--ignore-scripts'], {
          cwd: tempDir,
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: true,
        });
        const npmProcess = spawn(npmSpawn.command, npmSpawn.args, npmSpawn.options);

        npmProcess.on('close', (npmCode) => {
          if (npmCode !== 0) {
            cleanupTemp();
            return reject(new Error(`npm install for ${repoName} failed (exit code ${npmCode})`));
          }
          runBuildIfNeeded(tempDir, packageJsonPath, () => finalize(manifest), (err) => { cleanupTemp(); reject(err); });
        });

        npmProcess.on('error', (err) => {
          cleanupTemp();
          reject(err);
        });
      } else {
        finalize(manifest);
      }
    });

    gitProcess.on('error', (err) => {
      cleanupTemp();
      reject(new Error(`Failed to spawn git: ${err.message}`));
    });
  });
}

export function updatePluginFromGit(name) {
  return new Promise((resolve, reject) => {
    const plugin = scanPlugins().find(p => p.name === name);
    if (!plugin) {
      return reject(new Error(`Plugin "${name}" not found`));
    }
    if (plugin.source !== 'global') {
      return reject(new Error(`Plugin "${name}" is bundled with the app (source: ${plugin.source}) and cannot be updated from git`));
    }
    const pluginDir = plugin.dir;

    // Only fast-forward to avoid silent divergence
    const gitProcess = spawn('git', ['pull', '--ff-only', '--'], {
      cwd: pluginDir,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: process.platform === 'win32',
    });

    let stderr = '';
    gitProcess.stderr.on('data', (data) => { stderr += data.toString(); });

    gitProcess.on('close', (code) => {
      if (code !== 0) {
        return reject(new Error(`git pull failed (exit code ${code}): ${stderr.trim()}`));
      }

      // Re-validate manifest after update
      const manifestPath = path.join(pluginDir, 'manifest.json');
      let manifest;
      try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      } catch {
        return reject(new Error('manifest.json is not valid JSON after update'));
      }

      const validation = validateManifest(manifest);
      if (!validation.valid) {
        return reject(new Error(`Invalid manifest after update: ${validation.error}`));
      }

      // Re-run npm install if package.json exists
      const packageJsonPath = path.join(pluginDir, 'package.json');
      if (fs.existsSync(packageJsonPath)) {
        const npmSpawn = prepareCliSpawn('npm', ['install', '--ignore-scripts'], {
          cwd: pluginDir,
          stdio: ['ignore', 'pipe', 'pipe'],
          shell: true,
        });
        const npmProcess = spawn(npmSpawn.command, npmSpawn.args, npmSpawn.options);
        npmProcess.on('close', (npmCode) => {
          if (npmCode !== 0) {
            return reject(new Error(`npm install for ${name} failed (exit code ${npmCode})`));
          }
          runBuildIfNeeded(pluginDir, packageJsonPath, () => resolve(manifest), (err) => reject(err));
        });
        npmProcess.on('error', (err) => reject(err));
      } else {
        resolve(manifest);
      }
    });

    gitProcess.on('error', (err) => {
      reject(new Error(`Failed to spawn git: ${err.message}`));
    });
  });
}

export async function uninstallPlugin(name) {
  const plugin = scanPlugins().find(p => p.name === name);
  if (!plugin) {
    throw new Error(`Plugin "${name}" not found`);
  }
  if (plugin.source !== 'global') {
    throw new Error(`Plugin "${name}" is bundled with the app (source: ${plugin.source}) and cannot be uninstalled`);
  }
  const pluginDir = plugin.dir;

  // On Windows, file handles may be released slightly after process exit.
  // Retry a few times with a short delay before giving up.
  const MAX_RETRIES = 5;
  const RETRY_DELAY_MS = 500;
  for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
    try {
      fs.rmSync(pluginDir, { recursive: true, force: true });
      break;
    } catch (err) {
      if (err.code === 'EBUSY' && attempt < MAX_RETRIES) {
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS));
      } else {
        throw err;
      }
    }
  }

  // Remove from config
  const config = getPluginsConfig();
  delete config[name];
  savePluginsConfig(config);
}
