import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  generateSkillEvolutionWithModel,
  SkillEvolutionManager,
  SkillManager,
  SkillManagerError,
} from "../../../src/extension/skills/index.js";
import { PluginRuntime } from "../../../src/extension/plugins/runtime/PluginRuntime.js";
import { shouldHandleWatchSignal } from "../../../src/cli/ExtensionWatchManager.js";

const ORIGINAL_SKILL = `---
name: demo
description: Original demo skill
version: 1.0.0
---

# Demo

Follow the original procedure.
`;

test("skill evolution stages proposals, applies safely, and rolls back", async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), "pilotdeck-skill-evo-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const pilotHome = join(root, "pilot-home");
  const skillManager = new SkillManager({ pilotHome });
  await skillManager.create({
    scope: "user",
    slug: "demo",
    content: ORIGINAL_SKILL,
  });

  let sequence = 0;
  let revisionNumber = 1;
  const evolution = new SkillEvolutionManager({
    pilotHome,
    skillManager,
    now: () => new Date(Date.UTC(2026, 6, 13, 12, 0, sequence++)),
    uuid: () => `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`,
    generator: async ({ currentContent }) => {
      revisionNumber += 1;
      return {
        summary: `Improve demo to revision ${revisionNumber}`,
        rationale: "Recorded failure showed that the fallback was unclear.",
        content: currentContent
          .replace(/version: .+/u, `version: 1.0.${revisionNumber}`)
          .replace("Follow the original procedure.", "Follow the original procedure.\n\nIf it fails, verify inputs and retry once."),
      };
    },
  });

  await evolution.recordUse({ scope: "user", slug: "demo", sessionKey: "cli:test" });
  await evolution.record({
    scope: "user",
    slug: "demo",
    outcome: "failure",
    feedback: "The fallback path was missing.",
  });

  const before = await evolution.status({ scope: "user", slug: "demo" });
  assert.equal(before.skills[0]?.stats.useCount, 1);
  assert.equal(before.skills[0]?.stats.failureCount, 1);

  const proposal = await evolution.propose({ scope: "user", slug: "demo" });
  assert.equal(proposal.proposal.status, "pending");
  assert.match(proposal.candidateContent, /verify inputs and retry once/u);
  assert.equal((await skillManager.read({ scope: "user", slug: "demo" })).content, ORIGINAL_SKILL);

  const applied = await evolution.apply({
    scope: "user",
    slug: "demo",
    proposalId: proposal.proposal.id,
  });
  assert.equal(applied.proposal.status, "applied");
  assert.match((await skillManager.read({ scope: "user", slug: "demo" })).content, /verify inputs and retry once/u);

  const staleProposal = await evolution.propose({ scope: "user", slug: "demo" });
  const manualEdit = ORIGINAL_SKILL.replace("version: 1.0.0", "version: 9.9.9");
  await skillManager.write({ scope: "user", slug: "demo", content: manualEdit });
  await assert.rejects(
    evolution.apply({
      scope: "user",
      slug: "demo",
      proposalId: staleProposal.proposal.id,
    }),
    (error: unknown) => error instanceof SkillManagerError && error.code === "evolution_conflict",
  );

  const rolledBack = await evolution.rollback({
    scope: "user",
    slug: "demo",
    revisionId: applied.revision.id,
  });
  assert.equal(rolledBack.rolledBackToRevisionId, applied.revision.id);
  assert.equal((await skillManager.read({ scope: "user", slug: "demo" })).content, ORIGINAL_SKILL);

  const after = await evolution.status({ scope: "user", slug: "demo" });
  assert.equal(after.skills[0]?.stats.applyCount, 1);
  assert.equal(after.skills[0]?.stats.rollbackCount, 1);
  assert.equal(after.skills[0]?.proposals[1]?.status, "rolled_back");
  assert.ok(after.skills[0]!.revisions.length >= 2);
});

test("project and user skill evolution metadata stay in separate scope roots", async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), "pilotdeck-skill-evo-scopes-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const pilotHome = join(root, "pilot-home");
  const projectKey = join(root, "project");
  await fs.mkdir(projectKey, { recursive: true });
  const skillManager = new SkillManager({ pilotHome });
  await skillManager.create({ scope: "user", slug: "demo", content: ORIGINAL_SKILL });
  await skillManager.create({ scope: "project", slug: "demo", projectKey, content: ORIGINAL_SKILL });
  const evolution = new SkillEvolutionManager({ pilotHome, skillManager });

  await evolution.recordUse({ scope: "user", slug: "demo" });
  await evolution.record({
    scope: "project",
    slug: "demo",
    projectKey,
    outcome: "success",
  });

  const status = await evolution.status({ projectKey, slug: "demo" });
  assert.equal(status.skills.length, 2);
  const user = status.skills.find((entry) => entry.skill.scope === "user");
  const project = status.skills.find((entry) => entry.skill.scope === "project");
  assert.equal(user?.stats.useCount, 1);
  assert.equal(user?.stats.successCount, 0);
  assert.equal(project?.stats.useCount, 0);
  assert.equal(project?.stats.successCount, 1);
});

