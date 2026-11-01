/**
 * Skills HTTP shim — translates the existing `/api/skills/*` REST
 * contract that `ui/src/components/main-content-v2/SkillsV2.tsx` was
 * built against into the gateway's `skill_*` RPCs. The gateway is the
 * authoritative skill manager (see `src/extension/skills/SkillManager.ts`)
 * backed by release-bundled skills, `~/.pilotdeck/skills/`, and
 * `<project>/.pilotdeck/skills/`,
 * so the UI and the agent always read from the same place.
 *
 * Supporting documents use gateway-resolved directories with confined local
 * reads. Two other operations remain file-based because they do not map to
 * a single gateway RPC:
 *
 *   - `/import-upload` — multipart browser folder picker. We stream the
 *     buffers into a staging dir next to the target skill root, then ask the gateway
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
import { moveDirectoryAcrossDevicesSafe } from '../utils/fileMoves.js';
import { prepareClawHubExecution } from '../utils/clawHubCli.js';

const execFileAsync = promisify(execFile);
async function execClawHub(args, options) {
  const execution = prepareClawHubExecution(args, options);
  return execFileAsync(execution.command, execution.args, execution.options);
}
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
// translation; the gateway resolves skill identities and their directories).
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

function resolveRequestedScope(scope, projectPath, { defaultToProjectWhenAvailable = false } = {}) {
  const generalCwd = isGeneralCwd(projectPath);
  const effectiveProjectPath = generalCwd ? null : projectPath || null;

  if (scope === 'builtin') {
    return { ok: false, error: 'built-in skills are read-only' };
  }

  if (scope === 'project') {
    if (generalCwd) {
      return { ok: true, scope: 'user', projectPath: null, wantProject: false };
    }
    if (!effectiveProjectPath) {
      return {
        ok: false,
        error: "project scope requires a real project (general chat doesn't qualify)",
      };
    }
    return { ok: true, scope: 'project', projectPath: effectiveProjectPath, wantProject: true };
  }

  if (scope === 'user') {
    return { ok: true, scope: 'user', projectPath: null, wantProject: false };
  }

  if (defaultToProjectWhenAvailable && effectiveProjectPath) {
    return { ok: true, scope: 'project', projectPath: effectiveProjectPath, wantProject: true };
  }

  return { ok: true, scope: 'user', projectPath: null, wantProject: false };
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

/** The gateway owns skill locations; clients identify skills by scope and slug. */
async function resolveSkillAddress(body = {}) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw Object.assign(new Error('A skill address is required.'), { code: 'invalid_input' });
  }
  const requestedProject = body.projectKey || body.projectPath;
  if (requestedProject && typeof requestedProject !== 'string') {
    throw Object.assign(new Error('Project path must be a string.'), { code: 'invalid_input' });
  }
  const projectKey = requestedProject && !isGeneralCwd(requestedProject) ? requestedProject : null;
  if (body.scope !== undefined || body.slug !== undefined) {
    if (!['builtin', 'user', 'project'].includes(body.scope) || !safeSlug(body.slug)) {
      throw Object.assign(new Error('A valid skill scope and slug are required.'), {
        code: 'invalid_input',
      });
    }
    if (body.scope === 'project' && !projectKey) {
      throw Object.assign(new Error('Project skills require a project.'), {
        code: 'project_required',
      });
    }
    return {
      scope: body.scope,
      slug: body.slug,
      projectKey: body.scope === 'project' ? projectKey : null,
    };
  }

  // Older clients send paths. Accept only exact entries in the authoritative list,
  // never infer a skill identity or trusted directory from an arbitrary basename.
  if (typeof body.skillPath !== 'string' || !body.skillPath) {
    throw Object.assign(new Error('A skill scope and slug, or skillPath, are required.'), {
      code: 'invalid_input',
    });
  }
  const requestedPath = path.resolve(body.skillPath);
  const data = await callGateway('skillsList', { projectKey });
  const skill = [...data.builtin, ...data.user, ...data.project].find(
    (item) =>
      requestedPath === path.resolve(item.skillDir) ||
      requestedPath === path.resolve(item.skillFile),
  );
  if (!skill || !safeSlug(skill.slug) || !['builtin', 'user', 'project'].includes(skill.scope)) {
    throw Object.assign(
      new Error('skillPath is not in the current gateway skills list. Refresh the list and retry.'),
      { code: 'invalid_input' },
    );
  }
  return {
    scope: skill.scope,
    slug: skill.slug,
    projectKey: skill.scope === 'project' ? projectKey : null,
  };
}

