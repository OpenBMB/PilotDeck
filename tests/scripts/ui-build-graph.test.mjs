import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';
import test from 'node:test';
import { inspectUiBuild } from '../../scripts/check-ui-build-graph.mjs';

const editor = 'src/components/code-editor/view/CodeEditor.tsx';
const pdf = 'src/components/code-editor/view/subcomponents/PdfDocumentPreview.tsx';
const script = fileURLToPath(new URL('../../scripts/check-ui-build-graph.mjs', import.meta.url));
const content = file => Buffer.from(`/* Synthetic ${file} */\nexport const value = 42;\n`);
const manifestFixture = () => ({
  'index.html': { file: 'assets/index.js', isEntry: true, imports: ['_react.js'], dynamicImports: ['src/App.tsx'] },
  'src/App.tsx': { file: 'assets/App.js', isDynamicEntry: true, imports: ['_react-alias.js'], dynamicImports: [editor] },
  '_react.js': { file: 'assets/vendor-react.js', imports: ['_shared.js'] },
  '_react-alias.js': { file: 'assets/vendor-react.js', imports: ['_shared.js'] },
  '_shared.js': { file: 'assets/shared.js', imports: ['_react.js'] },
  [editor]: { file: 'assets/CodeEditor.js', isDynamicEntry: true, imports: ['_react.js', '_vendor-codemirror.js'], dynamicImports: [pdf] },
  '_vendor-codemirror.js': { name: 'vendor-codemirror', file: 'assets/vendor-codemirror.js' },
  [pdf]: { file: 'assets/PdfDocumentPreview.js', isDynamicEntry: true, imports: ['_react.js', '_pdf.js'] },
  '_pdf.js': { file: 'assets/pdf.js' },
});

async function fixture(t, mutate = () => {}) {
  const dist = await mkdtemp(path.join(tmpdir(), 'pilotdeck-build-graph-'));
  t.after(() => rm(dist, { recursive: true, force: true }));
  const manifest = manifestFixture();
  mutate(manifest);
  await mkdir(path.join(dist, '.vite'));
  await mkdir(path.join(dist, 'assets'));
  await writeFile(path.join(dist, '.vite/manifest.json'), JSON.stringify(manifest));
  for (const file of new Set(Object.values(manifest).map(chunk => chunk?.file))) {
    if (typeof file === 'string' && file.startsWith('assets/')) await writeFile(path.join(dist, file), content(file));
  }
  return { dist, manifest, inspect: () => inspectUiBuild(dist) };
}

test('startup includes mandatory App imports, handles cycles and counts shared JavaScript once', async t => {
  const f = await fixture(t, manifest => {
    manifest['src/App.tsx'].imports.push('_style.css');
    manifest['_style.css'] = { file: 'assets/style.css' };
  });
  const report = await f.inspect();
  assert.equal(report.valid, true);
  assert.deepEqual(report.violations, []);
  const expected = ['assets/App.js', 'assets/index.js', 'assets/shared.js', 'assets/vendor-react.js'];
  assert.deepEqual(report.startup.files.map(entry => entry.file), expected);
  assert.equal(report.startup.rawBytes, expected.reduce((total, file) => total + content(file).length, 0));
  assert.equal(report.startup.gzipBytes, expected.reduce((total, file) => total + gzipSync(content(file)).length, 0));
  assert.ok(!report.features.CodeEditor.staticFiles.includes('assets/PdfDocumentPreview.js'));
});

test('the bootstrap App facade remains a mandatory startup root when Vite omits its source key', async t => {
  const f = await fixture(t, manifest => {
    manifest['_App-hash.js'] = { ...manifest['src/App.tsx'], name: 'App' };
    delete manifest['src/App.tsx'];
    manifest['index.html'].dynamicImports = ['_App-hash.js'];
  });
  const report = await f.inspect();
  assert.equal(report.valid, true);
  assert.equal(report.resolvedRoots['src/App.tsx'], '_App-hash.js');
  assert.ok(report.startup.files.some(entry => entry.file === 'assets/App.js'));
});

test('an unrelated App-named chunk cannot replace the missing mandatory root', async t => {
  const f = await fixture(t, manifest => {
    manifest['_App-hash.js'] = { ...manifest['src/App.tsx'], name: 'App' };
    delete manifest['src/App.tsx'];
    manifest['index.html'].dynamicImports = [];
  });
  const report = await f.inspect();
  assert.equal(report.valid, false);
  assert.ok(report.violations.includes('Required startup root src/App.tsx is missing.'));
});

test('ambiguous App facades fail instead of selecting an arbitrary startup graph', async t => {
  const f = await fixture(t, manifest => {
    manifest['_App-one.js'] = { ...manifest['src/App.tsx'], name: 'App' };
    manifest['_App-two.js'] = { ...manifest['src/App.tsx'], name: 'App', file: 'assets/other-App.js' };
    delete manifest['src/App.tsx'];
    manifest['index.html'].dynamicImports = ['_App-one.js', '_App-two.js'];
  });
  const report = await f.inspect();
  assert.equal(report.valid, false);
  assert.ok(report.violations.includes('Required startup root src/App.tsx has ambiguous App facades.'));
});

test('a non-JavaScript root cannot silently reduce the measured startup', async t => {
  const f = await fixture(t, manifest => { manifest['src/App.tsx'].file = 'assets/App.css'; });
  const report = await f.inspect();
  assert.equal(report.valid, false);
  assert.ok(report.violations.includes('Required startup root src/App.tsx must emit JavaScript.'));
});

