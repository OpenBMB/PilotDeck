// @vitest-environment node
import assert from 'node:assert/strict';
import { afterEach, test } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, appendFile, symlink, rm } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { createGlobalSearch } from './globalSearch.js';
import { getPilotProjectChatDir } from '../../../src/pilot/paths.js';

const temporary = [];
const services = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map(search => search.close()));
  await Promise.all(temporary.splice(0).map(root => rm(root, { recursive: true, force: true })));
});
const entry = (type, sequence, extra = {}) => ({ type, sessionId: 'old-session', turnId: `turn-${sequence}`,
  sequence, createdAt: '2026-10-27T08:00:00Z', entryId: `entry-${sequence}`, ...extra });
const message = (text, role = 'assistant') => ({ role, content: [{ type: 'text', text }] });

async function fixture(options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'pilotdeck-global-search-')); temporary.push(root);
  const pilotHome = path.join(root, 'home'); const workspace = path.join(root, 'workspace');
  await mkdir(pilotHome); await mkdir(workspace);
  await mkdir(path.join(pilotHome, 'projects', 'registered'), { recursive: true });
  await writeFile(path.join(pilotHome, 'projects', 'registered', '.cwd'), workspace);
  const project = { name: 'registered', displayName: 'Example', fullPath: workspace,
    sessions: [{ id: 'recent', title: 'Only the sidebar preview' }] };
  const chatDir = getPilotProjectChatDir(workspace, pilotHome); await mkdir(chatDir, { recursive: true });
  const file = path.join(chatDir, 'old-session.jsonl');
  const records = [
    entry('session_metadata', 0, { metadata: { title: 'Historical planning' } }),
    entry('accepted_input', 1, { messages: [message('用户提问：部署全局搜索', 'user')] }),
    entry('assistant_message', 2, { message: message('needle is in this old response') }),
    entry('assistant_message', 3, { message: { ...message('hidden synthetic needle'), metadata: { synthetic: true } } }),
    entry('assistant_message', 4, { message: { role: 'assistant', content: [{ type: 'thinking', text: 'private needle reasoning' }] } }),
  ];
  await writeFile(file, records.map(item => JSON.stringify(item)).join('\n') + '\n');
  const search = createGlobalSearch({ listProjects: async () => [project], pilotHome, ...options }); services.push(search);
  return { root, pilotHome, workspace, project, chatDir, file, search };
}

test('searches messages outside the sidebar preview and returns a stable navigation target', async () => {
  const { search } = await fixture();
  const result = await search({ query: 'NEEDLE', kind: 'chats' });
  assert.equal(result.counts.chats, 1);
  assert.equal(result.groups.chats[0].sessionId, 'old-session');
  assert.equal(result.groups.chats[0].entryId, 'entry-2');
  assert.match(result.groups.chats[0].snippet, /needle/);
  assert.equal(result.groups.chats[0].text, undefined);
});

test('finds one-character Chinese queries and local display-name overrides', async () => {
  const { search } = await fixture();
  const body = await search({ query: '搜', kind: 'chats' });
  assert.equal(body.counts.chats, 1);
  const title = await search({ query: '改名', kind: 'chats', sessionTitles: { 'old-session': '改名后的对话' } });
  assert.equal(title.counts.chats, 1);
  assert.equal(title.groups.chats[0].title, '改名后的对话');
  const project = await search({ query: 'needle', kind: 'chats', projectNames: { registered: '我的工作区' } });
  assert.equal(project.groups.chats[0].project.displayName, '我的工作区');
  assert.deepEqual(Object.keys(project.groups), ['chats', 'files']);
});

test('invalidates cached sessions after append and excludes restored-away messages', async () => {
  const { search, file } = await fixture();
  await search({ query: 'needle', kind: 'chats' });
  await appendFile(file, JSON.stringify(entry('assistant_message', 5, { message: message('needle brand new') })) + '\n');
  const updated = await search({ query: 'needle', kind: 'chats' });
  assert.equal(updated.counts.chats, 1);
  assert.equal(updated.groups.chats[0].matchCount, 2);
  assert.equal(updated.groups.chats[0].entryId, 'entry-5');
  await appendFile(file, JSON.stringify(entry('control_boundary', 6, { boundary: {
    kind: 'restore', visibleSequences: [0, 1], snapshot: { version: 1, messages: [] },
  } })) + '\n');
  assert.equal((await search({ query: 'needle', kind: 'chats' })).counts.chats, 0);
});

