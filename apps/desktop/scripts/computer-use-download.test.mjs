import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs, { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { downloadDriverArchive, prepareComputerUse, verifyDriverArchive } from '../../../scripts/prepare-computer-use.mjs';

function target(t) {
  const directory = mkdtempSync(join(tmpdir(), 'pilotdeck-driver-download-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  return { directory, archive: join(directory, 'driver.tar.gz') };
}
const url = 'https://example.test/driver.tar.gz';
for (const status of [408, 425, 429, 500, 502, 503, 504]) {
  test(`retries transient HTTP ${status} and replaces the archive with the completed response`, async t => {
    const { archive } = target(t);
    let requests = 0;
    const waits = [];
    await downloadDriverArchive(url, archive, {
      fetchImpl: async (requested, options) => {
        assert.equal(requested, url);
        assert.ok(options.signal instanceof AbortSignal);
        return ++requests === 1 ? new Response('temporary failure', { status }) : new Response('complete archive');
      },
      wait: async ms => { waits.push(ms); assert.equal(existsSync(archive), false); },
    });
    assert.equal(requests, 2);
    assert.deepEqual(waits, [1000]);
    assert.equal(readFileSync(archive, 'utf8'), 'complete archive');
  });
}

test('exhausts four HTTP attempts, backs off and leaves no partial archive', async t => {
  const { archive } = target(t);
  writeFileSync(archive, 'old partial');
  let requests = 0;
  const waits = [];
  await assert.rejects(downloadDriverArchive(url, archive, {
    fetchImpl: async () => { requests++; return new Response('unavailable', { status: 504 }); },
    wait: async ms => { waits.push(ms); },
  }), /HTTP 504/);
  assert.equal(requests, 4);
  assert.deepEqual(waits, [1000, 2000, 4000]);
  assert.equal(existsSync(archive), false);
});

for (const status of [401, 403, 404]) test(`fails permanent HTTP ${status} without retrying`, async t => {
  const { archive } = target(t);
  let requests = 0, waits = 0;
  await assert.rejects(downloadDriverArchive(url, archive, {
    fetchImpl: async () => { requests++; return new Response('denied', { status }); },
    wait: async () => { waits++; },
  }), new RegExp(`HTTP ${status}`));
  assert.equal(requests, 1);
  assert.equal(waits, 0);
});

test('retries dropped connections and body streams without appending partial bytes', async t => {
  const { archive } = target(t);
  // A Web stream can fail while the destination's asynchronous open is still
  // pending. Reproduce that ordering rather than depending on runner timing.
  const open = fs.open;
  let pendingOpens = 0;
  t.mock.method(fs, 'open', (...args) => {
    pendingOpens++;
    const callback = args.pop();
    setTimeout(() => open(...args, (...result) => { pendingOpens--; callback(...result); }), 30);
  });
  let requests = 0;
  writeFileSync(archive, 'stale prefix');
  const reset = () => Object.assign(new TypeError('connection reset'), { cause: { code: 'ECONNRESET' } });
  await downloadDriverArchive(url, archive, {
    fetchImpl: async () => {
      requests++;
      if (requests === 1) throw reset();
      if (requests === 2) {
        let first = true;
        return new Response(new ReadableStream({ pull(controller) {
          if (first) { first = false; controller.enqueue(new TextEncoder().encode('truncated prefix')); }
          else controller.error(reset());
        } }));
      }
      return new Response('verified bytes');
    },
    wait: async () => {
      assert.equal(pendingOpens, 0, 'A failed writer can still recreate the removed archive');
      assert.equal(existsSync(archive), false);
    },
  });
  assert.equal(requests, 3);
  assert.equal(readFileSync(archive, 'utf8'), 'verified bytes');
});

test('recovers a real HTTP transfer after a gateway timeout', async t => {
  const { archive } = target(t);
  const bytes = Buffer.from('synthetic pinned archive');
  let requests = 0;
  const server = http.createServer((_req, res) => {
    res.writeHead(++requests === 1 ? 504 : 200);
    res.end(requests === 1 ? 'Gateway Timeout' : bytes);
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  await downloadDriverArchive(`http://127.0.0.1:${server.address().port}/archive`, archive, { wait: async () => {} });
  verifyDriverArchive(readFileSync(archive), { sha256: createHash('sha256').update(bytes).digest('hex') });
  assert.equal(requests, 2);
});

test('preparation still rejects corrupt successful downloads and preserves an existing installation', async t => {
  const { directory } = target(t);
  const destination = join(directory, 'installed');
  mkdirSync(destination);
  writeFileSync(join(destination, 'existing.txt'), 'keep installed resources');
  const originalFetch = globalThis.fetch;
  let requests = 0;
  globalThis.fetch = async () => { requests++; return new Response('corrupt archive'); };
  t.after(() => { globalThis.fetch = originalFetch; });
  await assert.rejects(prepareComputerUse({ destination, platform: 'linux', arch: 'x64',
    env: { PILOTDECK_CUA_BASE_URL: 'https://example.test' } }), /checksum mismatch/);
  assert.equal(requests, 1);
  assert.equal(readFileSync(join(destination, 'existing.txt'), 'utf8'), 'keep installed resources');
});