async function resolveSkillDirectory(body) {
  const address = await resolveSkillAddress(body);
  const { skill } = await callGateway('skillRead', address);
  if (!skill?.skillDir || skill.scope !== address.scope || skill.slug !== address.slug) {
    throw Object.assign(new Error('Skill directory could not be resolved by the gateway.'), {
      code: 'not_found',
    });
  }
  return skill.skillDir;
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
    case 'read_only':
      return res.status(403).json({ error: message, code });
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
    const { projectPath, projectKey, query, scope, cursor, limit } = req.body || {};
    const requestedProject = projectKey || projectPath;
    const generalCwd = isGeneralCwd(requestedProject);
    const effectiveProjectPath = generalCwd ? null : requestedProject || null;
    const data = await callGateway('skillsList', {
      projectKey: effectiveProjectPath,
      query,
      scope,
      cursor,
      limit,
    });
    res.json({
      builtin: data.builtin,
      user: data.user,
      project: data.project,
      projectPath: data.projectPath,
      isGeneralCwd: generalCwd,
      items: data.items,
      nextCursor: data.nextCursor,
    });
  } catch (e) {
    sendGatewayError(res, e);
  }
});

router.post('/read', async (req, res) => {
  try {
    const result = await callGateway('skillRead', await resolveSkillAddress(req.body));
    res.json(result);
  } catch (e) {
    sendGatewayError(res, e);
  }
});

// Supporting documents are confined to the selected skill, including symlink targets.
const DOCUMENT_EXTENSIONS = new Set(['.md', '.markdown', '.txt']);
const insideDirectory = (root, target) => {
  const relative = path.relative(root, target);
  return relative !== '..' && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
};
async function documentRoot(body) {
  return fs.realpath(await resolveSkillDirectory(body));
}
router.post('/documents', async (req, res) => {
  try {
    const root = await documentRoot(req.body);
    const files = [];
    let visited = 0;
    async function scan(dir, depth = 0) {
      if (depth > 6 || visited >= 2000 || files.length >= 200) return;
      for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
        if (++visited > 2000 || files.length >= 200) break;
        if (entry.name.startsWith('.')) continue;
        const file = path.join(dir, entry.name);
        if (entry.isDirectory()) await scan(file, depth + 1);
        else if (
          entry.isFile() &&
          DOCUMENT_EXTENSIONS.has(path.extname(entry.name).toLowerCase())
        ) {
          files.push(path.relative(root, file).split(path.sep).join('/'));
        }
      }
    }
    await scan(root);
    res.json({ files: files.sort() });
  } catch (e) {
    if (e.code === 'ENOENT') return res.status(404).json({ error: 'Skill document not found.' });
    sendGatewayError(res, e);
  }
});
router.post('/read-document', async (req, res) => {
  try {
    const { file } = req.body || {};
    const root = await documentRoot(req.body);
    if (
      typeof file !== 'string' ||
      !file ||
      file.includes('\0') ||
      path.isAbsolute(file) ||
      !DOCUMENT_EXTENSIONS.has(path.extname(file).toLowerCase())
    ) {
      return res.status(400).json({ error: 'A relative Markdown or text document is required.' });
    }
    const requested = path.resolve(root, file);
    if (!insideDirectory(root, requested))
      return res.status(403).json({ error: 'Document is outside this skill.' });
    const target = await fs.realpath(requested);
    if (!insideDirectory(root, target))
      return res.status(403).json({ error: 'Document is outside this skill.' });
    const stat = await fs.stat(target);
    if (!stat.isFile() || stat.size > 1024 * 1024)
      return res.status(413).json({ error: 'Document exceeds the 1 MB reading limit.' });
    const content = await fs.readFile(target, 'utf8');
    if (content.includes('\0'))
      return res.status(415).json({ error: 'Only text documents can be read.' });
    res.json({ file, content });
  } catch (e) {
    if (e.code === 'ENOENT') return res.status(404).json({ error: 'Skill document not found.' });
    sendGatewayError(res, e);
  }
});

