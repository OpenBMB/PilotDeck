import test from "node:test";
import assert from "node:assert/strict";

import { parseOpenAIResponse } from "../../../../src/model/providers/openai/response.js";

test("parseOpenAIResponse synthesizes a tool call id when provider omits it", () => {
  const response = parseOpenAIResponse({
    choices: [
      {
        finish_reason: "tool_calls",
        message: {
          role: "assistant",
          content: null,
          tool_calls: [
            {
              type: "function",
              function: {
                name: "find_skills",
                arguments: JSON.stringify({ query: "popular skills" }),
              },
            },
          ],
        },
      },
    ],
  });

  const toolCall = response.content.find((block) => block.type === "tool_call");
  assert.ok(toolCall);
  if (toolCall.type !== "tool_call") {
    throw new Error(`Expected tool_call block, got ${toolCall.type}`);
  }
  assert.equal(toolCall.id, "call_0");
});
