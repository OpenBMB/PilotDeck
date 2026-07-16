import assert from "node:assert/strict";
import test from "node:test";

import type { CanonicalMessage } from "../../../src/model/index.js";
import { filterIncompleteToolCalls } from "../../../src/agent/sub/filterIncompleteToolCalls.js";

test("filterIncompleteToolCalls tolerates malformed messages without content", () => {
  const malformed = { role: "assistant" } as unknown as CanonicalMessage;
  const messages: CanonicalMessage[] = [
    malformed,
    { role: "user", content: [{ type: "text", text: "next" }] },
  ];

  assert.deepEqual(filterIncompleteToolCalls(messages), [
    { role: "user", content: [{ type: "text", text: "next" }] },
  ]);
});
