import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SkillManager } from "../../src/extension/skills/index.js";
import {
  EvoManager,
  KeywordCoverageEvaluator,
  classifyRisk,
  shouldAutoApply,
  buildProjectAdaptationSection,
} from "../../src/evo/index.js";
import type { EvoCandidate } from "../../src/evo/index.js";

const SKILL_BODY = `---
name: weather
description: Current weather and forecasts via wttr.in using curl.
---

# Weather

Use this skill to fetch weather. Run \`curl wttr.in\`.
`;

async function makeManager(): Promise<{
  pilotHome: string;
  projectKey: string;
  skillManager: SkillManager;
  evo: EvoManager;
}> {
  const pilotHome = await fs.mkdtemp(join(tmpdir(), "pilotdeck-evo-home-"));
  const projectKey = await fs.mkdtemp(join(tmpdir(), "pilotdeck-evo-proj-"));
  const skillManager = new SkillManager({ pilotHome });
  const evo = new EvoManager({ pilotHome, skillManager });
  return { pilotHome, projectKey, skillManager, evo };
}

async function seedUserSkill(skillManager: SkillManager): Promise<void> {
  await skillManager.create({ scope: "user", slug: "weather", content: SKILL_BODY });
}

describe("EvoManager — skill project adaptation", () => {
  let ctx: Awaited<ReturnType<typeof makeManager>>;

  beforeEach(async () => {
    ctx = await makeManager();
    await seedUserSkill(ctx.skillManager);
  });

  afterEach(async () => {
    await fs.rm(ctx.pilotHome, { recursive: true, force: true });
    await fs.rm(ctx.projectKey, { recursive: true, force: true });
  });

  it("proposes a low-risk additive candidate under manual policy and does not auto-apply", async () => {
    const result = await ctx.evo.start({
      projectKey: ctx.projectKey,
      target: { kind: "skill", scope: "user", slug: "weather" },
      policy: "manual",
      projectFacts: { testCommand: "npm run test", commonPaths: ["src/", "tests/"] },
      sourceCards: [{ id: "c1", kind: "project-wiki", title: "Project uses npm test" }],
    });

    const run = result.run;
    assert.ok(run, "run created");
    assert.equal(run.status, "ready");
    assert.equal(run.autoApplied, false);
    assert.equal(run.candidate.riskLevel, "low");
    assert.match(run.candidate.candidateContent, /Project Adaptation \(Evo\)/);
    assert.match(run.candidate.candidateContent, /npm run test/);
    // Base content must be unchanged on disk (candidate not applied).
    const read = await ctx.skillManager.read({ scope: "user", slug: "weather" });
    assert.doesNotMatch(read.content, /Project Adaptation/);
  });

  it("auto-applies a low-risk change under auto-low-risk policy and records rollback", async () => {
    const result = await ctx.evo.start({
      projectKey: ctx.projectKey,
      target: { kind: "skill", scope: "user", slug: "weather" },
      policy: "auto-low-risk",
      projectFacts: { testCommand: "npm run test" },
    });
    const run = result.run!;
    assert.equal(run.status, "applied");
    assert.equal(run.autoApplied, true);
    assert.ok(run.rollback, "rollback recorded");
    assert.equal(run.rollback!.createdByApply, false);
    // Disk now carries the adaptation.
    const read = await ctx.skillManager.read({ scope: "user", slug: "weather" });
    assert.match(read.content, /Project Adaptation \(Evo\)/);
  });

  it("evaluates baseline vs candidate and recommends apply when the candidate covers more", async () => {
    const result = await ctx.evo.start({
      projectKey: ctx.projectKey,
      target: { kind: "skill", scope: "user", slug: "weather" },
      policy: "manual",
      projectFacts: { testCommand: "vitest run", notes: "prefers JSON output" },
      evalSet: [
        { id: "e1", input: "how do I run tests", expected: ["vitest run"] },
        { id: "e2", input: "json", expected: ["JSON output"] },
      ],
    });
    const run = result.run!;
    assert.ok(run.report.eval, "eval report present");
    assert.ok(run.report.eval!.candidateScore > run.report.eval!.baselineScore);
    assert.equal(run.report.eval!.improved, true);
    assert.equal(run.report.recommendation, "apply");
  });

  it("supports the manual apply / discard lifecycle", async () => {
    const started = await ctx.evo.start({
      projectKey: ctx.projectKey,
      target: { kind: "skill", scope: "user", slug: "weather" },
      policy: "manual",
      projectFacts: { testCommand: "npm test" },
    });
    const runId = started.run!.runId;

    // Discard a sibling run does not affect this one — create a second.
    const applied = await ctx.evo.apply({ runId });
    assert.equal(applied.run!.status, "applied");
    const read = await ctx.skillManager.read({ scope: "user", slug: "weather" });
    assert.match(read.content, /npm test/);

    // Applying again is idempotent.
    const reapplied = await ctx.evo.apply({ runId });
    assert.equal(reapplied.run!.status, "applied");

    // Cannot discard an applied run.
    const discarded = await ctx.evo.discard({ runId });
    assert.ok(discarded.error);
    assert.equal(discarded.error!.code, "already_applied");
  });

  it("persists policy and lists runs via status", async () => {
    await ctx.evo.start({
      projectKey: ctx.projectKey,
      target: { kind: "skill", scope: "user", slug: "weather" },
      policy: "auto-all",
      projectFacts: { testCommand: "npm test" },
    });
    const status = await ctx.evo.status({ projectKey: ctx.projectKey });
    assert.equal(status.policy, "auto-all");
    assert.equal(status.runs.length, 1);
    assert.equal(status.runs[0].target.kind, "skill");
  });

  it("rejects a no-op candidate when no facts are supplied", async () => {
    const result = await ctx.evo.start({
      projectKey: ctx.projectKey,
      target: { kind: "skill", scope: "user", slug: "weather" },
      policy: "auto-all",
    });
    const run = result.run!;
    assert.equal(run.report.recommendation, "reject");
    assert.equal(run.status, "ready");
    assert.equal(run.autoApplied, false);
  });
});