test("plugin runtime maps standalone loaded skills back to evolution addresses", async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), "pilotdeck-skill-evo-runtime-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const pilotHome = join(root, "pilot-home");
  const projectKey = join(root, "project");
  const skillManager = new SkillManager({ pilotHome });
  await skillManager.create({ scope: "user", slug: "user-demo", content: ORIGINAL_SKILL });
  await skillManager.create({
    scope: "project",
    slug: "project-demo",
    projectKey,
    content: ORIGINAL_SKILL.replace("name: demo", "name: project-demo"),
  });

  const runtime = new PluginRuntime({ projectRoot: projectKey, pilotHome });
  await runtime.refresh();
  const addresses = runtime.getAllSkills()
    .map((skill) => runtime.resolveManagedSkillAddress(skill.name))
    .filter((value) => value !== undefined);

  assert.deepEqual(
    addresses.sort((a, b) => a.slug.localeCompare(b.slug)),
    [
      { scope: "project", slug: "project-demo" },
      { scope: "user", slug: "user-demo" },
    ],
  );
});

test("extension watcher ignores evolution sidecars but keeps skill edits hot-reloadable", () => {
  const home = join(tmpdir(), "pilotdeck-watch-test");
  const skills = join(home, "skills");
  assert.equal(
    shouldHandleWatchSignal(home, skills, "skills/.evo/events.jsonl"),
    false,
  );
  assert.equal(
    shouldHandleWatchSignal(skills, skills, ".evo/proposals/proposal_1.json"),
    false,
  );
  assert.equal(
    shouldHandleWatchSignal(skills, skills, "demo/SKILL.md"),
    true,
  );
});

test("model generator requests structured output and parses the full skill draft", async () => {
  let requestedSchema = false;
  const draftContent = ORIGINAL_SKILL.replace("version: 1.0.0", "version: 1.0.1");
  const result = await generateSkillEvolutionWithModel(
    {
      agentModel: { id: "test/model", provider: "test", model: "model" },
      modelRuntime: {
        getCapabilities: () => ({
          supportsToolUse: true,
          supportsStreaming: true,
          supportsParallelToolCalls: true,
          supportsThinking: false,
          supportsJsonSchema: true,
          supportsSystemPrompt: true,
          supportsPromptCache: false,
          maxContextTokens: 32_000,
          maxOutputTokens: 8_000,
        }),
        complete: async (request) => {
          requestedSchema = request.outputSchema?.name === "skill_evolution";
          return {
            role: "assistant" as const,
            content: [{
              type: "text" as const,
              text: JSON.stringify({
                summary: "Clarify fallback",
                rationale: "Failure evidence requested a retry path.",
                content: draftContent,
              }),
            }],
            finishReason: "stop" as const,
          };
        },
      },
    },
    {
      scope: "user",
      slug: "demo",
      projectKey: null,
      currentContent: ORIGINAL_SKILL,
      stats: {
        useCount: 1,
        successCount: 0,
        failureCount: 1,
        correctionCount: 0,
        applyCount: 0,
        rollbackCount: 0,
        lastUsedAt: "2026-07-13T12:00:00.000Z",
        lastFeedbackAt: "2026-07-13T12:01:00.000Z",
        lastEvolvedAt: null,
      },
      recentEvents: [],
    },
  );

  assert.equal(requestedSchema, true);
  assert.equal(result.content, draftContent);
});

test("model generator falls back when a provider rejects response_format", async () => {
  let callCount = 0;
  const draftContent = ORIGINAL_SKILL.replace("version: 1.0.0", "version: 1.0.1");
  const result = await generateSkillEvolutionWithModel(
    {
      agentModel: { id: "test/model", provider: "test", model: "model" },
      modelRuntime: {
        getCapabilities: () => ({
          supportsToolUse: true,
          supportsStreaming: true,
          supportsParallelToolCalls: true,
          supportsThinking: false,
          supportsJsonSchema: true,
          supportsSystemPrompt: true,
          supportsPromptCache: false,
          maxContextTokens: 32_000,
          maxOutputTokens: 8_000,
        }),
        complete: async (request) => {
          callCount += 1;
          if (request.outputSchema) {
            throw new Error("This response_format type is unavailable now");
          }
          return {
            role: "assistant" as const,
            content: [{
              type: "text" as const,
              text: `\`\`\`json\n${JSON.stringify({
                summary: "Clarify fallback",
                rationale: "Failure evidence requested a retry path.",
                content: draftContent,
              })}\n\`\`\``,
            }],
            finishReason: "stop" as const,
          };
        },
      },
    },
    {
      scope: "user",
      slug: "demo",
      projectKey: null,
      currentContent: ORIGINAL_SKILL,
      stats: {
        useCount: 1,
        successCount: 0,
        failureCount: 0,
        correctionCount: 1,
        applyCount: 0,
        rollbackCount: 0,
        lastUsedAt: "2026-07-14T09:00:00.000Z",
        lastFeedbackAt: "2026-07-14T09:01:00.000Z",
        lastEvolvedAt: null,
      },
      recentEvents: [],
    },
  );

  assert.equal(callCount, 2);
  assert.equal(result.content, draftContent);
});