test('searches file names, paths and text with line navigation, respecting ignores and symlink boundaries', async () => {
  const { search, workspace, root } = await fixture();
  await mkdir(path.join(workspace, 'docs'));
  await writeFile(path.join(workspace, 'docs', 'needle-guide.md'), 'first line\nneedle in documentation\n');
  await writeFile(path.join(workspace, 'needle.pdf'), Buffer.from([0, 1, 2]));
  await mkdir(path.join(workspace, 'node_modules'));
  await writeFile(path.join(workspace, 'node_modules', 'needle.txt'), 'needle dependency');
  await writeFile(path.join(root, 'outside-needle.txt'), 'needle secret');
  await symlink(path.join(root, 'outside-needle.txt'), path.join(workspace, 'linked.txt'));
  const result = await search({ query: 'needle', kind: 'files' });
  assert.equal(result.counts.files, 2);
  const content = result.groups.files.find(item => item.path === 'docs/needle-guide.md');
  assert.equal(content.line, 2);
  assert.equal(content.column, 1);
  assert.ok(result.groups.files.some(item => item.path === 'needle.pdf'));
  assert.deepEqual(result.partial, []);
});

test('supports project scope and result pagination and safely treats regex syntax literally', async () => {
  const { search, chatDir } = await fixture();
  for (let index = 0; index < 5; index++) {
    const sessionId = 'page-' + index;
    const records = [
      entry('session_metadata', 0, { sessionId, metadata: { title: 'Page ' + index } }),
      entry('assistant_message', 1, { sessionId, message: message('literal [a.*] hit ' + index) }),
      entry('assistant_message', 2, { sessionId, message: message('second [a.*] hit ' + index) }),
    ];
    await writeFile(path.join(chatDir, sessionId + '.jsonl'), records.map(item => JSON.stringify(item)).join('\n') + '\n');
  }
  const first = await search({ query: '[a.*]', kind: 'chats', limit: 2 });
  const second = await search({ query: '[a.*]', kind: 'chats', limit: 2, offset: 2 });
  assert.equal(first.counts.chats, 5);
  assert.equal(first.groups.chats.length, 2);
  assert.equal(first.hasMore.chats, true);
  assert.notEqual(first.groups.chats[0].id, second.groups.chats[0].id);
  assert.equal((await search({ query: 'needle', projectName: 'unknown' })).counts.chats, 0);
  await assert.rejects(search({ query: '' }), { status: 400 });
  const controller = new AbortController(); controller.abort();
  await assert.rejects(search({ query: 'needle' }, { signal: controller.signal }), { name: 'AbortError' });
});

test('merges title and content hits into one chat with the best snippet and navigation identity', async () => {
  const { search, file } = await fixture();
  await appendFile(file, JSON.stringify(entry('assistant_message', 5, { message: message('needle') })) + '\n');
  await appendFile(file, JSON.stringify(entry('assistant_message', 6, { message: message('A newer but less direct needle match') })) + '\n');
  const result = await search({ query: 'needle', kind: 'chats', sessionTitles: { 'old-session': 'Needle planning' } });
  assert.equal(result.counts.chats, 1);
  assert.equal(result.groups.chats[0].title, 'Needle planning');
  assert.equal(result.groups.chats[0].snippet, 'needle');
  assert.equal(result.groups.chats[0].entryId, 'entry-5');
  assert.equal(result.groups.chats[0].matchType, 'content');
  assert.equal(result.groups.chats[0].matchCount, 3);
});

test('uses the latest visible message as preview for title-only hits without a content target', async () => {
  const { search } = await fixture();
  const result = await search({ query: 'Historical', kind: 'chats' });
  assert.equal(result.counts.chats, 1);
  assert.equal(result.groups.chats[0].matchType, 'title');
  assert.equal(result.groups.chats[0].entryId, undefined);
  assert.equal(result.groups.chats[0].snippet, 'needle is in this old response');
});

test('streams names before bodies and shares work across tabs, pages and subscribers', async () => {
  const { search } = await fixture({ refreshOnQuery: false });
  const stages = [];
  const [first, second] = await Promise.all([
    search({ query: 'Historical', kind: 'chats' }, { onUpdate: result => stages.push(result) }),
    search({ query: 'Historical', kind: 'chats', limit: 1 }),
  ]);
  assert.equal(first.groups.chats[0].id, second.groups.chats[0].id);
  assert.ok(stages.some(result => result.pending.chats && result.groups.chats.length));
  const before = await search.metrics();
  const repeat = await search({ query: 'historical', kind: 'chats', offset: 1 });
  assert.equal(repeat.timings.cacheHit, true);
  assert.equal(repeat.counts.chats, 1);
  assert.equal(repeat.groups.chats.length, 0);
  const after = await search.metrics();
  assert.equal(before.metrics.catalogScans, after.metrics.catalogScans);
  assert.equal(before.metrics.transcriptFullReads, after.metrics.transcriptFullReads);
});

