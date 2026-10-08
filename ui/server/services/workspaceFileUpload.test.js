// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest';
import express from 'express';
import * as fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createWorkspaceFileUploadHandler, createWorkspaceUploadCheckHandler, publishWorkspaceFile } from './workspaceFileUpload.js';
import { readUploadLimits } from './uploadLimits.js';

const cleanups = [];
afterEach(async () => { for (const clean of cleanups.splice(0).reverse()) await clean(); });
async function fixture(overrides = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'pd-workspace-test-'));
  cleanups.push(() => fs.rm(root, { recursive: true, force: true }));
  const app = express();
  app.use(express.json());
  app.post('/check', createWorkspaceUploadCheckHandler({ resolveProject: async () => root, getLimits: () => ({ ...readUploadLimits({}), ...overrides }) }));
  app.post('/upload', createWorkspaceFileUploadHandler({ resolveProject: async () => root, getLimits: () => ({ ...readUploadLimits({}), ...overrides }) }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise(resolve => server.once('listening', resolve));
  cleanups.push(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  const url = `http://127.0.0.1:${server.address().port}/upload`;
  async function send(files, targetPath = '', sizes = files.map(file => file.bytes.length)) {
    const form = new FormData();
    form.append('targetPath', targetPath);
    form.append('relativePaths', JSON.stringify(files.map(file => file.name)));
    form.append('sizes', JSON.stringify(sizes));
    for (const file of files) form.append('files', new Blob([file.bytes]), path.basename(file.name));
    const response = await fetch(url, { method: 'POST', body: form });
    return { status: response.status, body: await response.json() };
  }
  async function cleanStaging() {
    await vi.waitFor(async () => expect(await fs.readdir(path.join(root, '.tmp'))).toEqual([]));
  }
  const check = async (relativePaths, targetPath = '') => {
    const response = await fetch(url.replace('/upload', '/check'), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ targetPath, relativePaths }) });
    return { status: response.status, body: await response.json() };
  };
  return { root, send, check, url, cleanStaging };
}
const file = (name, text = 'hello') => ({ name, bytes: Buffer.from(text) });

