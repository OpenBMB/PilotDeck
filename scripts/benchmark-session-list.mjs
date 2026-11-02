// Isolated disk-only fixture; never reads or modifies a user's PilotHome.
import { mkdtemp, mkdir, writeFile, utimes, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { performance } from 'node:perf_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

const sourceRoot = resolve(process.argv.includes('--root')
  ? process.argv[process.argv.indexOf('--root') + 1]
  : fileURLToPath(new URL('..', import.meta.url)));
const { listProjectSessions } = await import(pathToFileURL(join(sourceRoot, 'dist/src/session/storage/SessionList.js')));
const { listWebProjects, describeWebProject } = await import(pathToFileURL(join(sourceRoot, 'dist/src/web/server/listProjects.js')));
const { getPilotProjectChatDir } = await import(pathToFileURL(join(sourceRoot, 'dist/src/pilot/paths.js')));

const count = Number(process.argv[2] || 1000);
if (!Number.isInteger(count) || count < 1 || count > 10000) throw new Error('Expected 1..10000 sessions');
const root = await mkdtemp(join(tmpdir(), 'pilotdeck-session-benchmark-'));
try {
  const pilotHome = join(root, '.pilotdeck');
  const projectRoot = join(root, 'workspace');
  await mkdir(projectRoot);
  const chatDir = getPilotProjectChatDir(projectRoot, pilotHome);
  await mkdir(chatDir, { recursive: true });
  await writeFile(join(chatDir, '..', '.cwd'), projectRoot);
  // Older transcripts require the metadata fallback; recent sessions have a
  // complete snapshot, as the current writer emits. Approx. 256 MiB / 1000.
  for (let start = 0; start < count; start += 16) {
    await Promise.all(Array.from({ length: Math.min(16, count - start) }, async (_, offset) => {
      const i = start + offset;
      const metadata = JSON.stringify({ type: 'session_metadata', metadata: { title: `Conversation ${i}`, ...(i >= count - 10 ? { isSnapshot: true } : {}) } });
      const content = JSON.stringify({ type: 'assistant_message', message: { role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(256 * 1024) }] } });
      const file = join(chatDir, `web_s_${i}.jsonl`);
      await writeFile(file, `${metadata}\n${content}\n${i >= count - 10 ? metadata + '\n' : ''}`);
      await utimes(file, 1_780_000_000 + i, 1_780_000_000 + i);
    }));
  }
  for (let run = 0; run < 3; run++) {
    const started = performance.now();
    const { projects } = await listWebProjects({ pilotHome });
    const listed = performance.now();
    const sessions = await listProjectSessions({ pilotHome, projectRoot, limit: 5 });
    const previewed = performance.now();
    const summary = await describeWebProject(projectRoot, { pilotHome });
    if (projects[0]?.sessionCount !== count || summary.sessionCount !== count || sessions.length !== Math.min(5, count)) throw new Error('Fixture result mismatch');
    console.log(JSON.stringify({ count, run, projectListMs: +(listed - started).toFixed(1), listAndPreviewMs: +(previewed - started).toFixed(1), summaryMs: +(performance.now() - previewed).toFixed(1), rssMiB: +(process.memoryUsage().rss / 1024 ** 2).toFixed(1) }));
  }
} finally {
  const target = resolve(root);
  if (!target.startsWith(resolve(tmpdir()) + sep) || !target.split(sep).at(-1).startsWith('pilotdeck-session-benchmark-')) throw new Error('Unsafe fixture cleanup');
  await rm(target, { recursive: true, force: true });
}
