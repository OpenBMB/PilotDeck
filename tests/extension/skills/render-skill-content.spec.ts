import assert from "node:assert/strict";
import test from "node:test";

import { renderSkillContent } from "../../../src/extension/skills/renderSkillContent.js";

test("skill root placeholder expands to the selected skill directory", () => {
  assert.equal(
    renderSkillContent(
      "SKILL_ROOT={{SKILL_ROOT_SHELL}}\n",
      "/opt/pilotdeck/skills/docx/SKILL.md",
    ),
    "SKILL_ROOT='/opt/pilotdeck/skills/docx'\n",
  );
});

test("skill root placeholder is safe for shell paths containing spaces and quotes", () => {
  assert.equal(
    renderSkillContent(
      "ROOT={{SKILL_ROOT_SHELL}}",
      "/Users/A Person/Pilot's Skills/docx/SKILL.md",
    ),
    `ROOT='/Users/A Person/Pilot'"'"'s Skills/docx'`,
  );
});

test("escaped skill root placeholders remain literal in authoring guidance", () => {
  assert.equal(
    renderSkillContent(
      "Use {{!SKILL_ROOT_SHELL}}; runtime={{SKILL_ROOT_SHELL}}",
      "/opt/pilotdeck/skills/skill-creator/SKILL.md",
    ),
    "Use {{SKILL_ROOT_SHELL}}; runtime='/opt/pilotdeck/skills/skill-creator'",
  );
});

test("skill content without the placeholder remains unchanged", () => {
  const content = "# Guidance-only skill\n\nUse judgment.";
  assert.equal(renderSkillContent(content, "/skills/guidance/SKILL.md"), content);
});
