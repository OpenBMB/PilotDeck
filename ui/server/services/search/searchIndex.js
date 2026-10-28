import { execFile } from 'node:child_process';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { readdir, readFile, open, stat, lstat, realpath } from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { watch as watchDirectory } from 'node:fs';
import { readSessionInfo } from '../../../../src/session/storage/SessionList.js';
import { activeTranscriptEntries } from '../../../../src/session/transcript/CompactSnapshot.js';
import { getPilotProjectChatDir } from '../../../../src/pilot/paths.js';
import { isPathInsideOrEqual } from '../../utils/pathSafety.js';
import { isVirtualProjectPath } from '../../utils/pilotPaths.js';
import { resolveRegisteredProject } from '../projectRegistration.js';
import { listSearchProjects } from './searchRegistry.js';
import { SearchStore } from './searchStore.js';
import { EXCLUDED_DIRECTORIES, INTERNAL_SESSION, mapConcurrent, normalize,
  relevance, signature, snippet, sortResults, stableId, supportedText, textChunks } from './searchCommon.js';

const require = createRequire(import.meta.url);
const exec = promisify(execFile);
const yieldTurn = () => new Promise(resolve => setImmediate(resolve));
const TRANSCRIPT_LIMIT = 50 * 1024 * 1024;

function visibleMessages(entries) {
  const messages = [];
  for (const entry of activeTranscriptEntries(entries)) {
    const candidates = entry.type === 'accepted_input' ? entry.messages
      : ['assistant_message', 'durable_message'].includes(entry.type) ? [entry.message] : [];
    for (const [index, message] of (Array.isArray(candidates) ? candidates : []).entries()) {
      if (!message || message.metadata?.synthetic || message.metadata?.compactReplacement) continue;
      const body = (Array.isArray(message.content) ? message.content : []).filter(block => block?.type === 'text' && typeof block.text === 'string').map(block => block.text).join('\n');
      if (body.trim()) messages.push({ body, item_key: String(entry.entryId || entry.sequence) + ':' + index,
        entryId: entry.entryId, sequence: entry.sequence, turnId: entry.turnId, role: message.role === 'user' ? 'user' : 'assistant',
        timestamp: entry.createdAt });
    }
  }
  return messages;
}

function parseRecords(buffer, start) {
  const text = buffer.toString('utf8');
  const entries = [];
  let partial = false, offset = start, consumed = 0;
  const lines = text.split('\n');
  for (const [index, line] of lines.entries()) {
    const terminated = index < lines.length - 1;
    const bytes = Buffer.byteLength(line) + (terminated ? 1 : 0);
    if (!line.trim()) { consumed += bytes; offset = start + consumed; continue; }
    try {
      const entry = JSON.parse(line);
      if (typeof entry.type === 'string' && typeof entry.sessionId === 'string' && typeof entry.turnId === 'string'
        && Number.isSafeInteger(entry.sequence) && typeof entry.createdAt === 'string') entries.push(entry);
      else partial = true;
      consumed += bytes; offset = start + consumed;
    } catch {
      partial = true;
      if (terminated) { consumed += bytes; offset = start + consumed; }
    }
  }
  entries.sort((a, b) => a.sequence - b.sequence || a.createdAt.localeCompare(b.createdAt));
  return { entries, partial, offset };
}

