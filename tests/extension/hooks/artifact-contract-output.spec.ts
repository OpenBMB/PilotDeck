import test from "node:test";
import assert from "node:assert/strict";
import { parseHookOutput } from "../../../src/extension/hooks/execution/parseHookOutput.js";

test("parses declarative artifact contracts without domain-specific knowledge", () => {
  const output = parseHookOutput(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "UserPromptSubmit",
      artifactContracts: [{
        id: "complaint",
        path: "deliverables/complaint.xlsx",
        required: true,
        validatorIds: ["legal:complaint-workbook"],
        expectedExtensions: [".xlsx"],
        domainId: "legal",
        options: { schema: "complaint-v1" },
      }],
    },
  }));
  assert.equal(output.type, "sync");
  if (output.type !== "sync") return;
  assert.equal(output.specific?.artifactContracts?.[0]?.domainId, "legal");
  assert.deepEqual(output.specific?.artifactContracts?.[0]?.validatorIds, ["legal:complaint-workbook"]);
});