test('uses incremental appends, rebuilds truncated history, and reuses a persistent index after restart', async () => {
  const { search, file, project, pilotHome } = await fixture();
  await search({ query: 'needle', kind: 'chats' });
  const before = await search.metrics();
  await appendFile(file, JSON.stringify(entry('assistant_message', 5, { message: message('incremental needle') })) + '\n');
  await search({ query: 'incremental', kind: 'chats' });
  const appended = await search.metrics();
  assert.equal(appended.metrics.transcriptFullReads, before.metrics.transcriptFullReads);
  assert.equal(appended.metrics.transcriptAppendReads, before.metrics.transcriptAppendReads + 1);
  await writeFile(file, JSON.stringify(entry('assistant_message', 0, { message: message('replacement history') })) + '\n');
  assert.equal((await search({ query: 'needle', kind: 'chats' })).counts.chats, 0);
  await search.close(); services.splice(services.indexOf(search), 1);
  const restarted = createGlobalSearch({ pilotHome, listProjects: async () => [project] }); services.push(restarted);
  assert.equal((await restarted({ query: 'replacement', kind: 'chats' })).counts.chats, 1);
  assert.equal((await restarted.metrics()).metrics.transcriptFullReads, 0);
});

test('a cancelled subscriber does not cancel another request or poison the cache', async () => {
  const { search } = await fixture({ refreshOnQuery: false });
  const controller = new AbortController();
  const cancelled = search({ query: 'needle', kind: 'chats' }, { signal: controller.signal,
    onUpdate: () => controller.abort() });
  const survivor = search({ query: 'needle', kind: 'chats' });
  await assert.rejects(cancelled, { name: 'AbortError' });
  assert.equal((await survivor).counts.chats, 1);
  assert.equal((await search({ query: 'needle', kind: 'chats' })).timings.cacheHit, true);
});

test('indexes literal punctuation, cross-chunk matches and large-file fallback with correct navigation', async () => {
  const { search, workspace } = await fixture({ maxIndexedFileBytes: 40000 });
  await writeFile(path.join(workspace, 'chunks.txt'), 'line one\n' + 'x'.repeat(16370) + '中hello文' + '\nsecond [a.*] literal');
  await writeFile(path.join(workspace, 'large.txt'), 'x'.repeat(41000) + '\nlarge needle fallback\n');
  const boundary = await search({ query: '中hello文', kind: 'files' });
  assert.equal(boundary.counts.files, 1);
  assert.equal(boundary.groups.files[0].line, 2);
  assert.equal(boundary.groups.files[0].column, 16371);
  assert.equal((await search({ query: '[a.*]', kind: 'files' })).counts.files, 1);
  const large = await search({ query: 'needle', kind: 'files' });
  assert.equal(large.groups.files[0].line, 2);
  assert.match(large.groups.files[0].snippet, /large needle/);
});

test('invalidates file results on edit, rename, delete and ignore-rule changes', async () => {
  const { search, workspace } = await fixture();
  const file = path.join(workspace, 'change.txt');
  await writeFile(file, 'before needle');
  assert.equal((await search({ query: 'needle', kind: 'files' })).counts.files, 1);
  await writeFile(file, 'after replacement');
  assert.equal((await search({ query: 'needle', kind: 'files' })).counts.files, 0);
  await writeFile(path.join(workspace, '.gitignore'), 'change.txt\n');
  assert.equal((await search({ query: 'replacement', kind: 'files' })).counts.files, 0);
  await rm(file);
  assert.ok(!(await search({ query: 'change.txt', kind: 'files' })).groups.files.some(item => item.path === 'change.txt'));
});