describe('workspace uploads', () => {
  it('accepts files over the old 50 MiB limit and preserves all bytes', async () => {
    const f = await fixture();
    const bytes = Buffer.alloc(64 * 1024 ** 2, 0x5a);
    const result = await f.send([{ name: 'slides.pptx', bytes }]);
    expect(result.status).toBe(200);
    expect(result.body.files[0].size).toBe(bytes.length);
    expect((await fs.readFile(path.join(f.root, 'slides.pptx'))).equals(bytes)).toBe(true);
    await f.cleanStaging();
  }, 15000);

  it('accepts 21 files, preserving nested paths', async () => {
    const f = await fixture();
    const result = await f.send(Array.from({ length: 21 }, (_, i) => file(`folder/${i}.txt`)), 'target');
    expect(result.body.files).toHaveLength(21);
    expect(await fs.readFile(path.join(f.root, 'target/folder/20.txt'), 'utf8')).toBe('hello');
    await f.cleanStaging();
  });

  it('checks the actual destination before upload without creating directories', async () => {
    const f = await fixture();
    await fs.mkdir(path.join(f.root, 'docs'));
    await fs.writeFile(path.join(f.root, 'docs/slides.pptx'), 'original');
    const conflict = await f.check(['slides.pptx'], 'docs');
    expect(conflict.status).toBe(409);
    expect(conflict.body).toMatchObject({ error: { code: 'UPLOAD_FILE_EXISTS' }, conflicts: ['slides.pptx'] });
    expect((await f.check(['slides.pptx'])).status).toBe(200);
    expect((await f.check(['slides.pptx'], 'other')).status).toBe(200);
    expect(await fs.readdir(f.root)).toEqual(['docs']);
    expect((await f.check(['../escape.txt'])).status).toBe(400);
  });

  it('rejects existing files even when the client bypasses preflight', async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.root, 'existing.txt'), 'original');
    const result = await f.send([file('existing.txt', 'replacement')]);
    expect(result.body.success).toBe(false);
    expect(result.body.files).toEqual([]);
    expect(result.body.errors).toEqual([{ name: 'existing.txt', code: 'UPLOAD_FILE_EXISTS', message: expect.any(String) }]);
    expect(await fs.readFile(path.join(f.root, 'existing.txt'), 'utf8')).toBe('original');
    await f.cleanStaging();
  });

  it('treats directories and dangling symlinks as name conflicts', async () => {
    const f = await fixture();
    await fs.mkdir(path.join(f.root, 'folder'));
    await fs.symlink(path.join(f.root, 'missing'), path.join(f.root, 'link'));
    const checked = await f.check(['folder', 'link']);
    expect(checked.body.conflicts).toEqual(['folder', 'link']);
    const result = await f.send([file('folder'), file('link')]);
    expect(result.body.errors.map(error => error.code)).toEqual(['UPLOAD_FILE_EXISTS', 'UPLOAD_FILE_EXISTS']);
    expect((await fs.lstat(path.join(f.root, 'folder'))).isDirectory()).toBe(true);
    expect((await fs.lstat(path.join(f.root, 'link'))).isSymbolicLink()).toBe(true);
    await f.cleanStaging();
  });

  it('only publishes one of two concurrent uploads to the same destination', async () => {
    const f = await fixture();
    expect((await f.check(['same.txt'])).status).toBe(200);
    expect((await f.check(['same.txt'])).status).toBe(200);
    const results = await Promise.all([f.send([file('same.txt', 'first')]), f.send([file('same.txt', 'second')])]);
    expect(results.filter(result => result.body.success)).toHaveLength(1);
    expect(results.find(result => !result.body.success).body.errors[0].code).toBe('UPLOAD_FILE_EXISTS');
    const winner = results[0].body.success ? 'first' : 'second';
    expect(await fs.readFile(path.join(f.root, 'same.txt'), 'utf8')).toBe(winner);
    await f.cleanStaging();
  });

  it.each([false, true])('publishes across devices without overwriting a race winner (collision=%s)', async collision => {
    const f = await fixture();
    const source = path.join(f.root, 'source');
    const destination = path.join(f.root, 'destination');
    await fs.writeFile(source, 'upload');
    const link = vi.fn().mockRejectedValueOnce(Object.assign(new Error('cross device'), { code: 'EXDEV' }))
      .mockImplementationOnce(async (temporary, target) => {
        if (collision) await fs.writeFile(target, 'race winner');
        return fs.link(temporary, target);
      });
    const publishing = publishWorkspaceFile(source, destination, new AbortController().signal, { ...fs, link });
    if (collision) await expect(publishing).rejects.toMatchObject({ code: 'EEXIST' });
    else await publishing;
    expect(await fs.readFile(destination, 'utf8')).toBe(collision ? 'race winner' : 'upload');
    expect((await fs.readdir(f.root)).filter(name => name.startsWith('.pilotdeck-upload-'))).toEqual([]);
  });

  it.each([
    [{ maxFileBytes: 3 }, [file('a.txt')], 'UPLOAD_FILE_TOO_LARGE'],
    [{ maxTaskBytes: 8 }, [file('a.txt'), file('b.txt')], 'UPLOAD_TASK_TOO_LARGE'],
    [{ maxFiles: 1 }, [file('a.txt'), file('b.txt')], 'UPLOAD_TOO_MANY_FILES'],
  ])('enforces configured limits without publishing partial files (%j)', async (limits, files, code) => {
    const f = await fixture(limits);
    const result = await f.send(files);
    expect(result.status).toBeGreaterThanOrEqual(400);
    expect(result.body.error.code).toBe(code);
    expect((await fs.readdir(f.root)).filter(name => name !== '.tmp')).toEqual([]);
    await f.cleanStaging();
  });

  it('rejects path traversal and symlink destinations before publishing any file', async () => {
    const f = await fixture();
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'pd-outside-test-'));
    cleanups.push(() => fs.rm(outside, { recursive: true, force: true }));
    await fs.symlink(outside, path.join(f.root, 'link'));
    for (const name of ['../escape.txt', 'link/escape.txt']) {
      const result = await f.send([file('good.txt'), file(name)]);
      expect(result.body.error.code).toBe('UPLOAD_INVALID_PATH');
      await expect(fs.access(path.join(f.root, 'good.txt'))).rejects.toThrow();
    }
    expect(await fs.readdir(outside)).toEqual([]);
    await f.cleanStaging();
  });

  it('rejects size mismatch and duplicate paths without changing existing files', async () => {
    const f = await fixture();
    const mismatch = await f.send([file('a.txt')], '', [999]);
    expect(mismatch.body.error.code).toBe('UPLOAD_INTEGRITY_MISMATCH');
    const duplicate = await f.send([file('a.txt'), file('a.txt')]);
    expect(duplicate.body.error.code).toBe('UPLOAD_MANIFEST_INVALID');
    await expect(fs.access(path.join(f.root, 'a.txt'))).rejects.toThrow();
    await f.cleanStaging();
  });

  it('reports exactly which files failed to save', async () => {
    const f = await fixture();
    await fs.mkdir(path.join(f.root, 'blocked.txt'));
    const result = await f.send([file('good.txt'), file('blocked.txt')]);
    expect(result.status).toBe(207);
    expect(result.body.files.map(item => item.name)).toEqual(['good.txt']);
    expect(result.body.errors.map(item => item.name)).toEqual(['blocked.txt']);
    await f.cleanStaging();
  });

  it('cleans staging on a disconnected upload and keeps the existing file intact', async () => {
    const f = await fixture();
    await fs.writeFile(path.join(f.root, 'a.txt'), 'original');
    const req = http.request(f.url, { method: 'POST', headers: { 'Content-Type': 'multipart/form-data; boundary=test', 'Content-Length': '10000000' } });
    req.on('error', () => {});
    req.write('--test\r\nContent-Disposition: form-data; name="files"; filename="a.txt"\r\nContent-Type: application/octet-stream\r\n\r\n');
    req.write(Buffer.alloc(128 * 1024, 65));
    await vi.waitFor(async () => expect((await fs.readdir(path.join(f.root, '.tmp'))).length).toBe(1));
    req.destroy();
    await f.cleanStaging();
    expect(await fs.readFile(path.join(f.root, 'a.txt'), 'utf8')).toBe('original');
  });
});