for (const root of ['index.html', 'src/App.tsx']) {
  test(`missing mandatory startup root ${root} fails`, async t => {
    const f = await fixture(t, manifest => { delete manifest[root]; });
    const report = await f.inspect();
    assert.equal(report.valid, false);
    assert.ok(report.violations.some(message => message.includes(`Required startup root ${root} is missing`)));
  });
}

for (const [name, entry] of [['CodeEditor', editor], ['PdfDocumentPreview', pdf]]) {
  test(`missing ${name} entry fails even when no graph edge mentions it`, async t => {
    const f = await fixture(t, manifest => {
      delete manifest[entry];
      for (const chunk of Object.values(manifest)) chunk.dynamicImports = chunk.dynamicImports?.filter(key => key !== entry);
    });
    const report = await f.inspect();
    assert.equal(report.valid, false);
    assert.ok(report.violations.some(message => message.includes(`Required dynamic entry ${entry} is missing`)));
  });

  test(`${name} must remain a dynamic entry`, async t => {
    const f = await fixture(t, manifest => { delete manifest[entry].isDynamicEntry; });
    const report = await f.inspect();
    assert.equal(report.valid, false);
    assert.ok(report.violations.includes(`${name} must be a dynamic entry.`));
  });

  test(`${name} cannot enter the mandatory App static closure`, async t => {
    const f = await fixture(t, manifest => { manifest['src/App.tsx'].imports.push(entry); });
    const report = await f.inspect();
    assert.equal(report.valid, false);
    assert.ok(report.violations.includes(`${name} is in the startup static-import closure.`));
  });
}

test('a shared vendor edge that pulls the editor into startup is rejected', async t => {
  const f = await fixture(t, manifest => { manifest['_shared.js'].imports.push(editor); });
  const report = await f.inspect();
  assert.equal(report.valid, false);
  assert.ok(report.violations.includes('CodeEditor is in the startup static-import closure.'));
});

test('PDF cannot be a transitive static dependency of the editor', async t => {
  const f = await fixture(t, manifest => { manifest['_vendor-codemirror.js'].imports = [pdf]; });
  const report = await f.inspect();
  assert.equal(report.valid, false);
  assert.ok(report.violations.includes('PdfDocumentPreview is in the CodeEditor static-import closure.'));
  assert.ok(!report.startup.files.some(entry => entry.file === 'assets/PdfDocumentPreview.js'));
});

test('CodeMirror cannot enter startup even if the editor remains lazy', async t => {
  const f = await fixture(t, manifest => { manifest['src/App.tsx'].imports.push('_vendor-codemirror.js'); });
  const report = await f.inspect();
  assert.equal(report.valid, false);
  assert.ok(report.violations.some(message => message.startsWith('CodeMirror chunk')));
  assert.ok(!report.violations.some(message => message.startsWith('CodeEditor is')));
});

test('different manifest keys cannot hide an eagerly loaded feature file', async t => {
  const f = await fixture(t, manifest => { manifest[editor].file = manifest['src/App.tsx'].file; });
  const report = await f.inspect();
  assert.equal(report.valid, false);
  assert.ok(report.violations.includes('CodeEditor is in the startup static-import closure.'));
});

for (const edge of ['imports', 'dynamicImports']) {
  test(`missing ${edge} targets fail`, async t => {
    const f = await fixture(t, manifest => { manifest['src/App.tsx'][edge].push('missing-chunk.js'); });
    const report = await f.inspect();
    assert.equal(report.valid, false);
    assert.ok(report.violations.some(message => message.includes(`missing ${edge} entry missing-chunk.js`)));
  });
}

test('malformed manifests and import lists fail instead of reporting a smaller startup', async t => {
  const f = await fixture(t, manifest => { manifest['src/App.tsx'].imports = 'not-an-array'; });
  await assert.rejects(f.inspect(), /invalid imports/);
  await writeFile(path.join(f.dist, '.vite/manifest.json'), '[]');
  await assert.rejects(f.inspect(), /must be an object/);
});

test('missing emitted startup assets fail measurement', async t => {
  const f = await fixture(t);
  await rm(path.join(f.dist, 'assets/App.js'));
  await assert.rejects(f.inspect(), /ENOENT/);
});

test('manifest asset paths cannot read outside the selected build', async t => {
  const f = await fixture(t, manifest => { manifest['src/App.tsx'].file = '../outside.js'; });
  await assert.rejects(f.inspect(), /must stay inside the build directory/);
});

test('CLI accepts an alternate build and emits metrics before rejecting eager baseline graphs', async t => {
  const f = await fixture(t, manifest => { manifest['src/App.tsx'].imports.push(editor); });
  const failed = spawnSync(process.execPath, [script, '--dist', f.dist], { encoding: 'utf8' });
  assert.equal(failed.status, 1);
  assert.equal(failed.stderr, '');
  const report = JSON.parse(failed.stdout);
  assert.equal(report.valid, false);
  assert.ok(report.startup.rawBytes > 0);
  assert.ok(report.startup.gzipBytes > 0);
  const valid = await fixture(t);
  const passed = spawnSync(process.execPath, [script, '--dist', valid.dist], { encoding: 'utf8' });
  assert.equal(passed.status, 0);
  assert.equal(JSON.parse(passed.stdout).valid, true);
});

test('CLI rejects unsupported or incomplete arguments', () => {
  for (const args of [['--dist'], ['--unknown'], ['--dist', '--other']]) {
    const result = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8' });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /Usage:/);
  }
});
