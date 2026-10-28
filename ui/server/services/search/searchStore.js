import Database from 'better-sqlite3';
import { mkdirSync, chmodSync } from 'node:fs';
import path from 'node:path';
import { normalize, stableId } from './searchCommon.js';

const SCHEMA_VERSION = '1';

/** The database lives in a worker. Original transcripts/files remain authoritative. */
export class SearchStore {
  constructor(filename) {
    if (filename !== ':memory:') mkdirSync(path.dirname(filename), { recursive: true, mode: 0o700 });
    this.db = new Database(filename);
    this.db.pragma('busy_timeout = 5000');
    this.db.pragma('journal_mode = WAL');
    this.db.pragma('foreign_keys = ON');
    this.db.exec([
      'CREATE TABLE IF NOT EXISTS search_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)',
      'CREATE TABLE IF NOT EXISTS search_projects (name TEXT PRIMARY KEY, root TEXT NOT NULL, storage_id TEXT, data TEXT NOT NULL)',
      'CREATE TABLE IF NOT EXISTS search_sources (id TEXT PRIMARY KEY, project_name TEXT NOT NULL REFERENCES search_projects(name) ON DELETE CASCADE, kind TEXT NOT NULL, relative_path TEXT NOT NULL, absolute_path TEXT NOT NULL, title TEXT NOT NULL, session_id TEXT, modified REAL DEFAULT 0, signature TEXT, indexed_signature TEXT, read_offset INTEGER DEFAULT 0, tail_hash TEXT, partial INTEGER DEFAULT 0, fallback INTEGER DEFAULT 0, preview TEXT DEFAULT \'\')',
      'CREATE INDEX IF NOT EXISTS search_source_project ON search_sources(project_name, kind)',
      'CREATE TABLE IF NOT EXISTS search_documents (id INTEGER PRIMARY KEY, source_id TEXT NOT NULL REFERENCES search_sources(id) ON DELETE CASCADE, item_key TEXT NOT NULL, body TEXT NOT NULL, folded TEXT NOT NULL, entry_id TEXT, sequence INTEGER, turn_id TEXT, role TEXT, timestamp TEXT, offset INTEGER DEFAULT 0, line INTEGER DEFAULT 1, column_number INTEGER DEFAULT 1, UNIQUE(source_id,item_key))',
      'CREATE INDEX IF NOT EXISTS search_document_source ON search_documents(source_id)',
    ].join(';\n') + ';');
    // Compatible additive migration for indexes built before append verification.
    if (!this.db.pragma('table_info(search_sources)').some(column => column.name === 'prefix_hash')) {
      this.db.exec('ALTER TABLE search_sources ADD COLUMN prefix_hash TEXT');
    }
    const version = this.db.prepare('SELECT value FROM search_meta WHERE key=?').get('schema_version')?.value;
    if (version && version !== SCHEMA_VERSION) throw new Error('Unsupported search index version');
    this.db.prepare('INSERT OR IGNORE INTO search_meta VALUES (?,?)').run('schema_version', SCHEMA_VERSION);
    this.db.prepare('INSERT OR IGNORE INTO search_meta VALUES (?,?)').run('generation', '0');
    try {
      this.db.exec("CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(folded, content='search_documents', content_rowid='id', tokenize='trigram case_sensitive 1')");
      this.db.exec([
        "CREATE TRIGGER IF NOT EXISTS search_docs_ai AFTER INSERT ON search_documents BEGIN INSERT INTO search_fts(rowid,folded) VALUES(new.id,new.folded); END",
        "CREATE TRIGGER IF NOT EXISTS search_docs_ad AFTER DELETE ON search_documents BEGIN INSERT INTO search_fts(search_fts,rowid,folded) VALUES('delete',old.id,old.folded); END",
        "CREATE TRIGGER IF NOT EXISTS search_docs_au AFTER UPDATE OF folded ON search_documents BEGIN INSERT INTO search_fts(search_fts,rowid,folded) VALUES('delete',old.id,old.folded); INSERT INTO search_fts(rowid,folded) VALUES(new.id,new.folded); END",
      ].join(';\n') + ';');
      this.fts = true;
    } catch { this.fts = false; }
    if (filename !== ':memory:') chmodSync(filename, 0o600);
    this.insertDocument = this.db.prepare('INSERT INTO search_documents(source_id,item_key,body,folded,entry_id,sequence,turn_id,role,timestamp,offset,line,column_number) VALUES(@source_id,@item_key,@body,@folded,@entry_id,@sequence,@turn_id,@role,@timestamp,@offset,@line,@column_number) ON CONFLICT(source_id,item_key) DO UPDATE SET body=excluded.body,folded=excluded.folded,entry_id=excluded.entry_id,sequence=excluded.sequence,turn_id=excluded.turn_id,role=excluded.role,timestamp=excluded.timestamp,offset=excluded.offset,line=excluded.line,column_number=excluded.column_number');
  }
  get generation() { return Number(this.db.prepare("SELECT value FROM search_meta WHERE key='generation'").get().value); }
  bump() { this.db.prepare("UPDATE search_meta SET value=CAST(value AS INTEGER)+1 WHERE key='generation'").run(); return this.generation; }
  projects() { return this.db.prepare('SELECT * FROM search_projects').all().map(row => JSON.parse(row.data)); }
  setProjects(projects) {
    this.db.transaction(() => {
      const keep = new Set(projects.map(item => item.name));
      for (const row of this.db.prepare('SELECT name FROM search_projects').all()) {
        if (!keep.has(row.name)) { this.db.prepare('DELETE FROM search_projects WHERE name=?').run(row.name); this.bump(); }
      }
      const statement = this.db.prepare('INSERT INTO search_projects(name,root,storage_id,data) VALUES(?,?,?,?) ON CONFLICT(name) DO UPDATE SET root=excluded.root,storage_id=excluded.storage_id,data=excluded.data');
      for (const project of projects) {
        const old = this.db.prepare('SELECT root FROM search_projects WHERE name=?').get(project.name);
        if (old && old.root !== project.fullPath) { this.db.prepare('DELETE FROM search_sources WHERE project_name=?').run(project.name); this.bump(); }
        statement.run(project.name, project.fullPath, project.storageId || null, JSON.stringify(project));
      }
    })();
  }
  sources(kind, projectName) {
    const filters = [], args = [];
    if (kind) { filters.push('kind=?'); args.push(kind); }
    if (projectName) { filters.push('project_name=?'); args.push(projectName); }
    return this.db.prepare('SELECT * FROM search_sources' + (filters.length ? ' WHERE ' + filters.join(' AND ') : '')).all(...args);
  }
  source(id) { return this.db.prepare('SELECT * FROM search_sources WHERE id=?').get(id); }
  upsertSource(source) {
    const old = this.source(source.id);
    if (!old || old.signature !== source.signature || old.title !== source.title) this.bump();
    this.db.prepare('INSERT INTO search_sources(id,project_name,kind,relative_path,absolute_path,title,session_id,modified,signature) VALUES(@id,@project_name,@kind,@relative_path,@absolute_path,@title,@session_id,@modified,@signature) ON CONFLICT(id) DO UPDATE SET project_name=excluded.project_name,relative_path=excluded.relative_path,absolute_path=excluded.absolute_path,title=excluded.title,session_id=excluded.session_id,modified=excluded.modified,signature=excluded.signature').run(source);
  }
  removeMissing(projectName, kind, ids) {
    this.db.transaction(() => {
      for (const source of this.sources(kind, projectName)) if (!ids.has(source.id)) {
        this.db.prepare('DELETE FROM search_sources WHERE id=?').run(source.id); this.bump();
      }
    })();
  }
  writeDocuments(source, documents, { append = false, offset = 0, prefixHash = '', partial = false, fallback = false } = {}) {
    this.db.transaction(() => {
      if (this.source(source.id)?.signature !== source.signature) return;
      if (!append) this.db.prepare('DELETE FROM search_documents WHERE source_id=?').run(source.id);
      for (const [index, document] of documents.entries()) this.insertDocument.run({
        source_id: source.id, item_key: document.item_key || stableId(document.entryId || document.sequence || index, index),
        body: document.body, folded: normalize(document.body), entry_id: document.entryId || null,
        sequence: document.sequence ?? null, turn_id: document.turnId || null, role: document.role || null,
        timestamp: document.timestamp || null, offset: document.offset || 0,
        line: document.line || 1, column_number: document.column || 1,
      });
      const preview = append && !documents.length ? this.source(source.id).preview : documents.at(-1)?.body || '';
      this.db.prepare('UPDATE search_sources SET indexed_signature=?,read_offset=?,prefix_hash=?,partial=?,fallback=?,preview=? WHERE id=?')
        .run(source.signature, offset, prefixHash, Number(partial), Number(fallback), preview.slice(0, 1000), source.id);
      this.bump();
    })();
  }
  matchingDocuments(query, kind, projectName) {
    const scope = 's.kind=?' + (projectName ? ' AND s.project_name=?' : '') + ' AND s.indexed_signature=s.signature';
    const args = [kind, ...(projectName ? [projectName] : [])];
    const columns = 'd.*,s.project_name,s.relative_path,s.title,s.session_id,s.modified';
    let rows;
    if (this.fts && [...query].length >= 3) {
      rows = this.db.prepare('SELECT ' + columns + ' FROM search_fts JOIN search_documents d ON d.id=search_fts.rowid JOIN search_sources s ON s.id=d.source_id WHERE search_fts MATCH ? AND ' + scope)
        .all('"' + query.replaceAll('"', '""') + '"', ...args);
    } else rows = this.db.prepare('SELECT ' + columns + ' FROM search_documents d JOIN search_sources s ON s.id=d.source_id WHERE instr(d.folded,?)>0 AND ' + scope).all(query, ...args);
    return rows.filter(row => row.folded.includes(query));
  }
  close() { this.db.close(); }
}
