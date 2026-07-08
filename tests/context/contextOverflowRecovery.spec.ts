import test from "node:test";
import assert from "node:assert/strict";
import { ContextOverflowRecovery } from "../../src/context/index.js";
import type { CanonicalModelError } from "../../src/model/index.js";

function error(overrides: Partial<CanonicalModelError>): CanonicalModelError {
  return {
    provider: "test",
    protocol: "openai",
    code: "context_overflow",
    message: "boom",
    retryable: false,
    ...overrides,
  };
}

test("output cap errors retry with adjusted output without compacting", () => {
  const recovery = new ContextOverflowRecovery();
  assert.deepEqual(
    recovery.decide({ error: error({ code: "invalid_request", maxOutputTokens: 32768 }), hasAttemptedCompact: false }),
    { type: "adjust_output_and_retry", maxOutputTokens: 32768, reason: "provider-output-cap", scope: "hard_cap" },
  );
});

test("context cap errors request compaction against provider cap", () => {
  const recovery = new ContextOverflowRecovery();
  assert.deepEqual(
    recovery.decide({ error: error({ maxContextTokens: 262144, recoverableViaCompact: true }), hasAttemptedCompact: false }),
    { type: "compact_and_retry", maxContextTokens: 262144, reason: "provider-context-cap" },
  );
});

test("repeated context cap errors use second-stage truncation", () => {
  const recovery = new ContextOverflowRecovery();
  assert.deepEqual(
    recovery.decide({ error: error({ maxContextTokens: 262144, recoverableViaCompact: true }), hasAttemptedCompact: true }),
    { type: "truncate_head_and_retry", keepRatio: 0.25, reason: "ptl-second-attempt" },
  );
});

test("mixed context/output errors compact when available output is too small", () => {
  const recovery = new ContextOverflowRecovery();
  assert.deepEqual(
    recovery.decide({
      error: error({ availableOutputTokens: 128, maxContextTokens: 65_536, recoverableViaCompact: true }),
      hasAttemptedCompact: false,
    }),
    {
      type: "compact_and_retry",
      maxContextTokens: 65_536,
      maxOutputTokens: 4_096,
      reason: "provider-available-output-too-small",
    },
  );
});

test("mixed context/output errors truncate after compaction when available output remains too small", () => {
  const recovery = new ContextOverflowRecovery();
  assert.deepEqual(
    recovery.decide({ error: error({ availableOutputTokens: 128, recoverableViaCompact: true }), hasAttemptedCompact: true }),
    { type: "truncate_head_and_retry", keepRatio: 0.25, reason: "provider-available-output-too-small-after-compact" },
  );
});

test("mixed context/output errors lower output after compaction when available is safe", () => {
  const recovery = new ContextOverflowRecovery();
  assert.deepEqual(
    recovery.decide({ error: error({ availableOutputTokens: 8_192, recoverableViaCompact: true }), hasAttemptedCompact: true }),
    { type: "adjust_output_and_retry", maxOutputTokens: 8_192, reason: "provider-output-cap", scope: "attempt" },
  );
});
