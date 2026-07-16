import assert from "node:assert/strict";
import test from "node:test";

import type { ExtensionResolver } from "../../src/context/extension/ExtensionResolver.js";
import { PromptAssembler } from "../../src/context/prompt/PromptAssembler.js";

test("available skills include the resolved SKILL.md path and bounded lookup guidance", () => {
  const skillPath = "/opt/pilotdeck/skills/spreadsheets/SKILL.md";
  const extension: ExtensionResolver = {
    listCommands: () => [],
    listSkills: () => [{
      name: "spreadsheets",
      description: "Create and edit spreadsheet files.",
      path: skillPath,
    }],
    listMcpInstructions: () => [],
  };
  const prompt = new PromptAssembler(extension).assemble({
    cwd: "/workspace",
    provider: "openai",
    model: "test-model",
    permissionMode: "bypassPermissions",
    additionalWorkingDirectories: [],
    tools: [],
    now: () => new Date("2026-07-15T00:00:00.000Z"),
  }).joined;

  assert.match(
    prompt,
    /- spreadsheets — Create and edit spreadsheet files\. \(file: \/opt\/pilotdeck\/skills\/spreadsheets\/SKILL\.md\)/,
  );
  assert.match(prompt, /Resolve relative references, scripts, and assets against the directory containing that SKILL\.md\./);
  assert.match(prompt, /Do not search the user's home directory to rediscover a skill/);
});
