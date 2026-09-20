import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_RUNTIME_CONTEXT_SURFACE,
  LEGACY_RUNTIME_CONTEXT_SURFACE,
  isRuntimeContextSurface,
  resolveRuntimeContextSurface,
} from "../../src/context/index.js";

test("runtime-context surface definition keeps profile and compatibility defaults explicit", () => {
  assert.equal(DEFAULT_RUNTIME_CONTEXT_SURFACE, "system_prompt");
  assert.equal(LEGACY_RUNTIME_CONTEXT_SURFACE, "system_prompt");
  assert.equal(isRuntimeContextSurface("user_message"), true);
  assert.equal(isRuntimeContextSurface("unsupported"), false);
  assert.equal(resolveRuntimeContextSurface("system_prompt"), "system_prompt");
  assert.equal(resolveRuntimeContextSurface("unsupported"), "system_prompt");
  assert.equal(resolveRuntimeContextSurface(undefined, LEGACY_RUNTIME_CONTEXT_SURFACE), "system_prompt");
});