test('directory watches invalidate cached file and chat content after external edits', async () => {
  const { search, workspace, file } = await fixture({ refreshOnQuery: false, watch: true });
  await search({ query: 'needle', kind: 'all' });
  await new Promise(resolve => setTimeout(resolve, 220));
  await writeFile(path.join(workspace, 'external.txt'), 'watcher unique content');
  await appendFile(file, JSON.stringify(entry('assistant_message', 5, { message: message('watcher unique content') })) + '\n');
  const deadline = Date.now() + 5000;
  let result;
  do {
    await new Promise(resolve => setTimeout(resolve, 40));
    result = await search({ query: 'watcher unique content', kind: 'all' });
  } while ((result.counts.chats !== 1 || result.counts.files !== 1) && Date.now() < deadline);
  assert.equal(result.counts.chats, 1); assert.equal(result.counts.files, 1);
  assert.equal((await search.metrics()).metrics.watchError, undefined);
});

test('a same-inode rewrite followed by an append cannot retain obsolete indexed messages', async () => {
  const { search, file } = await fixture();
  await search({ query: 'needle', kind: 'chats' });
  const before = await search.metrics();
  const text = (await readFile(file, 'utf8')).replaceAll('needle', 'absent');
  await writeFile(file, text + JSON.stringify(entry('assistant_message', 5, { message: message('fresh branch without the old term') })) + '\n');
  assert.equal((await search({ query: 'needle', kind: 'chats' })).counts.chats, 0);
  assert.equal((await search.metrics()).metrics.transcriptFullReads, before.metrics.transcriptFullReads + 1);
});

test('an incomplete UTF-8 JSONL tail is retried after the record finishes writing', async () => {
  const { search, file } = await fixture();
  const record = Buffer.from(JSON.stringify(entry('assistant_message', 5, { message: message('世界完整消息') })) + '\n');
  const split = record.indexOf(Buffer.from('世界')) + 1;
  await appendFile(file, record.subarray(0, split));
  const partial = await search({ query: '世界', kind: 'chats' });
  assert.equal(partial.counts.chats, 0); assert.deepEqual(partial.partial, ['chats']);
  await appendFile(file, record.subarray(split));
  const complete = await search({ query: '世界', kind: 'chats' });
  assert.equal(complete.counts.chats, 1); assert.deepEqual(complete.partial, []);
});

for (const homeName of ['.pilotdeck', 'state[private]']) {
  test(`indexes a workspace containing ${homeName} while excluding internal files and watch events`, async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'pilotdeck-home-workspace-')); temporary.push(root);
    const workspace = path.join(root, 'workspace');
    const pilotHome = path.join(workspace, homeName);
    const registration = path.join(pilotHome, 'projects', 'registered');
    await mkdir(registration, { recursive: true });
    await writeFile(path.join(registration, '.cwd'), workspace);
    await writeFile(path.join(workspace, 'needle.txt'), 'first line\npublic needle content\n');
    await writeFile(path.join(pilotHome, 'needle-secret.txt'), 'internal-only-secret');
    const sibling = path.join(workspace, homeName + '-docs');
    await mkdir(sibling); await writeFile(path.join(sibling, 'needle.txt'), 'public sibling');
    const project = { name: 'registered', displayName: 'Home workspace', fullPath: workspace };
    const search = createGlobalSearch({ pilotHome, listProjects: async () => [project], watch: true, refreshOnQuery: false });
    services.push(search);
    const result = await search({ query: 'needle', kind: 'files' });
    assert.equal(result.counts.files, 2);
    assert.equal(result.groups.files.find(file => file.path === 'needle.txt').line, 2);
    assert.deepEqual(result.partial, []);
    assert.equal((await search({ query: 'internal-only-secret', kind: 'files' })).counts.files, 0);
    await new Promise(resolve => setTimeout(resolve, 250));
    await search({ query: 'needle', kind: 'files' });
    const before = await search.metrics();
    await appendFile(path.join(pilotHome, 'needle-secret.txt'), '\nchanged internal data');
    await new Promise(resolve => setTimeout(resolve, 250));
    const cached = await search({ query: 'needle', kind: 'files' });
    const after = await search.metrics();
    assert.equal(after.generation, before.generation, 'internal writes must not invalidate the file catalog');
    assert.equal(after.metrics.catalogScans, before.metrics.catalogScans);
    assert.equal(cached.timings.cacheHit, true);
    await writeFile(path.join(workspace, 'needle.txt'), 'normal edit');
    const deadline = Date.now() + 5000;
    let updated;
    do {
      await new Promise(resolve => setTimeout(resolve, 40));
      updated = await search({ query: 'public needle content', kind: 'files' });
    } while (updated.counts.files && Date.now() < deadline);
    assert.equal(updated.counts.files, 0, 'ordinary files remain watched');
  });
}
