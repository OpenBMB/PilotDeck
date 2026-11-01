#!/usr/bin/env node
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const runtime = path.resolve(process.argv[2]);
assert.ok(!existsSync(path.join(runtime, 'src')), 'Packaged search must run without source files');
assert.ok(!existsSync(path.join(runtime, 'node_modules', 'tsx')), 'Packaged search must run without tsx');
const temporary = await mkdtemp(path.join(os.tmpdir(), 'pilotdeck-packaged-search-'));
let search;
try {
  // Keep the worker outside the checkout so it cannot accidentally resolve the
  // repository's development dependencies from an ancestor node_modules.
  const isolated = path.join(temporary, 'runtime');
  await mkdir(path.join(isolated, 'ui'), { recursive: true });
  await writeFile(path.join(isolated, 'package.json'), '{"type":"module"}');
  await cp(path.join(runtime, 'ui', 'server'), path.join(isolated, 'ui', 'server'), { recursive: true });
  await symlink(path.join(runtime, 'dist'), path.join(isolated, 'dist'), process.platform === 'win32' ? 'junction' : 'dir');
  await symlink(path.join(runtime, 'node_modules'), path.join(isolated, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir');
  const pilotHome = path.join(temporary, 'home');
  const workspace = path.join(temporary, 'workspace');
  const registration = path.join(pilotHome, 'projects', 'registered');
  await mkdir(path.join(registration, 'chats'), { recursive: true });
  await mkdir(workspace);
  await writeFile(path.join(registration, '.cwd'), workspace);
  await writeFile(path.join(workspace, 'notes.txt'), 'first line\nruntime-needle\n');
  await writeFile(path.join(registration, 'chats', 'session.jsonl'), JSON.stringify({
    type: 'assistant_message', sessionId: 'session', turnId: 'turn', sequence: 1,
    entryId: 'entry', createdAt: '2026-10-28T00:00:00Z',
    message: { role: 'assistant', content: [{ type: 'text', text: 'runtime-needle' }] },
  }) + '\n');
  const { createGlobalSearch } = await import(pathToFileURL(path.join(isolated, 'ui', 'server', 'services', 'globalSearch.js')));
  search = createGlobalSearch({ pilotHome, watch: false });
  await search.warm();
  const result = await search({ query: 'runtime-needle', kind: 'all' });
  assert.equal(result.counts.chats, 1);
  assert.equal(result.counts.files, 1);
  assert.equal(result.groups.chats[0].entryId, 'entry');
  assert.equal(result.groups.files[0].line, 2);
  console.log('[desktop] packaged global search: worker, chat and file queries passed without tsx');
} finally {
  await search?.close();
  await rm(temporary, { recursive: true, force: true });
}
