import assert from 'node:assert/strict';
import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';
const source = fs.readFileSync(new URL('../src/filePicker.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, { compilerOptions: { esModuleInterop: true, module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
function load(pathApi = path) {
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', compiled)(mod, mod.exports, id => {
    if (id === 'node:path') return pathApi;
    throw new Error(`Unexpected runtime dependency ${id}`);
  });
  return mod.exports;
}
const { normalizeFilePickerRequest, filePickerOptions, createFilePicker, assignSelectedFiles } = load();
const request = { inputId: 'picker-1', accept: 'image/png,image/jpeg,image/webp', multiple: false, directory: false };
const defaults = { images: path.resolve('Images'), files: path.resolve('Downloads'), directory: path.resolve('Home') };
const photos = [path.resolve('Photos', 'one.png'), path.resolve('Photos', 'two.png')];
const owner = { isDestroyed: () => false };
test('picker validates identifiers and uses explicit filters without registry discovery', () => {
  assert.throws(() => normalizeFilePickerRequest({ ...request, inputId: '"] script' }));
  assert.throws(() => normalizeFilePickerRequest({ ...request, accept: 'a'.repeat(4097) }));
  assert.throws(() => normalizeFilePickerRequest({ ...request, multiple: 'true' }));
  assert.deepEqual(filePickerOptions(request, defaults.images, true).filters[0].extensions, ['png', 'jpg', 'jpeg', 'webp']);
  assert.deepEqual(filePickerOptions({ ...request, accept: 'application/json,.json,.JSON' }, defaults.files, false).filters[0].extensions, ['json']);
  assert.equal(filePickerOptions({ ...request, accept: 'application/unknown' }, defaults.files, false).filters, undefined);
  assert.deepEqual(filePickerOptions({ ...request, multiple: true }, defaults.files, false).properties, ['openFile', 'multiSelections']);
  assert.deepEqual(filePickerOptions({ ...request, directory: true }, defaults.directory, false).properties, ['openDirectory']);
});
test('all upload entries open the dialog immediately, preserve selected paths and remember directories by kind', async () => {
  const calls = [], assigned = [];
  const pick = createFilePicker({ defaults, chinese: () => false,
    showDialog: async (_owner, options) => { calls.push(options); return { canceled: false, filePaths: photos }; },
    assign: async (_owner, id, files) => { assigned.push({ id, files }); },
  });
  assert.equal(await pick(owner, { ...request, multiple: true }), 'selected');
  assert.deepEqual(assigned[0].files, photos);
  assert.equal(calls[0].defaultPath, defaults.images);
  await pick(owner, request);
  assert.equal(calls[1].defaultPath, path.dirname(photos[0]));
  assert.deepEqual(assigned[1].files, [photos[0]]);
  await pick(owner, { ...request, accept: '.json' });
  assert.equal(calls[2].defaultPath, defaults.files);
});
test('cancel and concurrent requests do not modify the existing file input', async () => {
  let resolve, assigned = 0, calls = 0;
  const pick = createFilePicker({ defaults, chinese: () => true,
    showDialog: () => { calls++; return new Promise(done => { resolve = done; }); }, assign: async () => { assigned++; },
  });
  const pending = pick(owner, request);
  assert.equal(calls, 1);
  assert.equal(await pick(owner, request), 'busy');
  resolve({ canceled: true, filePaths: [] });
  assert.equal(await pending, 'canceled');
  assert.equal(assigned, 0);
  const retry = pick(owner, request);
  resolve({ canceled: false, filePaths: [photos[0]] });
  assert.equal(await retry, 'selected');
});

test('dialog and file assignment failures release the lock and preserve the last valid directory', async () => {
  const calls = [];
  let dialogFailure = true, assignmentFailure = true;
  const pick = createFilePicker({ defaults, chinese: () => false,
    showDialog: async (_owner, options) => {
      calls.push(options);
      if (dialogFailure) { dialogFailure = false; throw new Error('dialog unavailable'); }
      return { canceled: false, filePaths: [photos[0]] };
    },
    assign: async () => { if (assignmentFailure) { assignmentFailure = false; throw new Error('input removed'); } },
  });
  await assert.rejects(pick(owner, request), /dialog unavailable/);
  await assert.rejects(pick(owner, request), /input removed/);
  assert.equal(await pick(owner, request), 'selected');
  assert.deepEqual(calls.map(c => c.defaultPath), [defaults.images, defaults.images, defaults.images]);
});
test('Windows UNC selections are allowed but do not become the next startup location on any test host', async () => {
  const { createFilePicker } = load(path.win32);
  const calls = [];
  const pick = createFilePicker({ defaults, chinese: () => false,
    showDialog: async (_owner, options) => { calls.push(options); return { canceled: false, filePaths: ['\\\\offline-share\\folder\\one.png'] }; }, assign: async () => {},
  });
  await pick(owner, request); await pick(owner, request);
  assert.equal(calls[1].defaultPath, defaults.images);
});
test('POSIX selections remember their directory without interpreting them as Windows shares', async () => {
  const { createFilePicker } = load(path.posix);
  const calls = [];
  const pick = createFilePicker({ defaults, chinese: () => false,
    showDialog: async (_owner, options) => { calls.push(options); return { canceled: false, filePaths: ['/mnt/photos/one.png'] }; }, assign: async () => {},
  });
  await pick(owner, request); await pick(owner, request);
  assert.equal(calls[1].defaultPath, '/mnt/photos');
});
test('native File assignment emits a private DOM operation and cleans up only its own debugger session', async () => {
  const calls = [];
  let attached = false;
  const debuggerApi = { isAttached: () => attached, attach: () => { attached = true; }, detach: () => { attached = false; },
    sendCommand: async (method, params) => { calls.push({ method, params }); return method === 'DOM.performSearch' ? { searchId: 's', resultCount: 1 } : method === 'DOM.getSearchResults' ? { nodeIds: [12] } : {}; },
  };
  await assignSelectedFiles({ webContents: { debugger: debuggerApi } }, request.inputId, ['C:\\one.png']);
  assert.equal(attached, false);
  assert.deepEqual(calls.find(c => c.method === 'DOM.setFileInputFiles').params, { nodeId: 12, files: ['C:\\one.png'] });
  attached = true;
  await assignSelectedFiles({ webContents: { debugger: debuggerApi } }, request.inputId, ['C:\\two.png']);
  assert.equal(attached, true);
});