describe("EvoManager — harness target", () => {
  let ctx: Awaited<ReturnType<typeof makeManager>>;

  beforeEach(async () => {
    ctx = await makeManager();
  });

  afterEach(async () => {
    await fs.rm(ctx.pilotHome, { recursive: true, force: true });
    await fs.rm(ctx.projectKey, { recursive: true, force: true });
  });

  it("auto-applies a medium-risk router rule under auto-all and writes the config", async () => {
    const candidate = JSON.stringify({ rules: [{ match: "tests", model: "fast" }] }, null, 2);
    const result = await ctx.evo.start({
      projectKey: ctx.projectKey,
      target: { kind: "harness", configKey: "router" },
      policy: "auto-all",
      candidateContent: candidate,
      hypothesis: "Route test-running tasks to the fast model.",
    });
    const run = result.run!;
    assert.equal(run.candidate.riskLevel, "medium");
    assert.equal(run.status, "applied");
    const path = join(ctx.projectKey, ".pilotdeck", "evo", "harness", "router.json");
    const written = await fs.readFile(path, "utf8");
    assert.equal(written, candidate);
  });

  it("does not auto-apply a medium-risk change under auto-low-risk policy", async () => {
    const result = await ctx.evo.start({
      projectKey: ctx.projectKey,
      target: { kind: "harness", configKey: "tool-policy" },
      policy: "auto-low-risk",
      candidateContent: JSON.stringify({ preferEarly: ["grep"] }),
      hypothesis: "Use grep earlier.",
    });
    const run = result.run!;
    assert.equal(run.candidate.riskLevel, "medium");
    assert.equal(run.status, "ready");
    assert.equal(run.autoApplied, false);
  });
});

