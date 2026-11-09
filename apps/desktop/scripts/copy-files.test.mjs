import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import copying from './copy-files.cjs';

test('runtime assets retain Unicode directory names and file bytes on Windows', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotdeck-copy-'));
  try {
    const source = path.join(root, 'source'), target = path.join(root, '安装 测试 & (files)');
    fs.mkdirSync(path.join(source, '子目录'), { recursive: true });
    const bytes = Buffer.from([0, 255, 128, 1, 42]);
    fs.writeFileSync(path.join(source, '子目录', '说明 中文.bin'), bytes);
    copying.copyFilesSync(source, target, { recursive: true });
    assert.deepEqual(fs.readdirSync(root).sort(), ['source', '安装 测试 & (files)'].sort());
    assert.deepEqual(fs.readFileSync(path.join(target, '子目录', '说明 中文.bin')), bytes);
  } finally {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runtime copying preserves filters and refuses to overwrite when requested', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'pilotdeck-copy-'));
  try {
    const source = path.join(root, 'source'), target = path.join(root, 'target');
    fs.mkdirSync(source);
    fs.writeFileSync(path.join(source, 'keep'), 'original');
    fs.writeFileSync(path.join(source, 'omit'), 'excluded');
    copying.copyFilesSync(source, target, { recursive: true, filter: file => path.basename(file) !== 'omit' });
    assert.deepEqual(fs.readdirSync(target), ['keep']);
    fs.writeFileSync(path.join(target, 'keep'), 'user edit');
    assert.throws(() => copying.copyFilesSync(source, target, { recursive: true, force: false, errorOnExist: true }));
    assert.equal(fs.readFileSync(path.join(target, 'keep'), 'utf8'), 'user edit');
  } finally {
    assert.equal(path.dirname(root), path.resolve(os.tmpdir()));
    fs.rmSync(root, { recursive: true, force: true });
  }
});
