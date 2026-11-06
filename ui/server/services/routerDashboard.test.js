import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createRouterDashboard } from './routerDashboard.js';
import { createProjectId, sanitizeSessionIdForPath } from '../utils/pilotPaths.js';

const homes = [];
afterEach(async () => { await Promise.all(homes.splice(0).map(home => fs.rm(home, { recursive: true, force: true }))); });
const stamp = index => new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString();
function record(sessionId, turnId, projectPath, index = 0, extra = {}) {
  return { sessionId, turnId, projectPath, startedAt: stamp(index), endedAt: stamp(index), provider: 'synthetic', model: 'fixture',
    usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 3, totalTokens: 15 }, cost: { total: 0.01 }, baselineCost: 0.03, tier: 'standard', ...extra };
}
function turn(id, query, tools = []) {
  return [{ type: 'accepted_input', turnId: id, messages: [{ role: 'user', content: [{ type: 'text', text: query }] }] },
    { type: 'assistant_message', turnId: id, message: { content: tools.length ? tools.map(name => ({ type: 'tool_call', name })) : [{ type: 'text', text: 'Synthetic answer' }] } }];
}
async function fixture(options = {}) {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'pilotdeck-dashboard-')); homes.push(home);
  const project = path.join(home, 'workspace'); const stats = path.join(home, 'router', 'stats.jsonl');
  await fs.mkdir(path.dirname(stats), { recursive: true });
  const readFile = vi.fn((...args) => fs.readFile(...args)); const readdir = vi.fn((...args) => fs.readdir(...args));
  const service = createRouterDashboard({ pilotHome: home, repoRoot: project, fs: { ...fs, readFile, readdir }, ...options });
  const transcript = async (sessionId, entries, projectPath = project, storageId = createProjectId(projectPath)) => {
    const directory = path.join(home, 'projects', storageId); const file = path.join(directory, 'chats', `${sanitizeSessionIdForPath(sessionId)}.jsonl`);
    await fs.mkdir(path.dirname(file), { recursive: true }); await fs.writeFile(path.join(directory, '.cwd'), projectPath);
    await fs.writeFile(file, entries.map(entry => typeof entry === 'string' ? entry : JSON.stringify(entry)).join('\n') + '\n');
    return file;
  };
  const writeStats = records => fs.writeFile(stats, records.map(value => JSON.stringify(value)).join('\n') + '\n');
  const transcriptReads = () => readFile.mock.calls.map(([file]) => file).filter(file => file.includes(`${path.sep}chats${path.sep}`));
  return { home, project, stats, service, readFile, readdir, transcript, writeStats, transcriptReads };
}