router.post('/write', async (req, res) => {
  try {
    const { content } = req.body || {};
    if (typeof content !== 'string')
      return res.status(400).json({ error: 'content (string) is required' });
    const result = await callGateway('skillWrite', {
      ...(await resolveSkillAddress(req.body)),
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
    const resolved = resolveRequestedScope(scope, projectPath);
    if (!resolved.ok) return res.status(400).json({ error: resolved.error });
    const result = await callGateway('skillCreate', {
      scope: resolved.scope,
      slug,
      projectKey: resolved.wantProject ? resolved.projectPath : null,
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
    const result = await callGateway('skillDelete', await resolveSkillAddress(req.body));
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
    const { sourcePath, sourceSkill, slug, scope, projectPath, mode, force } = req.body || {};
    const resolved = resolveRequestedScope(scope, projectPath);
    if (!resolved.ok) return res.status(400).json({ error: resolved.error });
    const result = await callGateway('skillImport', {
      sourcePath: sourceSkill ? await resolveSkillDirectory(sourceSkill) : sourcePath,
      slug,
      scope: resolved.scope,
      projectKey: resolved.wantProject ? resolved.projectPath : null,
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

    const resolved = resolveRequestedScope(scope, projectPath);
    if (!resolved.ok) return res.status(400).json({ error: resolved.error });
    const root = resolved.wantProject ? projectSkillsRoot(resolved.projectPath) : userSkillsRoot();
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
          .json({
            error: `Skill already exists at ${targetDir}. Re-submit with force=true to overwrite.`,
          });
      }
    }

    await fs.mkdir(root, { recursive: true });
    stagingDir = await fs.mkdtemp(path.join(root, '.tmp-skill-upload-'));
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
    if (exists) await fs.rm(targetDir, { recursive: true, force: true });
    await moveDirectoryAcrossDevicesSafe(stagingDir, targetDir);
    stagingDir = null;

    // Round-trip through the gateway once more so the response shape
    // matches the rest of the API (skill summary populated, scope echoed).
    let skillSummary = null;
    try {
      const list = await callGateway('skillsList', {
        projectKey: resolved.wantProject ? resolved.projectPath : null,
      });
      const bucket = resolved.wantProject ? list.project : list.user;
      skillSummary = bucket.find((s) => s.slug === inferredSlug) ?? null;
    } catch {
      /* best-effort; the file is on disk regardless */
    }

    res.json({
      ok: true,
      mode: 'upload',
      scope: resolved.scope,
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
      const r = await execClawHub(args, { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 });
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
        const slug = parts[0]?.split(/\s+/)[0];
        const owner = parts[1]?.startsWith('@') ? parts[1].slice(1) : null;
        if (parts.length >= 4 && safeSlug(slug) && safeSlug(owner)) {
          results.push({ slug, owner, name: parts[2] || slug, score: null });
        } else if (parts.length >= 1 && safeSlug(parts[0])) {
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

router.post('/clawhub/inspect', async (req, res) => {
  const { slug, owner } = req.body || {};
  if (!safeSlug(slug) || (owner !== undefined && !safeSlug(owner)))
    return res.status(400).json({ error: 'Invalid skill identifier.' });
  try {
    const { stdout } = await execClawHub(
      ['--no-input', 'inspect', owner ? `@${owner}/${slug}` : slug, '--file', 'SKILL.md', '--json'],
      { timeout: 30_000, maxBuffer: 4 * 1024 * 1024 },
    );
    const data = JSON.parse(stdout.trim());
    if (typeof data.file?.content !== 'string')
      return res.status(404).json({ error: 'Skill instructions are unavailable.' });
    return res.json({
      content: data.file.content,
      version: data.version?.version || data.latestVersion?.version || null,
    });
  } catch (error) {
    return res
      .status(error.code === 'ENOENT' ? 503 : 502)
      .json({ error: 'Could not read skill instructions from ClawHub.' });
  }
});

// Import author-qualified packages into PilotDeck's flat skill namespace.
async function installPublishedSkill(req, res) {
  const { slug, owner, version, force, scope, projectPath } = req.body;
  if (!safeSlug(slug) || !safeSlug(owner))
    return res.status(400).json({ error: 'Invalid skill identifier.' });
  const localSlug = `${owner}--${slug}`;
  if (!safeSlug(localSlug)) return res.status(400).json({ error: 'Skill identifier is too long.' });
  const resolved = resolveRequestedScope(scope, projectPath, {
    defaultToProjectWhenAvailable: true,
  });
  if (!resolved.ok) return res.status(400).json({ error: resolved.error });
  const staging = await fs.mkdtemp(path.join(os.tmpdir(), 'pilotdeck-clawhub-'));
  try {
    const args = [
      '--no-input',
      '--workdir',
      staging,
      '--dir',
      'skills',
      'install',
      `@${owner}/${slug}`,
    ];
    if (version) args.push('--version', version);
    if (force) args.push('--force');
    let output;
    try {
      output = await execClawHub(args, { timeout: 120_000, maxBuffer: 10 * 1024 * 1024 });
    } catch (error) {
      const stdout = error.stdout || '';
      const stderr = error.stderr || '';
      return res.json({
        ok: false,
        installed: false,
        slug: localSlug,
        scope: resolved.scope,
        stdout,
        stderr,
        exitCode: error.code || 1,
        needsForce: !force && /Use --force to install suspicious/i.test(`${stderr}\n${stdout}`),
      });
    }
    const result = await callGateway('skillImport', {
      sourcePath: path.join(staging, 'skills', `@${owner}`, slug),
      slug: localSlug,
      scope: resolved.scope,
      projectKey: resolved.wantProject ? resolved.projectPath : null,
      mode: 'copy',
      force: false,
    });
    return res.json({
      ok: true,
      installed: true,
      slug: localSlug,
      scope: resolved.scope,
      skill: result.skill,
      installPath: result.skill?.skillDir,
      stdout: output.stdout || '',
      stderr: output.stderr || '',
      exitCode: 0,
      needsForce: false,
    });
  } catch (error) {
    return sendGatewayError(res, error);
  } finally {
    await fs.rm(staging, { recursive: true, force: true });
  }
}

router.post('/clawhub/install', async (req, res) => {
  try {
    if (req.body?.owner !== undefined) return await installPublishedSkill(req, res);
    const { slug, version, force, scope, projectPath, registry } = req.body || {};
    if (!safeSlug(slug)) {
      return res.status(400).json({ error: `Invalid slug "${slug}".` });
    }
    const resolved = resolveRequestedScope(scope, projectPath, {
      defaultToProjectWhenAvailable: true,
    });
    if (!resolved.ok) return res.status(400).json({ error: resolved.error });

    let workdir;
    let dir;
    if (resolved.wantProject) {
      workdir = resolved.projectPath;
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
      const r = await execClawHub(args, { timeout: 120_000, maxBuffer: 10 * 1024 * 1024 });
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
      const list = await callGateway('skillsList', {
        projectKey: resolved.wantProject ? resolved.projectPath : null,
      });
      const bucket = resolved.wantProject ? list.project : list.user;
      skill = bucket.find((s) => s.slug === slug) ?? null;
    } catch {
      /* not installed */
    }

    const needsForce =
      !installed &&
      !force &&
      (stderr || stdout).match(/Use --force to install suspicious/i) !== null;

    res.json({
      ok: installed,
      slug,
      scope: resolved.scope,
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