export class SearchIndex {
  constructor({ pilotHome, databasePath, maxIndexedFileBytes = 8 * 1024 * 1024, watch = true } = {}) {
    this.pilotHome = pilotHome;
    this.store = new SearchStore(databasePath || path.join(pilotHome, 'search', 'global-v1.sqlite'));
    this.maxIndexedFileBytes = maxIndexedFileBytes;
    this.watch = watch; this.closed = false;
    this.dirtyChats = new Set(); this.dirtyFiles = new Set(); this.dirtyPaths = new Map();
    this.registryDirty = true;
    this.catalogErrors = new Map();
    this.projects = this.store.projects();
    this.catalogRoots = new Set();
    this.canonicalRoots = new Map();
    this.queue = []; this.jobs = new Map(); this.running = 0;
    this.metrics = { catalogScans: 0, transcriptFullReads: 0, transcriptAppendReads: 0, fileReads: 0,
      indexedBytes: 0, verifiedBytes: 0, fts: this.store.fts, stages: {} };
  }
  async rg(root, args) {
    const { rgPath } = require('@vscode/ripgrep');
    try { return (await exec(rgPath, args, { cwd: root, timeout: 8000, maxBuffer: 16 * 1024 * 1024, encoding: 'utf8', windowsHide: true })).stdout; }
    catch (error) { if (error.code === 1) return error.stdout || ''; throw error; }
  }
  async initialize(projectsOverride) {
    if (!this.initialized) {
      this.initialized = this.refreshCatalog(projectsOverride, true).then(() => {
        if (this.watch && !this.closed) this.startWatchers();
        if (!this.closed) this.ensureContent(['chats', 'files']).catch(() => {});
      });
    }
    await this.initialized;
  }
  invalidate(projectName, kind, event, absolutePath) {
    if (this.closed) return;
    this.store.bump();
    if (!projectName) this.registryDirty = true;
    else if (kind === 'chats') this.dirtyChats.add(projectName);
    else if (event === 'change' && absolutePath && path.basename(absolutePath) !== '.gitignore') this.dirtyPaths.set(absolutePath, projectName);
    else this.dirtyFiles.add(projectName);
    clearTimeout(this.reconcileTimer);
    this.reconcileTimer = setTimeout(() => this.refreshCatalog().then(() => this.ensureContent(['chats', 'files'])).catch(() => {}), 150);
    this.reconcileTimer.unref?.();
  }
  async refreshCatalog(projectsOverride, force = false) {
    if (this.catalogPromise) { await this.catalogPromise; if (force) return this.refreshCatalog(projectsOverride, force); return; }
    if (this.catalogErrors.size && Date.now() - (this.catalogRetryAt || 0) > 1000) {
      this.catalogRetryAt = Date.now();
      for (const name of this.catalogErrors.keys()) this.dirtyFiles.add(name);
    }
    const needsRegistry = force || this.registryDirty;
    const chats = new Set(this.dirtyChats), files = new Set(this.dirtyFiles), changed = new Map(this.dirtyPaths);
    this.dirtyChats.clear(); this.dirtyFiles.clear(); this.dirtyPaths.clear(); this.registryDirty = false;
    if (!needsRegistry && !chats.size && !files.size && !changed.size) return;
    this.catalogPromise = (async () => {
      const started = performance.now();
      if (needsRegistry) {
        const candidates = projectsOverride || await listSearchProjects(this.pilotHome);
        const projects = [];
        await mapConcurrent(candidates, async candidate => {
          try {
            const root = await resolveRegisteredProject(candidate.name, this.pilotHome);
            const { sessions: _sessions, sessionMeta: _sessionMeta, ...project } = candidate;
            projects.push({ ...project, fullPath: root, path: root });
          } catch { /* Registrations are the authority, including after a deletion. */ }
        });
        this.projects = projects.sort((a, b) => a.name.localeCompare(b.name));
        this.store.setProjects(this.projects);
      }
      await mapConcurrent(this.projects, async project => {
        if (needsRegistry || chats.has(project.name)) await this.chatCatalog(project);
        if (needsRegistry || files.has(project.name)) await this.fileCatalog(project);
      });
      for (const [absolute, projectName] of changed) {
        if (files.has(projectName) || needsRegistry) continue;
        const project = this.projects.find(item => item.name === projectName);
        if (!project) continue;
        const source = this.store.source(stableId(projectName, 'files', path.relative(project.fullPath, absolute).split(path.sep).join('/')));
        if (!source) { this.dirtyFiles.add(projectName); continue; }
        const info = await lstat(absolute).catch(() => null);
        if (info?.isFile() && !info.isSymbolicLink()) this.store.upsertSource({ ...source, signature: signature(info), modified: info.mtimeMs });
        else this.dirtyFiles.add(projectName);
      }
      this.metrics.stages.catalogMs = Math.round(performance.now() - started);
      if (this.workspaceWatchers) this.updateWatchedRoots();
    })().finally(() => { this.catalogPromise = null; });
    await this.catalogPromise;
    if (this.dirtyChats.size || this.dirtyFiles.size || this.dirtyPaths.size || this.registryDirty) await this.refreshCatalog(projectsOverride);
  }
  async chatCatalog(project) {
    const directory = project.storageId ? path.join(this.pilotHome, 'projects', project.storageId, 'chats')
      : getPilotProjectChatDir(project.fullPath, this.pilotHome);
    const names = await readdir(directory, { withFileTypes: true }).catch(() => []);
    const keep = new Set();
    await mapConcurrent(names.filter(item => item.isFile() && item.name.endsWith('.jsonl') && !INTERNAL_SESSION.test(item.name)), async item => {
      const absolute = path.join(directory, item.name);
      const info = await lstat(absolute).catch(() => null);
      if (!info?.isFile() || info.isSymbolicLink()) return;
      const id = stableId(project.name, 'chats', item.name); keep.add(id);
      const old = this.store.source(id), sig = signature(info);
      if (old?.signature === sig) return;
      const sessionId = item.name.slice(0, -6);
      const metadata = await readSessionInfo(absolute, sessionId, project.fullPath).catch(() => null);
      this.store.upsertSource({ id, project_name: project.name, kind: 'chats', relative_path: item.name, absolute_path: absolute,
        title: metadata?.customTitle || metadata?.aiTitle || metadata?.summary || metadata?.firstPrompt || sessionId,
        session_id: sessionId, modified: info.mtimeMs, signature: sig });
    });
    this.store.removeMissing(project.name, 'chats', keep);
  }
  async fileCatalog(project) {
    const keep = new Set();
    const root = project.fullPath;
    this.catalogRoots.delete(root);
    this.canonicalRoots.delete(root);
    if (project.capabilities?.files === false || isVirtualProjectPath(root, this.pilotHome)) {
      this.store.removeMissing(project.name, 'files', keep); return;
    }
    const canonical = await realpath(root).catch(() => null);
    const home = await realpath(this.pilotHome);
    this.canonicalPilotHome = home;
    if (!canonical || isPathInsideOrEqual(home, canonical)) {
      this.store.removeMissing(project.name, 'files', keep); return;
    }
    this.catalogRoots.add(root);
    this.canonicalRoots.set(root, canonical);
    const globs = [...EXCLUDED_DIRECTORIES].flatMap(name => ['--glob', '!**/' + name + '/**']);
    if (isPathInsideOrEqual(canonical, home)) {
      // A normal workspace may contain PILOT_HOME (for example ~/). Exclude
      // only that subtree, including custom homes with glob metacharacters.
      const relativeHome = path.relative(canonical, home).split(path.sep).join('/').replace(/[?*\[\]{}!\\]/g, '\\$&');
      globs.push('--glob', '!/' + relativeHome + '/**');
    }
    this.metrics.catalogScans++;
    let output;
    try { output = await this.rg(root, ['--files', '--null', '--hidden', '--no-require-git', ...globs]); }
    catch (error) {
      const code = String(error.code || 'unavailable');
      if (this.catalogErrors.get(project.name) !== code) console.warn('[Search] File catalog unavailable:', project.name, code);
      this.catalogErrors.set(project.name, code); return;
    }
    this.catalogErrors.delete(project.name);
    await mapConcurrent(output.split('\0').filter(Boolean), async name => {
      const relative = name.replace(/^\.\//, '').replaceAll('\\', '/');
      const absolute = path.resolve(root, relative);
      if (!isPathInsideOrEqual(root, absolute) || this.isInternalFilePath(absolute)) return;
      const resolved = await realpath(absolute).catch(() => null);
      if (!resolved || !isPathInsideOrEqual(canonical, resolved) || this.isInternalFilePath(resolved)) return;
      const info = await lstat(absolute).catch(() => null);
      if (!info?.isFile() || info.isSymbolicLink()) return;
      const id = stableId(project.name, 'files', relative); keep.add(id);
      const old = this.store.source(id), sig = signature(info);
      if (old?.signature === sig) return;
      this.store.upsertSource({ id, project_name: project.name, kind: 'files', relative_path: relative, absolute_path: absolute,
        title: path.basename(relative), session_id: null, modified: info.mtimeMs, signature: sig });
    }, 8);
    this.store.removeMissing(project.name, 'files', keep);
  }
  isInternalFilePath(absolute) {
    return isPathInsideOrEqual(this.pilotHome, absolute)
      || Boolean(this.canonicalPilotHome && isPathInsideOrEqual(this.canonicalPilotHome, absolute));
  }
  startWatchers() {
    // Native recursive directory watches use far fewer handles than one watch
    // per catalog file on macOS/Windows. Source stats remain authoritative.
    this.workspaceWatchers = new Map();
    try {
      this.registrationWatcher = watchDirectory(path.join(this.pilotHome, 'projects'), { recursive: true, persistent: false }, (_event, file) => {
        if (!file) { this.invalidate(); return; }
        const parts = String(file).split(path.sep);
        if (parts[1] === 'chats' && parts.length === 3 && parts[2].endsWith('.jsonl')) {
          const project = this.projects.find(item => item.storageId === parts[0]);
          this.invalidate(project?.name, 'chats');
        } else if (parts.length < 2 || parts[1] === '.cwd') this.invalidate();
      });
      this.registrationWatcher.on('error', error => { this.watchError = String(error.code || 'unavailable'); this.invalidate(); });
    } catch (error) { this.watchError = String(error.code || 'unavailable'); }
    this.updateWatchedRoots();
    // Cover the gap between the first catalog and establishing watches.
    this.invalidate();
    this.recoveryTimer = setInterval(() => {
      this.registryDirty = true;
      this.refreshCatalog().then(() => this.ensureContent(['chats', 'files'])).catch(() => {});
    }, 300_000);
    this.recoveryTimer.unref?.();
  }
  updateWatchedRoots() {
    if (!this.workspaceWatchers) return;
    const roots = new Set(this.projects.filter(item => this.catalogRoots.has(item.fullPath)).map(item => item.fullPath));
    for (const [root, watcher] of this.workspaceWatchers) if (!roots.has(root)) {
      watcher.close(); this.workspaceWatchers.delete(root);
    }
    for (const root of roots) {
      if (this.workspaceWatchers.has(root)) continue;
      try {
        const watcher = watchDirectory(root, { recursive: true, persistent: false }, (event, name) => {
          const relative = String(name || '');
          if (relative.split(path.sep).some(part => EXCLUDED_DIRECTORIES.has(part))) return;
          const absolute = path.resolve(root, relative);
          const canonicalAbsolute = path.resolve(this.canonicalRoots.get(root) || root, relative);
          if (this.isInternalFilePath(absolute) || this.isInternalFilePath(canonicalAbsolute)) return;
          for (const project of this.projects) if (this.catalogRoots.has(project.fullPath) && isPathInsideOrEqual(project.fullPath, absolute)) {
            this.invalidate(project.name, 'files', event, absolute);
          }
        });
        watcher.on('error', error => { this.watchError = String(error.code || 'unavailable'); this.invalidate(); });
        this.workspaceWatchers.set(root, watcher);
      } catch (error) { this.watchError = String(error.code || 'unavailable'); }
    }
  }
  enqueue(source, priority) {
    if (this.jobs.has(source.id)) {
      const job = this.jobs.get(source.id); if (priority) job.priority = true; return job.promise;
    }
    let resolve;
    const job = { source, priority, promise: new Promise(done => { resolve = done; }), resolve: null };
    job.resolve = resolve; this.jobs.set(source.id, job); this.queue.push(job); this.pump();
    return job.promise;
  }
  pump() {
    while (!this.closed && this.running < 2 && this.queue.length) {
      const priority = this.queue.findIndex(item => item.priority);
      const job = this.queue.splice(priority >= 0 ? priority : 0, 1)[0];
      this.running++;
      this.indexSource(job.source).catch(() => {
        const current = this.store.source(job.source.id);
        if (current) this.store.writeDocuments(current, [], { partial: true, fallback: current.kind === 'files' });
      }).finally(() => {
        this.running--; this.jobs.delete(job.source.id); job.resolve(); this.pump();
      });
    }
  }
  async ensureContent(kinds, projectName, priority = false) {
    if (this.closed) return;
    const pending = this.store.sources(null, projectName).filter(source => kinds.includes(source.kind) && source.signature !== source.indexed_signature);
    await Promise.all(pending.map(source => this.enqueue(source, priority)));
  }
  async indexSource(requested) {
    const source = this.store.source(requested.id);
    if (!source || source.signature === source.indexed_signature) return;
    const info = await lstat(source.absolute_path).catch(() => null);
    if (!info?.isFile() || info.isSymbolicLink()) { this.invalidate(source.project_name, source.kind); return; }
    if (signature(info) !== source.signature) { this.invalidate(source.project_name, source.kind); return; }
    if (source.kind === 'files') {
      const project = this.projects.find(item => item.name === source.project_name);
      const canonical = await realpath(source.absolute_path).catch(() => null);
      const canonicalRoot = project && await realpath(project.fullPath).catch(() => null);
      if (!canonicalRoot || !canonical || !isPathInsideOrEqual(canonicalRoot, canonical) || this.isInternalFilePath(canonical)) {
        this.store.writeDocuments(source, []); return;
      }
      if (!supportedText(source.title)) { this.store.writeDocuments(source, []); return; }
      if (info.size > this.maxIndexedFileBytes) { this.store.writeDocuments(source, [], { fallback: true }); return; }
      this.metrics.fileReads++;
      const buffer = await readFile(source.absolute_path);
      if (buffer.includes(0)) { this.store.writeDocuments(source, []); return; }
      const content = buffer.toString('utf8');
      if (signature(await stat(source.absolute_path)) !== source.signature) { this.invalidate(source.project_name, 'files'); return; }
      this.store.writeDocuments(source, textChunks(content)); this.metrics.indexedBytes += buffer.length;
    } else {
      if (info.size > TRANSCRIPT_LIMIT) { this.store.writeDocuments(source, [], { partial: true }); return; }
      const old = this.store.source(source.id);
      const oldParts = (old.indexed_signature || '').split(':');
      let append = old.read_offset > 0 && oldParts[0] === String(info.dev) && oldParts[1] === String(info.ino)
        && info.size > old.read_offset && old.prefix_hash;
      const handle = await open(source.absolute_path, 'r');
      let buffer, start = 0, prefixHasher;
      try {
        if (append) {
          // A larger file can also be a rewrite followed by an append. Verify
          // the entire previous prefix without reparsing or retaining it.
          prefixHasher = createHash('sha256');
          const chunk = Buffer.alloc(65536);
          let position = 0;
          while (position < old.read_offset) {
            const { bytesRead } = await handle.read(chunk, 0, Math.min(chunk.length, old.read_offset - position), position);
            if (!bytesRead) break;
            prefixHasher.update(chunk.subarray(0, bytesRead)); position += bytesRead;
          }
          this.metrics.verifiedBytes += position;
          append = position === old.read_offset && prefixHasher.copy().digest('hex') === old.prefix_hash;
        }
        start = append ? old.read_offset : 0;
        buffer = Buffer.alloc(info.size - start);
        let read = 0;
        while (read < buffer.length) {
          const { bytesRead } = await handle.read(buffer, read, buffer.length - read, start + read);
          if (!bytesRead) break;
          read += bytesRead;
        }
        buffer = buffer.subarray(0, read);
      } finally { await handle.close(); }
      let parsed = parseRecords(buffer, start);
      if (append && parsed.entries.some(entry => entry.type === 'control_boundary' && entry.boundary?.kind === 'restore')) {
        append = false; start = 0; buffer = await readFile(source.absolute_path); parsed = parseRecords(buffer, 0);
      }
      if (append) this.metrics.transcriptAppendReads++; else this.metrics.transcriptFullReads++;
      // SQLite reuses transcript bodies; avoid a second resident copy in JS.
      const documents = visibleMessages(parsed.entries);
      if (signature(await stat(source.absolute_path)) !== source.signature) { this.invalidate(source.project_name, 'chats'); return; }
      const prefixHash = (append ? prefixHasher : createHash('sha256')).update(buffer.subarray(0, parsed.offset - start)).digest('hex');
      this.store.writeDocuments(source, documents, { append: Boolean(append), offset: parsed.offset, prefixHash, partial: parsed.partial });
      this.metrics.indexedBytes += buffer.length;
    }
    await yieldTurn();
  }
  projectPresentation(input) {
    return new Map(this.projects.map(project => [project.name, { ...project, displayName:
      typeof input.projectNames?.[project.name] === 'string' ? input.projectNames[project.name].slice(0, 500) : project.displayName }]));
  }
  nameResults(input, kind) {
    const query = normalize(input.query), projects = this.projectPresentation(input), rows = [];
    for (const source of this.store.sources(kind, input.projectName)) {
      const project = projects.get(source.project_name);
      if (!project) continue;
      if (kind === 'chats') {
        const title = typeof input.sessionTitles?.[source.session_id] === 'string' ? input.sessionTitles[source.session_id].slice(0, 500) : source.title;
        const score = relevance(title, query);
        if (score) rows.push({ id: 'chat:' + project.name + ':' + source.session_id, kind, project, title, sessionId: source.session_id,
          sessionTitle: title, timestamp: source.modified, score, snippet: snippet(source.preview, query), matchType: 'title', matchCount: 0 });
      } else {
        const score = Math.max(relevance(source.title, query), relevance(source.relative_path, query) - 10);
        if (score > 0) rows.push({ id: 'file:' + project.name + ':' + source.relative_path, kind, project,
          title: source.title, path: source.relative_path, timestamp: source.modified, score });
      }
    }
    return sortResults(rows);
  }
  async bodyResults(input, kind, names) {
    const query = normalize(input.query), projects = this.projectPresentation(input), byId = new Map(names.map(row => [row.id, { ...row }]));
    const documents = this.store.matchingDocuments(query, kind, input.projectName);
    const partial = new Set(this.store.sources(kind, input.projectName).filter(item => item.partial || item.signature !== item.indexed_signature).map(() => kind));
    if (kind === 'files' && [...this.catalogErrors.keys()].some(name => !input.projectName || input.projectName === name)) partial.add('files');
    if (kind === 'files') {
      const fallbacks = this.store.sources('files', input.projectName).filter(source => source.fallback);
      await mapConcurrent(fallbacks, async source => {
        const project = projects.get(source.project_name);
        if (!project) return;
        const info = await lstat(source.absolute_path).catch(() => null);
        const canonical = await realpath(source.absolute_path).catch(() => null);
        const canonicalRoot = await realpath(project.fullPath).catch(() => null);
        if (!info?.isFile() || info.isSymbolicLink() || !canonical || !canonicalRoot
          || !isPathInsideOrEqual(canonicalRoot, canonical) || this.isInternalFilePath(canonical)) return;
        try {
          const output = await this.rg(project.fullPath, ['--json', '--fixed-strings', '--ignore-case', '--max-count', '3', '--max-columns', '2000', '--', input.query, source.relative_path]);
          for (const line of output.split('\n').filter(Boolean)) {
            const record = JSON.parse(line);
            if (record.type === 'match' && record.data.lines.text) documents.push({ ...source, source_id: source.id,
              body: record.data.lines.text.trimEnd(), folded: normalize(record.data.lines.text), line: record.data.line_number, column_number: 1, offset: 0 });
          }
        } catch { partial.add('files'); }
      });
    }
    for (const document of documents) {
      const project = projects.get(document.project_name);
      if (!project) continue;
      if (kind === 'chats') {
        const id = 'chat:' + project.name + ':' + document.session_id;
        const title = typeof input.sessionTitles?.[document.session_id] === 'string' ? input.sessionTitles[document.session_id].slice(0, 500) : document.title;
        const old = byId.get(id), score = relevance(document.body, query);
        if (!score) continue;
        const next = { ...(old || { id, kind, project, title, sessionTitle: title, sessionId: document.session_id, timestamp: document.modified, score: 0 }),
          matchCount: (old?.matchCount || 0) + 1, score: Math.max(old?.score || 0, Math.min(55, score)) };
        if (!old || old.matchType !== 'content' || score > (old.contentScore || 0)
          || (score === old.contentScore && document.sequence >= (old.sequence || 0))) {
          Object.assign(next, { matchType: 'content', snippet: snippet(document.body, query), contentScore: score,
            entryId: document.entry_id || undefined, sequence: document.sequence, turnId: document.turn_id, role: document.role });
        }
        byId.set(id, next);
      } else {
        const id = 'file:' + project.name + ':' + document.relative_path;
        const at = document.folded.indexOf(query);
        if (at < 0) continue;
        const before = document.body.slice(0, at);
        const line = document.line + before.split('\n').length - 1;
        const lastNewline = before.lastIndexOf('\n');
        const column = lastNewline >= 0 ? at - lastNewline : document.column_number + at;
        const old = byId.get(id);
        if (old?.line && (old.line < line || (old.line === line && old.column <= column))) continue;
        byId.set(id, { ...(old || { id, kind, project, title: document.title, path: document.relative_path, timestamp: document.modified }),
          score: Math.max(old?.score || 0, 35), snippet: snippet(document.body.slice(Math.max(0, before.lastIndexOf('\n') + 1)).split('\n')[0], query), line, column });
      }
    }
    return { items: sortResults([...byId.values()]), partial: [...partial] };
  }
  get state() {
    return { generation: this.store.generation, dirty: Boolean(this.catalogPromise || this.registryDirty || this.dirtyChats.size || this.dirtyFiles.size || this.dirtyPaths.size),
      pending: this.jobs.size, metrics: { ...this.metrics, watchError: this.watchError, catalogErrors: Object.fromEntries(this.catalogErrors) } };
  }
  async close() {
    this.closed = true; clearTimeout(this.reconcileTimer); clearInterval(this.recoveryTimer);
    await this.catalogPromise?.catch(() => {});
    this.registrationWatcher?.close();
    for (const watcher of this.workspaceWatchers?.values() || []) watcher.close();
    for (const job of this.queue.splice(0)) { this.jobs.delete(job.source.id); job.resolve(); }
    while (this.running) await new Promise(resolve => setTimeout(resolve, 5));
    this.store.close();
  }
}