describe("policy.shouldAutoApply", () => {
  it("never auto-applies high risk", () => {
    for (const mode of ["manual", "auto-low-risk", "auto-all"] as const) {
      assert.equal(shouldAutoApply(mode, "high"), false);
    }
  });
  it("manual never auto-applies", () => {
    assert.equal(shouldAutoApply("manual", "low"), false);
    assert.equal(shouldAutoApply("manual", "medium"), false);
  });
  it("auto-low-risk applies only low", () => {
    assert.equal(shouldAutoApply("auto-low-risk", "low"), true);
    assert.equal(shouldAutoApply("auto-low-risk", "medium"), false);
  });
  it("auto-all applies low and medium", () => {
    assert.equal(shouldAutoApply("auto-all", "low"), true);
    assert.equal(shouldAutoApply("auto-all", "medium"), true);
  });
});

describe("policy.classifyRisk", () => {
  function skillCandidate(base: string, next: string): EvoCandidate {
    return { baseContent: base, candidateContent: next, hypothesis: "", riskLevel: "low", riskNotes: [] };
  }

  it("grades a pure frontmatter change as low", () => {
    const base = "---\nname: a\ndescription: short desc here for skill\n---\n\nbody text\n";
    const next = "---\nname: a\ndescription: a much better and longer description\n---\n\nbody text\n";
    const r = classifyRisk({ kind: "skill", scope: "user", slug: "a" }, skillCandidate(base, next));
    assert.equal(r.level, "low");
  });

  it("grades an additive body append as low", () => {
    const base = "---\nname: a\ndescription: d\n---\n\nbody text\n";
    const next = "---\nname: a\ndescription: d\n---\n\nbody text\n\n## Project Adaptation (Evo)\n\n- x\n";
    const r = classifyRisk({ kind: "skill", scope: "user", slug: "a" }, skillCandidate(base, next));
    assert.equal(r.level, "low");
  });

  it("grades a body rewrite as medium", () => {
    const base = "---\nname: a\ndescription: d\n---\n\noriginal flow\n";
    const next = "---\nname: a\ndescription: d\n---\n\ncompletely different flow\n";
    const r = classifyRisk({ kind: "skill", scope: "user", slug: "a" }, skillCandidate(base, next));
    assert.equal(r.level, "medium");
  });

  it("grades known harness categories as medium", () => {
    const c = skillCandidate("{}", '{"x":1}');
    assert.equal(classifyRisk({ kind: "harness", configKey: "router" }, c).level, "medium");
    assert.equal(classifyRisk({ kind: "harness", configKey: "prompt-fragment" }, c).level, "medium");
  });
});

describe("KeywordCoverageEvaluator", () => {
  it("scores keyword coverage and computes delta", async () => {
    const evaluator = new KeywordCoverageEvaluator();
    const report = await evaluator.evaluate({
      baseContent: "alpha",
      candidateContent: "alpha beta",
      evalSet: [
        { id: "1", input: "x", expected: ["alpha", "beta"] },
        { id: "2", input: "y", expected: ["gamma"] },
      ],
    });
    assert.equal(report.itemCount, 2);
    // item1: base 0.5, candidate 1.0; item2: base 0, candidate 0.
    assert.equal(report.baselineScore, 0.25);
    assert.equal(report.candidateScore, 0.5);
    assert.equal(report.delta, 0.25);
    assert.equal(report.improved, true);
    assert.equal(report.baselineErrorRate, 0.5);
    assert.equal(report.candidateErrorRate, 0.5);
  });
});

describe("buildProjectAdaptationSection", () => {
  it("returns null when there is nothing concrete to add", () => {
    assert.equal(buildProjectAdaptationSection(undefined), null);
    assert.equal(buildProjectAdaptationSection({}), null);
  });
  it("renders supplied facts", () => {
    const section = buildProjectAdaptationSection({ testCommand: "npm test", commonPaths: ["src/"] });
    assert.ok(section);
    assert.match(section!, /npm test/);
    assert.match(section!, /src\//);
  });
});
