import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, appendFile, readFile, rename, symlink, utimes, rm, unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

vi.mock('../../../src/session/storage/SessionLiteReader.js', async (importOriginal) => {
  const reader = await importOriginal();
  return { ...reader, readSessionLite: vi.fn(reader.readSessionLite) };
});
import { readSessionLite } from '../../../src/session/storage/SessionLiteReader.js';
import { getPilotProjectChatDir } from '../../../src/pilot/paths.js';
import { listProjectSessions } from '../../../src/session/storage/SessionList.js';
import { listSessionFiles } from '../../../src/session/storage/SessionCatalog.js';
import { listWebProjects, describeWebProject } from '../../../src/web/server/listProjects.js';

let root, pilotHome, projectRoot, chatDir;
async function transcript(name, title, modified) {
  const file = join(chatDir, `${name}.jsonl`);
  await writeFile(file, JSON.stringify({ type: 'session_metadata', metadata: { title } }) + '\n');
  await utimes(file, modified, modified);
  return file;
}
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'pilotdeck-session-paging-'));
  pilotHome = join(root, '.pilotdeck');
  projectRoot = join(root, 'workspace');
  await mkdir(projectRoot);
  chatDir = getPilotProjectChatDir(projectRoot, pilotHome);
  await mkdir(chatDir, { recursive: true });
  await writeFile(join(chatDir, '..', '.cwd'), projectRoot);
  vi.mocked(readSessionLite).mockClear();
});
afterEach(async () => { await rm(root, { recursive: true, force: true }); });

describe('large project history paging', () => {
  it('counts without opening transcripts and reads only the requested page, even on a cold process cache', async () => {
    for (let start = 0; start < 1000; start += 16) {
      await Promise.all(Array.from({ length: Math.min(16, 1000 - start) }, (_, i) => transcript(`web_s_${start + i}`, `Title ${start + i}`, 1_780_000_000 + start + i)));
    }
    const listed = await listWebProjects({ pilotHome });
    const described = await describeWebProject(projectRoot, { pilotHome });
    expect(listed.projects[0].sessionCount).toBe(1000);
    expect(described.sessionCount).toBe(1000);
    expect(readSessionLite).not.toHaveBeenCalled();
    const options = { pilotHome, projectRoot, limit: 5 };
    const first = await listProjectSessions(options);
    expect(first.map(s => s.summary)).toEqual([999, 998, 997, 996, 995].map(i => `Title ${i}`));
    expect(readSessionLite).toHaveBeenCalledTimes(5);
    // Refresh revalidates attributes, while unchanged summaries are reused.
    first[0].summary = 'caller mutation';
    expect((await listProjectSessions(options))[0].summary).toBe('Title 999');
    expect(readSessionLite).toHaveBeenCalledTimes(5);
    expect((await listProjectSessions({ ...options, offset: 5 })).map(s => s.summary)).toEqual([994, 993, 992, 991, 990].map(i => `Title ${i}`));
    expect(readSessionLite).toHaveBeenCalledTimes(10);
  }, 20_000);

  it('revalidates same-size edits, appends, creations and deletions without a stale TTL', async () => {
    const file = await transcript('web_a', 'Original', 1_780_000_000);
    const options = { pilotHome, projectRoot, limit: 5 };
    expect((await listProjectSessions(options))[0].summary).toBe('Original');
    await transcript('web_a', 'Replaced', 1_780_000_000);
    expect((await listProjectSessions(options))[0].summary).toBe('Replaced');
    await appendFile(file, JSON.stringify({ type: 'session_metadata', metadata: { title: 'Appended title' } }) + '\n');
    await utimes(file, 1_780_000_001, 1_780_000_001);
    expect((await listProjectSessions(options))[0].summary).toBe('Appended title');
    await transcript('web_b', 'Newest', 1_780_000_002);
    expect((await listProjectSessions(options)).map(s => s.summary)).toEqual(['Newest', 'Appended title']);
    await unlink(file);
    expect((await listProjectSessions(options)).map(s => s.summary)).toEqual(['Newest']);
    expect((await describeWebProject(projectRoot, { pilotHome })).sessionCount).toBe(1);
  });

  it('skips corrupt/empty/internal records and subagent directories without leaving pagination gaps', async () => {
    await transcript('web_a', 'A', 1_780_000_001);
    await transcript('web_b', 'B', 1_780_000_002);
    await transcript('always-on-discovery-hidden', 'Hidden', 1_780_000_003);
    await writeFile(join(chatDir, 'web_empty.jsonl'), '');
    await writeFile(join(chatDir, 'web_broken.jsonl'), '{broken json\n');
    await mkdir(join(chatDir, 'web_subagent.jsonl'));
    const options = { pilotHome, projectRoot, limit: 1 };
    expect((await listProjectSessions(options)).map(s => s.summary)).toEqual(['B']);
    expect((await listProjectSessions({ ...options, offset: 1 })).map(s => s.summary)).toEqual(['A']);
    expect(await listProjectSessions({ ...options, offset: 2 })).toEqual([]);
    expect(await listProjectSessions({ pilotHome, projectRoot, limit: 0 })).toHaveLength(2);
    expect(await listProjectSessions({ ...options, includeInternal: true })).toHaveLength(1);
    // Count is stored nonempty transcripts. A damaged record is retained on disk,
    // but must never break the visible page or force reading older history.
    expect((await describeWebProject(projectRoot, { pilotHome })).sessionCount).toBe(3);
  });

  it('keeps legacy marked directories readable without migrating transcript contents', async () => {
    const file = await transcript('web_saved', 'Existing history', 1_780_000_000);
    const original = await readFile(file, 'utf8');
    const markedDirectory = join(pilotHome, 'projects', 'legacy-collision-目录');
    await rename(join(chatDir, '..'), markedDirectory);
    expect((await listWebProjects({ pilotHome })).projects[0].sessionCount).toBe(1);
    expect((await describeWebProject(projectRoot, { pilotHome })).sessionCount).toBe(1);
    expect((await listProjectSessions({ pilotHome, projectRoot, limit: 5 }))[0].summary).toBe('Existing history');
    expect(await readFile(join(markedDirectory, 'chats', 'web_saved.jsonl'), 'utf8')).toBe(original);
  });

  it('rejects traversal and project directory links outside the configured history root', async () => {
    await transcript('web_saved', 'Existing history', 1_780_000_000);
    const outside = join(root, 'outside');
    await mkdir(join(outside, 'chats'), { recursive: true });
    await writeFile(join(outside, 'chats', 'private.jsonl'), 'private');
    expect(await listSessionFiles(pilotHome, join(outside, 'chats'))).toEqual([]);
    expect(await listSessionFiles(pilotHome, join(pilotHome, 'projects', '..', '..', 'outside', 'chats'))).toEqual([]);
    const linked = join(pilotHome, 'projects', 'linked');
    await symlink(outside, linked, process.platform === 'win32' ? 'junction' : 'dir');
    expect(await listSessionFiles(pilotHome, join(linked, 'chats'))).toEqual([]);
    expect((await listProjectSessions({ pilotHome, projectRoot, limit: 5 }))[0].summary).toBe('Existing history');
  });
});
