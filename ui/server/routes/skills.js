/**
 * Skills HTTP shim — translates the existing `/api/skills/*` REST
 * contract that `ui/src/components/main-content-v2/SkillsV2.tsx` was
 * built against into the gateway's `skill_*` RPCs. The gateway is the
 * authoritative skill manager (see `src/extension/skills/SkillManager.ts`)
 * backed by `~/.pilotdeck/skills/` and `<project>/.pilotdeck/skills/`,
 * so the UI and the agent always read from the same place.
 *
 * Two endpoints stay file-based for now because they don't map cleanly
 * onto a single gateway RPC:
 *
 *   - `/import-upload` — multipart browser folder picker. We stream the
 *     buffers into the project skill dir directly, then ask the gateway
 *     to refresh its in-memory caches via a follow-up `skill_validate`
 *     call to compute the validation result. A future revision can lift
 *     this onto a gateway RPC that accepts base64 chunks.
 *
 *   - `/clawhub/*` — shells out to the `clawhub` CLI which writes its
 *     output to disk by itself. We just retarget the install root to
 *     `~/.pilotdeck/skills/` so installs end up where the agent looks.
 *
 * Anything else (list/read/write/create/delete/import/validate/scan) is
 * a one-line forward to the gateway. Errors raised by `SkillManagerError`
 * arrive as `{ code, message }` and we map their `code` to a sensible
 * HTTP status; everything else falls through as 500.
 */

import express from 'express';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import { execFile } from 'child_process';
import { promisify } from 'util';
import multer from 'multer';
import { getPilotDeckGateway } from '../pilotdeck-bridge.js';
import { resolvePilotHome } from '../utils/pilotPaths.js';

const execFileAsync = promisify(execFile);
const router = express.Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 10 * 1024 * 1024,
    files: 500,
    fields: 20,
  },
});

// ---------------------------------------------------------------------------
// Path / scope helpers (small surface area kept in the bridge for protocol
// translation; the SkillManager owns the same logic internally for direct
// gateway callers, but the UI sends absolute `skillPath` so we need to
// classify it before forwarding `(scope, slug)`).
// ---------------------------------------------------------------------------

const SLUG_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/;
const PILOT_HOME = resolvePilotHome(process.env);
const PROJECT_DIR = '.pilotdeck';
const SKILLS_SUBDIR = 'skills';

function safeSlug(slug) {
  return typeof slug === 'string' && SLUG_RE.test(slug) && !slug.includes('..');
}

const GENERAL_CWD_PATHS = [path.resolve(PILOT_HOME)];

function isGeneralCwd(projectPath) {
  if (!projectPath) return false;
  return GENERAL_CWD_PATHS.includes(path.resolve(projectPath));
}

function userSkillsRoot() {
  return path.join(PILOT_HOME, SKILLS_SUBDIR);
}

function projectSkillsRoot(projectPath) {
  return path.join(projectPath, PROJECT_DIR, SKILLS_SUBDIR);
}