describe('router dashboard projections', () => {
  it('joins requests beyond twenty turns by durable identity, even when stats start midway through history', async () => {
    const f = await fixture(); const entries = [];
    for (let i = 1; i <= 100; i++) entries.push(...turn(`turn-${i}`, `Synthetic query ${i}`));
    await f.transcript('s', entries);
    await f.writeStats([record('s', 'turn-21', f.project), record('s', 'turn-100', f.project, 1)]);
    const session = (await f.service.getRouterDashboardData()).projects[0].sessions[0];
    expect(session.routing.requestLog.map(entry => entry.query)).toEqual(['Synthetic query 21', 'Synthetic query 100']);
    expect(session.userQueries).toHaveLength(20); expect(session.title).toBe('Synthetic query 1');
    expect(f.transcriptReads()).toHaveLength(1);
  });

  it('shares one parse across concurrent callers and warm dashboard reads', async () => {
    const f = await fixture(); await f.transcript('s', turn('one', 'Synthetic request')); await f.writeStats([record('s', 'one', f.project)]);
    const [a, b] = await Promise.all([f.service.getRouterDashboardData(), f.service.getRouterDashboardData()]);
    expect(a).toEqual(b); expect(f.transcriptReads()).toHaveLength(1);
    expect(await f.service.getRouterDashboardData()).toEqual(a); expect(f.transcriptReads()).toHaveLength(1);
  });

  it('summary reads no transcripts and a session request enriches only that session', async () => {
    const f = await fixture(); await f.transcript('a', turn('a', 'First')); await f.transcript('b', turn('b', 'Second'));
    await f.writeStats([record('a', 'a', f.project), record('b', 'b', f.project, 1)]);
    const summary = await f.service.getRouterStatsSummary();
    expect(summary.lifetime.total).toEqual({ inputTokens: 20, outputTokens: 10, cacheReadTokens: 6, totalTokens: 30,
      requestCount: 2, estimatedCost: 0.02, baselineCost: 0.06, savedCost: 0.039999999999999994 });
    expect(f.transcriptReads()).toEqual([]); expect(f.readdir).not.toHaveBeenCalled();
    const single = await f.service.getRouterSessionStats('b'); expect(single.routing.requestLog[0].query).toBe('Second');
    expect(f.transcriptReads().map(file => path.basename(file))).toEqual(['b.jsonl']);
    expect(f.readdir).not.toHaveBeenCalled();
    expect(await f.service.getRouterSessionStats('absent')).toBeNull();
  });

  it('revalidates append, replacement and deletion without caching stale titles or queries', async () => {
    const f = await fixture(); const file = await f.transcript('s', turn('one', 'Original')); await f.writeStats([record('s', 'one', f.project)]);
    expect((await f.service.getRouterDashboardData()).projects[0].sessions[0].title).toBe('Original');
    await fs.appendFile(file, turn('two', 'Appended').map(value => JSON.stringify(value)).join('\n') + '\n');
    await f.writeStats([record('s', 'one', f.project), record('s', 'two', f.project, 1)]);
    expect((await f.service.getRouterSessionStats('s')).routing.requestLog.map(entry => entry.query)).toEqual(['Original', 'Appended']);
    await f.transcript('s', turn('one', 'Replacement'));
    expect((await f.service.getRouterDashboardData()).projects[0].sessions[0].title).toBe('Replacement');
    await fs.unlink(file);
    const deleted = (await f.service.getRouterDashboardData()).projects[0].sessions[0];
    expect(deleted.title).toBe('s'); expect(deleted.routing.requestLog[0].query).toBeUndefined();
  });

  it('bounds retained projections by entries and bytes, then safely reloads evicted history', async () => {
    const f = await fixture({ maxCacheEntries: 2 });
    await f.transcript('a', turn('a', 'First')); await f.transcript('b', turn('b', 'Second'));
    await f.writeStats([record('a', 'a', f.project), record('b', 'b', f.project, 1)]);
    await f.service.getRouterSessionStats('a'); await f.service.getRouterSessionStats('b'); await f.service.getRouterSessionStats('a');
    expect(f.transcriptReads().map(file => path.basename(file))).toEqual(['a.jsonl', 'b.jsonl', 'a.jsonl']);
    const tiny = createRouterDashboard({ pilotHome: f.home, repoRoot: f.project, fs: { ...fs, readFile: f.readFile }, maxCacheBytes: 1 });
    const before = f.transcriptReads().length; await tiny.getRouterSessionStats('a'); await tiny.getRouterSessionStats('a');
    expect(f.transcriptReads().length - before).toBe(2);
  });

  it('keeps legacy stats and transcripts without turn ids readable with positional continuation labels', async () => {
    const f = await fixture(); const file = await f.transcript('legacy', [
      ...turn(undefined, 'Legacy first', ['read_file']), { type: 'assistant_message', message: { content: [{ type: 'text', text: 'done' }] } },
      ...turn(undefined, 'Legacy second'), 'incomplete-json{',
    ]);
    const records = [record('legacy', undefined, undefined), record('legacy', undefined, undefined, 1), record('legacy', undefined, undefined, 2)];
    await fs.writeFile(path.join(f.home, 'router-stats.json'), JSON.stringify({ sessions: { legacy: { requestLog: records } } }));
    const data = await f.service.getRouterSessionStats('legacy');
    expect(data.routing.requestLog.map(entry => entry.query)).toEqual(['Legacy first', '→ read_file', 'Legacy second']);
    expect(f.transcriptReads()).toEqual([file]);
  });

  it('keeps interleaved turn and subagent labels attached to their own durable turn', async () => {
    const f = await fixture(); await f.transcript('s', [
      ...turn('a', 'Alpha', ['read_file']), { type: 'subagent_started', turnId: 'a', promptPreview: 'Child task' }, ...turn('b', 'Beta'),
    ]);
    await f.writeStats([record('s', 'a', f.project), record('s', 'b', f.project, 1), record('s', 'a', f.project, 2),
      record('s', 'a', f.project, 3, { role: 'subagent', resolvedFrom: 'subagent' })]);
    const log = (await f.service.getRouterSessionStats('s')).routing.requestLog;
    expect(log.map(entry => entry.query)).toEqual(['Alpha', 'Beta', '→ read_file', 'Child task']);
    expect(log[2].role).toBe('sub'); expect(log[3].isSubagentDispatch).toBe(true);
  });

  it('does not shift one-character, attachment-only or synthetic-context turns onto another query', async () => {
    const f = await fixture(); await f.transcript('s', [
      ...turn('a', 'x'), { type: 'accepted_input', turnId: 'b', messages: [
        { role: 'user', metadata: { synthetic: true }, content: [{ type: 'text', text: '<memory-context>private fixture</memory-context>' }] },
        { role: 'user', content: [{ type: 'image', data: 'synthetic' }] },
      ] }, ...turn('c', 'Correct third'),
    ]);
    await f.writeStats(['a', 'b', 'c'].map((id, index) => record('s', id, f.project, index)));
    expect((await f.service.getRouterSessionStats('s')).routing.requestLog.map(entry => entry.query)).toEqual(['x', undefined, 'Correct third']);
  });

  it('resolves collision-resistant project directories without reading another project sharing the legacy slug', async () => {
    const f = await fixture(); const other = path.join(f.home, 'other');
    await f.transcript('same', turn('a', 'Other project'), other, createProjectId(f.project));
    const expected = await f.transcript('same', turn('a', 'Correct project'), f.project, `${createProjectId(f.project)}--fixture`);
    await f.writeStats([record('same', 'a', f.project)]);
    expect((await f.service.getRouterSessionStats('same')).routing.requestLog[0].query).toBe('Correct project');
    expect(f.transcriptReads()).toEqual([expected]);
  });

  it('does not retain a projection under a changed file version while a read is pending', async () => {
    const f = await fixture(); const file = await f.transcript('s', turn('a', 'Old')); await f.writeStats([record('s', 'a', f.project)]);
    let release; const gate = new Promise(resolve => { release = resolve; }); let entered; const reading = new Promise(resolve => { entered = resolve; });
    f.readFile.mockImplementationOnce((...args) => fs.readFile(...args));
    const original = f.readFile.getMockImplementation(); let blocked = false;
    f.readFile.mockImplementation(async (...args) => {
      const raw = await fs.readFile(...args);
      if (args[0] === file && !blocked) { blocked = true; entered(); await gate; }
      return raw;
    });
    const pending = f.service.getRouterSessionStats('s'); await reading;
    await f.transcript('s', turn('a', 'Changed while pending')); release(); await pending;
    expect((await f.service.getRouterSessionStats('s')).routing.requestLog[0].query).toBe('Changed while pending');
    f.readFile.mockImplementation(original);
  });

  it('propagates filesystem permission failures without retaining a failed shared read', async () => {
    const f = await fixture(); const file = await f.transcript('s', turn('a', 'Readable after retry')); await f.writeStats([record('s', 'a', f.project)]);
    f.readFile.mockImplementation(async (...args) => {
      if (args[0] === file) throw Object.assign(new Error('Synthetic access denied'), { code: 'EACCES' });
      return fs.readFile(...args);
    });
    await expect(f.service.getRouterSessionStats('s')).rejects.toMatchObject({ code: 'EACCES' });
    f.readFile.mockImplementation((...args) => fs.readFile(...args));
    expect((await f.service.getRouterSessionStats('s')).routing.requestLog[0].query).toBe('Readable after retry');
  });
});
