import assert from "node:assert/strict";
import test from "node:test";

import {
  FUNASR_MODELS,
  resolveRuntimeAsset,
} from "../../src/extension/plugins/builtin/funasr/funasr-runtime.mjs";

test("FunASR local runtime maps all published target platforms", () => {
  assert.equal(resolveRuntimeAsset("darwin", "arm64").file, "funasr-llamacpp-macos-arm64.tar.gz");
  assert.equal(resolveRuntimeAsset("linux", "arm64").file, "funasr-llamacpp-linux-arm64.tar.gz");
  assert.equal(resolveRuntimeAsset("linux", "x64").file, "funasr-llamacpp-linux-x64.tar.gz");
  assert.equal(resolveRuntimeAsset("win32", "x64").file, "funasr-llamacpp-windows-x64.zip");
  assert.throws(() => resolveRuntimeAsset("darwin", "x64"), /unsupported-platform/);
  assert.throws(() => resolveRuntimeAsset("win32", "arm64"), /unsupported-platform/);
});

test("FunASR model definitions use the expected upstream files", () => {
  assert.equal(FUNASR_MODELS.length, 2);
  for (const model of FUNASR_MODELS) {
    assert.match(model.file, /\.gguf$/u);
    assert.equal(model.revision, "master");
  }
});