function expandHome(p) {
  if (typeof p !== 'string' || !p) return p;
  if (p === '~') return os.homedir();
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * Translate an absolute `skillPath` (used by the UI for stable
 * addressing across the read/write/delete cycle) into the
 * `(scope, slug)` pair the gateway expects. Refuses anything outside
 * the user or active project skill roots so a malformed UI request
 * cannot cajole the gateway into touching arbitrary paths.
 */
function classifySkillPath(skillPath, projectPath = null) {
  if (typeof skillPath !== 'string' || !skillPath) {
    return { ok: false, reason: 'skillPath is required' };
  }
  const abs = path.resolve(skillPath);
  if (abs.includes('..')) {
    return { ok: false, reason: 'skillPath contains ".."' };
  }

  const candidates = [{ root: userSkillsRoot(), scope: 'user' }];
  if (projectPath && !isGeneralCwd(projectPath)) {
    candidates.push({ root: projectSkillsRoot(projectPath), scope: 'project' });
  }
  for (const { root, scope } of candidates) {
    const rootResolved = path.resolve(root);
    if (abs === rootResolved) {
      return { ok: false, reason: 'skillPath is the skills root, not a skill' };
    }
    const rel = path.relative(rootResolved, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) continue;
    const segments = rel.split(path.sep).filter(Boolean);
    if (segments.length === 0) continue;
    const slug = segments[0];
    if (!safeSlug(slug)) {
      return { ok: false, reason: `Invalid slug "${slug}"` };
    }
    return { ok: true, scope, slug };
  }
  return { ok: false, reason: 'skillPath is not inside any known skills root' };
}

/**
 * Convert a gateway error (from a `SkillManagerError` on the other side
 * of the WS bridge) into an HTTP status + payload. The gateway sends
 * structured `{ code, message, validation? }` errors when the failure
 * originated in the skill manager; everything else surfaces as 500.
 */
function sendGatewayError(res, err) {
  const code = err?.code;
  const message = err?.message || (err instanceof Error ? err.message : String(err));
  switch (code) {
    case 'not_configured':
      return res.status(503).json({ error: message, code });
    case 'invalid_input':
    case 'invalid_slug':
    case 'project_required':
    case 'self_import':
      return res.status(400).json({ error: message, code });
    case 'not_found':
    case 'source_missing':
    case 'source_not_directory':
    case 'no_skill_md':
      return res.status(404).json({ error: message, code });
    case 'conflict':
      return res.status(409).json({ error: message, code });
    case 'validation_failed':
      return res.status(422).json({ error: message, code, validation: err.validation });
    default:
      console.error('[skills-bridge]', err);
      return res.status(500).json({ error: message, code: code || 'gateway_request_failed' });
  }
}

/**
 * Wrapper that calls a gateway RPC and normalises errors. The remote
 * gateway raises `GatewayRequestError` instances (see
 * `src/gateway/client/GatewayWsClient.ts`) which carry the structured
 * `code` from `SkillManagerError` plus an optional `validation`
 * payload — we let them propagate as-is so `sendGatewayError` can map
 * the code to an HTTP status. Transport-level failures (WS closed,
 * timeout) surface as plain `Error` and route to the 500 fallback.
 */
async function callGateway(method, params) {
  const gw = await getPilotDeckGateway();
  return gw[method](params);
}

// ---------------------------------------------------------------------------
// Core CRUD — every endpoint forwards to the gateway
// ---------------------------------------------------------------------------

router.post('/list', async (req, res) => {
  try {
    const { projectPath } = req.body || {};
    const generalCwd = isGeneralCwd(projectPath);
    const effectiveProjectPath = generalCwd ? null : projectPath || null;
    const data = await callGateway('skillsList', { projectKey: effectiveProjectPath });
    res.json({
      user: data.user,
      project: data.project,
      projectPath: data.projectPath,
      isGeneralCwd: generalCwd,
    });
  } catch (e) {
    sendGatewayError(res, e);
  }
});

router.post('/read', async (req, res) => {
  try {
    const { skillPath, projectPath } = req.body || {};
    const cls = classifySkillPath(skillPath, projectPath);
    if (!cls.ok) return res.status(400).json({ error: cls.reason });
    const result = await callGateway('skillRead', {
      scope: cls.scope,
      slug: cls.slug,
      projectKey: cls.scope === 'project' ? projectPath : null,
    });
    res.json(result);
  } catch (e) {
    sendGatewayError(res, e);
  }
});

router.post('/write', async (req, res) => {
  try {
    const { skillPath, content, projectPath } = req.body || {};
    if (typeof content !== 'string') {
      return res.status(400).json({ error: 'content (string) is required' });
    }
    const cls = classifySkillPath(skillPath, projectPath);
    if (!cls.ok) return res.status(400).json({ error: cls.reason });
    const result = await callGateway('skillWrite', {
      scope: cls.scope,
      slug: cls.slug,
      projectKey: cls.scope === 'project' ? projectPath : null,
      content,
    });
    res.json(result);
  } catch (e) {
    sendGatewayError(res, e);
  }
});

router.post('/create', async (req, res) => {
  try {
    const { scope, projectPath, slug, name, description, body, content } = req.body || {};
    const wantProject = scope === 'project';
    if (wantProject && (!projectPath || isGeneralCwd(projectPath))) {
      return res.status(400).json({
        error: "project scope requires a real project (general chat doesn't qualify)",
      });
    }
    const result = await callGateway('skillCreate', {
      scope: wantProject ? 'project' : 'user',
      slug,
      projectKey: wantProject ? projectPath : null,
      name,
      description,
      body,
      content,
    });
    res.json(result);
  } catch (e) {
    sendGatewayError(res, e);
  }
});

router.post('/delete', async (req, res) => {
  try {
    const { skillPath, projectPath } = req.body || {};
    const cls = classifySkillPath(skillPath, projectPath);
    if (!cls.ok) return res.status(400).json({ error: cls.reason });
    const result = await callGateway('skillDelete', {
      scope: cls.scope,
      slug: cls.slug,
      projectKey: cls.scope === 'project' ? projectPath : null,
    });
    res.json(result);
  } catch (e) {
    sendGatewayError(res, e);
  }
});

router.post('/validate', async (req, res) => {
  try {
    const { sourcePath, skillMdContent, files } = req.body || {};
    const result = await callGateway(
      'skillValidate',
      sourcePath ? { sourcePath } : { skillMdContent, files },
    );
    res.json(result);
  } catch (e) {
    sendGatewayError(res, e);
  }
});

router.post('/import', async (req, res) => {
  try {
    const { sourcePath, slug, scope, projectPath, mode, force } = req.body || {};
    const wantProject = scope === 'project';
    if (wantProject && (!projectPath || isGeneralCwd(projectPath))) {
      return res.status(400).json({
        error: "project scope requires a real project (general chat doesn't qualify)",
      });
    }
    const result = await callGateway('skillImport', {
      sourcePath,
      slug,
      scope: wantProject ? 'project' : 'user',
      projectKey: wantProject ? projectPath : null,
      mode,
      force,
    });
    res.json(result);
  } catch (e) {
    sendGatewayError(res, e);
  }
});

router.post('/scan', async (req, res) => {
  try {
    const { parentPath } = req.body || {};
    const result = await callGateway('skillScan', { parentPath });
    res.json(result);
  } catch (e) {
    sendGatewayError(res, e);
  }
});

// ---------------------------------------------------------------------------
// /import-upload — multipart picker upload. Multipart bodies don't fit the
// WS RPC, so we stage on disk and then ask the gateway to validate. The
// final move lands in `~/.pilotdeck/skills/<slug>` or
// `<project>/.pilotdeck/skills/<slug>` so the agent picks it up on next
// session refresh.
// ---------------------------------------------------------------------------

router.post('/import-upload', upload.array('files', 500), async (req, res) => {
  let stagingDir = null;
  try {
    const { slug: requestedSlug, scope, projectPath, force, paths: pathsJson } = req.body || {};
    let paths;
    try {
      paths = JSON.parse(pathsJson || '[]');
    } catch {
      return res
        .status(400)
        .json({ error: '`paths` must be a JSON array of relative paths matching the file order.' });
    }
    const filesIn = Array.isArray(req.files) ? req.files : [];
    if (filesIn.length === 0) return res.status(400).json({ error: 'No files were uploaded.' });
    if (filesIn.length !== paths.length) {
      return res.status(400).json({
        error: `paths length (${paths.length}) does not match files count (${filesIn.length}).`,
      });
    }

    const manifest = filesIn.map((f, i) => ({
      relativePath: paths[i],
      size: f.size,
      buffer: f.buffer,
    }));

    let skillMdContent = '';
    for (const m of manifest) {
      if (m.relativePath === 'SKILL.md') {
        skillMdContent = m.buffer.toString('utf8');
        break;
      }
    }
    const validation = await callGateway('skillValidate', {
      skillMdContent,
      files: manifest.map((m) => ({ relativePath: m.relativePath, size: m.size })),
    });
    if (!validation.ok) {
      return res.status(422).json({ error: 'Validation failed', validation });
    }

    const wantProject = scope === 'project';
    if (wantProject && (!projectPath || isGeneralCwd(projectPath))) {
      return res
        .status(400)
        .json({ error: "project scope requires a real project (general chat doesn't qualify)." });
    }
    const root = wantProject ? projectSkillsRoot(projectPath) : userSkillsRoot();
    const inferredSlug =
      (typeof requestedSlug === 'string' && requestedSlug.trim()) ||
      (paths[0] && paths[0].split('/')[0]) ||
      '';
    if (!safeSlug(inferredSlug)) {
      return res.status(400).json({
        error: `Invalid slug "${inferredSlug}". Allowed: [a-zA-Z0-9][a-zA-Z0-9._-]{0,99}, no "..".`,
      });
    }
    const targetDir = path.join(root, inferredSlug);

    const stripPrefix = (() => {
      const first = paths[0]?.split('/')?.[0];
      if (!first) return null;
      return paths.every((p) => p.split('/')[0] === first) ? first + '/' : null;
    })();

    let exists = false;
    try {
      await fs.access(targetDir);
      exists = true;
    } catch {
      /* missing → fine */
    }
    if (exists) {
      const isForce = force === 'true' || force === true;
      if (!isForce) {
        return res
          .status(409)
          .json({ error: `Skill already exists at ${targetDir}. Re-submit with force=true to overwrite.` });
      }
    }

    stagingDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-upload-'));
    for (const m of manifest) {
      const rel =
        stripPrefix && m.relativePath.startsWith(stripPrefix)
          ? m.relativePath.slice(stripPrefix.length)
          : m.relativePath;
      if (rel.includes('..') || path.isAbsolute(rel)) continue;
      const out = path.join(stagingDir, rel);
      await fs.mkdir(path.dirname(out), { recursive: true });
      await fs.writeFile(out, m.buffer);
    }
    await fs.mkdir(root, { recursive: true });
    if (exists) await fs.rm(targetDir, { recursive: true, force: true });
    await fs.rename(stagingDir, targetDir);
    stagingDir = null;

    // Round-trip through the gateway once more so the response shape
    // matches the rest of the API (skill summary populated, scope echoed).
    let skillSummary = null;
    try {
      const list = await callGateway('skillsList', {
        projectKey: wantProject ? projectPath : null,
      });
      const bucket = wantProject ? list.project : list.user;
      skillSummary = bucket.find((s) => s.slug === inferredSlug) ?? null;
    } catch {
      /* best-effort; the file is on disk regardless */
    }

    res.json({
      ok: true,
      mode: 'upload',
      scope: wantProject ? 'project' : 'user',
      slug: inferredSlug,
      skillPath: targetDir,
      skill: skillSummary,
      validation,
    });
  } catch (e) {
    if (stagingDir) {
      try {
        await fs.rm(stagingDir, { recursive: true, force: true });
      } catch {
        /* best-effort */
      }
    }
    sendGatewayError(res, e);
  }
});

// ---------------------------------------------------------------------------
// ClawHub passthrough — kept here because the binary writes to disk and
// reading it back into the gateway would just add a layer.  We retarget
// the install root to `~/.pilotdeck/skills/` (or `<project>/.pilotdeck/
// skills/`) so installed skills end up where the agent looks.
// ---------------------------------------------------------------------------

router.post('/clawhub/search', async (req, res) => {
  try {
    const { query, registry } = req.body || {};
    if (typeof query !== 'string' || query.trim().length === 0) {
      return res.json({ results: [] });
    }
    const args = ['--no-input'];
    if (registry) args.push('--registry', registry);
    args.push('search', query.trim());

    let stdout = '';
    try {
      const r = await execFileAsync('clawhub', args, { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
      stdout = r.stdout || '';
    } catch (e) {
      if (e.code === 'ENOENT') {
        return res
          .status(503)
          .json({ error: 'clawhub CLI not found in PATH. Install with `npm install -g clawhub`.' });
      }
      stdout = e.stdout || '';
      if (!stdout) {
        return res.status(500).json({ error: 'clawhub search failed', message: e.message });
      }
    }

    // eslint-disable-next-line no-control-regex
    const ANSI = /\x1b\[[0-9;]*m/g;
    const results = [];
    for (const rawLine of stdout.split('\n')) {
      const line = rawLine.replace(ANSI, '').trim();
      if (!line) continue;
      if (line.startsWith('-') || line.toLowerCase().startsWith('searching')) continue;
      const m = line.match(/^(\S+)\s+(.+?)\s+\(([\d.]+)\)\s*$/);
      if (m) {
        results.push({ slug: m[1], name: m[2], score: parseFloat(m[3]) });
      } else {
        const parts = line.split(/\s{2,}/);
        if (parts.length >= 1 && safeSlug(parts[0])) {
          results.push({ slug: parts[0], name: parts[1] || parts[0], score: null });
        }
      }
    }
    res.json({ results });
  } catch (e) {
    console.error('[skills/clawhub/search]', e);
    res.status(500).json({ error: 'Search failed', message: e.message });
  }
});

router.post('/clawhub/install', async (req, res) => {
  try {
    const { slug, version, force, scope, projectPath, registry } = req.body || {};
    if (!safeSlug(slug)) {
      return res.status(400).json({ error: `Invalid slug "${slug}".` });
    }
    const generalCwd = isGeneralCwd(projectPath);
    const effectiveProjectPath = generalCwd ? null : projectPath || null;
    const resolvedScope =
      scope === 'project' || scope === 'user' ? scope : effectiveProjectPath ? 'project' : 'user';

    let workdir;
    let dir;
    if (resolvedScope === 'project') {
      if (!effectiveProjectPath) {
        return res.status(400).json({ error: 'project scope requires a real project context' });
      }
      workdir = effectiveProjectPath;
      dir = path.join(PROJECT_DIR, SKILLS_SUBDIR);
    } else {
      workdir = PILOT_HOME;
      dir = SKILLS_SUBDIR;
    }
    const installPath = path.join(workdir, dir, slug);

    const args = ['--no-input', '--workdir', workdir, '--dir', dir];
    if (registry) args.push('--registry', registry);
    args.push('install', slug);
    if (version) args.push('--version', version);
    if (force) args.push('--force');

    let stdout = '';
    let stderr = '';
    let runError = null;
    try {
      const r = await execFileAsync('clawhub', args, { timeout: 120_000, maxBuffer: 10 * 1024 * 1024 });
      stdout = r.stdout || '';
      stderr = r.stderr || '';
    } catch (e) {
      if (e.code === 'ENOENT') {
        return res
          .status(503)
          .json({ error: 'clawhub CLI not found in PATH. Install with `npm install -g clawhub`.' });
      }
      runError = e;
      stdout = e.stdout || '';
      stderr = e.stderr || '';
    }

    let installed = false;
    let skill = null;
    try {
      await fs.access(path.join(installPath, 'SKILL.md'));
      installed = true;
      // Pull the summary back through the gateway so descriptions reflect
      // the same frontmatter parser the agent will use.
      const list = await callGateway('skillsList', { projectKey: effectiveProjectPath });
      const bucket = resolvedScope === 'project' ? list.project : list.user;
      skill = bucket.find((s) => s.slug === slug) ?? null;
    } catch {
      /* not installed */
    }

    const needsForce =
      !installed && !force && (stderr || stdout).match(/Use --force to install suspicious/i) !== null;

    res.json({
      ok: installed,
      slug,
      scope: resolvedScope,
      installPath,
      installed,
      skill,
      stdout: stdout.trim(),
      stderr: stderr.trim(),
      exitCode: runError ? (runError.code === undefined ? 1 : runError.code) : 0,
      needsForce,
    });
  } catch (e) {
    console.error('[skills/clawhub/install]', e);
    res.status(500).json({ error: 'Install failed', message: e.message });
  }
});

export default router;
