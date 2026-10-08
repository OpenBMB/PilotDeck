import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FUNASR_MODELS,
  runtimeDirectory,
  runtimePaths,
  resolveRuntimeAsset,
} from "../../src/extension/plugins/builtin/funasr/funasr-runtime.mjs";

test("FunASR local runtime maps all published target platforms", () => {
  assert.equal(resolveRuntimeAsset("darwin", "arm64").file, "funasr-llamacpp-macos-arm64.tar.gz");
  assert.equal(resolveRuntimeAsset("linux", "arm64").file, "funasr-llamacpp-linux-arm64.tar.gz");
  assert.equal(resolveRuntimeAsset("linux", "x64").file, "funasr-llamacpp-linux-x64.tar.gz");
  assert.equal(resolveRuntimeAsset("win32", "x64").file, "funasr-llamacpp-windows-x64.zip");
  assert.throws(() => resolveRuntimeAsset("darwin", "x64"), /unsupported-platform/);
  assert.deepEqual(resolveRuntimeAsset("win32", "arm64"), resolveRuntimeAsset("win32", "x64"));
  assert.throws(() => resolveRuntimeAsset("win32", "ia32"), /unsupported-platform/);
});

test("Windows ARM64 installation and MCP lookup reuse an existing x64 cache", () => {
  const root = mkdtempSync(join(tmpdir(), "pilotdeck-funasr-cache-"));
  try {
    const x64Directory = runtimeDirectory(root, "win32", "x64");
    const binaryDirectory = join(x64Directory, "bin");
    mkdirSync(binaryDirectory, { recursive: true });
    const binary = join(binaryDirectory, "llama-funasr-sensevoice.exe");
    writeFileSync(binary, "cached x64 runtime");
    assert.equal(runtimeDirectory(root, "win32", "arm64"), x64Directory);
    assert.deepEqual(runtimePaths(root, "win32", "arm64"), runtimePaths(root, "win32", "x64"));
    assert.equal(runtimePaths(root, "win32", "arm64").binary, binary);
    assert.notEqual(runtimeDirectory(root, "linux", "arm64"), runtimeDirectory(root, "linux", "x64"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("FunASR model definitions use the expected upstream files", () => {
  assert.equal(FUNASR_MODELS.length, 2);
  for (const model of FUNASR_MODELS) {
    assert.match(model.file, /\.gguf$/u);
    assert.equal(model.revision, "master");
  }
});
