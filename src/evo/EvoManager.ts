/**
 * EvoManager — orchestrates the Evo flow described in the plan:
 *
 *   discover → ground → propose candidate → evaluate (baseline vs candidate)
 *   → grade risk → decide by project policy → apply / wait for approval → record.
 *
 * It reuses `SkillManager` for skill targets (snapshot via `read`, validate via
 * `validate`, apply via `write`) and owns harness-config targets directly,
 * writing candidate config under `<project>/.pilotdeck/evo/harness/`. It never
 * touches ProjectWiki, harness core code, or executable scripts — those are
 * out of scope by design.
 */

import { promises as fs } from "node:fs";
import { randomUUID } from "node:crypto";
import { join, resolve } from "node:path";

import type { SkillManager } from "../extension/skills/index.js";
import { getPilotExtensionPaths } from "../pilot/paths.js";
import { EvoStore } from "./EvoStore.js";
import { KeywordCoverageEvaluator, type EvoEvaluator } from "./EvoEvalRunner.js";
import { HeuristicProposer, type EvoProposer } from "./proposer.js";
import { classifyRisk, shouldAutoApply } from "./policy.js";
import { renderReportMarkdown } from "./reportMarkdown.js";
import type {
  EvoApplyInput,
  EvoApplyResult,
  EvoCandidate,
  EvoDiscardInput,
  EvoDiscardResult,
  EvoHarnessTarget,
  EvoRecommendation,
  EvoReport,
  EvoReportInput,
  EvoReportResult,
  EvoRun,
  EvoRunSummary,
  EvoSkillTarget,
  EvoStartInput,
  EvoStartResult,
  EvoStatusInput,
  EvoStatusResult,
  EvoTarget,
} from "./protocol/types.js";

export class EvoManagerError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = "EvoManagerError";
  }
}

export type EvoManagerOptions = {
  pilotHome: string;
  skillManager: SkillManager;
  proposer?: EvoProposer;
  evaluator?: EvoEvaluator;
  now?: () => Date;
  uuid?: () => string;
};

export class EvoManager {
  private readonly pilotHome: string;
  private readonly skillManager: SkillManager;
  private readonly proposer: EvoProposer;
  private readonly evaluator: EvoEvaluator;
  private readonly store: EvoStore;
  private readonly now: () => Date;
  private readonly uuid: () => string;

  constructor(options: EvoManagerOptions) {
    this.pilotHome = resolve(options.pilotHome);
    this.skillManager = options.skillManager;
    this.proposer = options.proposer ?? new HeuristicProposer();
    this.evaluator = options.evaluator ?? new KeywordCoverageEvaluator();
    this.store = new EvoStore(this.pilotHome);
    this.now = options.now ?? (() => new Date());
    this.uuid = options.uuid ?? (() => randomUUID());
  }

  // -------------------------------------------------------------------
  // Start: generate a candidate, evaluate it, and apply if policy allows.
  // -------------------------------------------------------------------

  async start(input: EvoStartInput): Promise<EvoStartResult> {
    if (!input || !input.target) {
      return { run: null, error: { code: "invalid_input", message: "target is required." } };
    }
    const projectKey = input.projectKey ?? input.target.projectKey ?? null;

    // Persist policy override if supplied, then resolve the effective policy.
    if (input.policy) {
      await this.store.setPolicy(projectKey, input.policy);
    }
    const policy = input.policy ?? (await this.store.getPolicy(projectKey));

    // 1. Snapshot the base content.
    let baseContent: string;
    try {
      baseContent = await this.snapshot(input.target, projectKey);
    } catch (e) {
      return {
        run: null,
        error: { code: (e as EvoManagerError).code ?? "snapshot_failed", message: (e as Error).message },
      };
    }

    // 2. Propose a candidate.
    const proposed = await this.proposer.propose({
      target: input.target,
      baseContent,
      projectFacts: input.projectFacts,
      sourceCards: input.sourceCards,
      hypothesis: input.hypothesis,
      candidateContent: input.candidateContent,
    });

    // 3. Grade risk.
    const risk = classifyRisk(input.target, {
      ...proposed,
      riskLevel: "low",
      riskNotes: [],
    });
    const candidate: EvoCandidate = {
      baseContent: proposed.baseContent,
      candidateContent: proposed.candidateContent,
      hypothesis: proposed.hypothesis,
      riskLevel: risk.level,
      riskNotes: risk.notes,
    };

    const noChange = candidate.baseContent === candidate.candidateContent;

    // 4. Evaluate baseline vs candidate (when an eval set was supplied).
    const evalReport = input.evalSet && input.evalSet.length > 0
      ? await this.evaluator.evaluate({
          baseContent: candidate.baseContent,
          candidateContent: candidate.candidateContent,
          evalSet: input.evalSet,
        })
      : null;

    // 5. Recommendation.
    const recommendation: EvoRecommendation = noChange
      ? "reject"
      : evalReport
        ? evalReport.delta > 0
          ? "apply"
          : evalReport.delta < 0
            ? "reject"
            : "review"
        : "review";

    const createdAt = this.now().toISOString();
    const runId = this.uuid();
    const report: EvoReport = {
      runId,
      target: input.target,
      hypothesis: candidate.hypothesis,
      sourceCards: input.sourceCards ?? [],
      riskLevel: candidate.riskLevel,
      riskNotes: candidate.riskNotes,
      eval: evalReport,
      recommendation,
      createdAt,
    };

    const run: EvoRun = {
      runId,
      projectKey,
      target: input.target,
      status: "ready",
      policy,
      reason: input.reason ?? candidate.hypothesis,
      candidate,
      report,
      rollback: null,
      autoApplied: false,
      createdAt,
      updatedAt: createdAt,
    };

    // 6. Auto-apply when policy + risk + recommendation allow it.
    if (!noChange && recommendation !== "reject" && shouldAutoApply(policy, candidate.riskLevel)) {
      try {
        await this.applyToTarget(run);
        run.status = "applied";
        run.autoApplied = true;
        run.appliedAt = this.now().toISOString();
      } catch (e) {
        run.status = "failed";
        run.error = {
          code: (e as EvoManagerError).code ?? "apply_failed",
          message: (e as Error).message,
        };
      }
      run.updatedAt = this.now().toISOString();
    }

    await this.store.saveRun(run);
    return { run };
  }

  // -------------------------------------------------------------------
  // Status / report / apply / discard.
  // -------------------------------------------------------------------

  async status(input: EvoStatusInput): Promise<EvoStatusResult> {
    if (input.runId) {
      const run = await this.store.getRun(input.runId);
      const policy = await this.store.getPolicy(run?.projectKey ?? input.projectKey ?? null);
      return { run, runs: run ? [toSummary(run)] : [], policy };
    }
    const projectKey = input.projectKey ?? null;
    const all = await this.store.listRuns();
    const filtered = projectKey
      ? all.filter((r) => (r.projectKey ? resolve(r.projectKey) : null) === resolve(projectKey))
      : all;
    const policy = await this.store.getPolicy(projectKey);
    return { run: null, runs: filtered.map(toSummary), policy };
  }

  async report(input: EvoReportInput): Promise<EvoReportResult> {
    const run = await this.store.getRun(input.runId);
    if (!run) {
      return { report: null, markdown: "", error: { code: "not_found", message: `No Evo run ${input.runId}.` } };
    }
    return { report: run.report, markdown: renderReportMarkdown(run) };
  }

  async apply(input: EvoApplyInput): Promise<EvoApplyResult> {
    const run = await this.store.getRun(input.runId);
    if (!run) {
      return { run: null, error: { code: "not_found", message: `No Evo run ${input.runId}.` } };
    }
    if (run.status === "applied") {
      return { run };
    }
    if (run.status === "discarded") {
      return { run, error: { code: "discarded", message: "Run was discarded; cannot apply." } };
    }
    if (run.candidate.baseContent === run.candidate.candidateContent) {
      return { run, error: { code: "no_change", message: "Candidate is identical to the base; nothing to apply." } };
    }
    try {
      await this.applyToTarget(run);
      run.status = "applied";
      run.appliedAt = this.now().toISOString();
      run.updatedAt = run.appliedAt;
      await this.store.saveRun(run);
      return { run };
    } catch (e) {
      run.status = "failed";
      run.error = { code: (e as EvoManagerError).code ?? "apply_failed", message: (e as Error).message };
      run.updatedAt = this.now().toISOString();
      await this.store.saveRun(run);
      return { run, error: run.error };
    }
  }

  async discard(input: EvoDiscardInput): Promise<EvoDiscardResult> {
    const run = await this.store.getRun(input.runId);
    if (!run) {
      return { run: null, error: { code: "not_found", message: `No Evo run ${input.runId}.` } };
    }
    if (run.status === "applied") {
      return { run, error: { code: "already_applied", message: "Run was already applied." } };
    }
    run.status = "discarded";
    run.discardedAt = this.now().toISOString();
    run.updatedAt = run.discardedAt;
    await this.store.saveRun(run);
    return { run };
  }

  async getPolicy(projectKey: string | null | undefined): Promise<import("./protocol/types.js").EvoPolicyMode> {
    return this.store.getPolicy(projectKey ?? null);
  }

  // -------------------------------------------------------------------
  // Target IO.
  // -------------------------------------------------------------------

  private async snapshot(target: EvoTarget, projectKey: string | null): Promise<string> {
    if (target.kind === "skill") {
      try {
        const result = await this.skillManager.read({
          scope: target.scope,
          slug: target.slug,
          projectKey: target.projectKey ?? projectKey,
        });
        return result.content;
      } catch (e) {
        if ((e as { code?: string }).code === "not_found") {
          // A brand-new skill being adapted before it exists — start empty.
          return "";
        }
        throw e;
      }
    }
    return this.readHarnessConfig(target, projectKey);
  }

  private async applyToTarget(run: EvoRun): Promise<void> {
    if (run.target.kind === "skill") {
      await this.applySkill(run, run.target);
      return;
    }
    await this.applyHarness(run, run.target);
  }

  private async applySkill(run: EvoRun, target: EvoSkillTarget): Promise<void> {
    // Validate the candidate is a well-formed SKILL.md before writing.
    const validation = await this.skillManager.validate({
      skillMdContent: run.candidate.candidateContent,
      files: [{ relativePath: "SKILL.md", size: Buffer.byteLength(run.candidate.candidateContent) }],
    });
    if (!validation.ok) {
      const reasons = validation.hardFails.map((h) => h.message).join("; ");
      throw new EvoManagerError("validation_failed", `Candidate SKILL.md failed validation: ${reasons}`);
    }
    const projectKey = target.projectKey ?? run.projectKey;
    const existed = run.candidate.baseContent.length > 0;
    run.rollback = { previousContent: run.candidate.baseContent, createdByApply: !existed };
    await this.skillManager.write({
      scope: target.scope,
      slug: target.slug,
      projectKey,
      content: run.candidate.candidateContent,
    });
  }

  private async applyHarness(run: EvoRun, target: EvoHarnessTarget): Promise<void> {
    const path = this.harnessConfigPath(target, target.projectKey ?? run.projectKey);
    let existed = false;
    try {
      await fs.access(path);
      existed = true;
    } catch {
      /* not present */
    }
    run.rollback = { previousContent: run.candidate.baseContent, createdByApply: !existed };
    await fs.mkdir(join(path, ".."), { recursive: true });
    await fs.writeFile(path, run.candidate.candidateContent, "utf8");
  }

  private async readHarnessConfig(target: EvoHarnessTarget, projectKey: string | null): Promise<string> {
    const path = this.harnessConfigPath(target, target.projectKey ?? projectKey);
    try {
      return await fs.readFile(path, "utf8");
    } catch {
      return "";
    }
  }

  private harnessConfigPath(target: EvoHarnessTarget, projectKey: string | null): string {
    const root = projectKey
      ? join(getPilotExtensionPaths(projectKey, this.pilotHome).projectSkillsDir, "..", "evo", "harness")
      : join(this.pilotHome, "evo", "harness");
    return resolve(root, `${target.configKey}.json`);
  }
}

function toSummary(run: EvoRun): EvoRunSummary {
  return {
    runId: run.runId,
    projectKey: run.projectKey,
    target: run.target,
    status: run.status,
    riskLevel: run.candidate.riskLevel,
    recommendation: run.report.recommendation,
    hypothesis: run.candidate.hypothesis,
    autoApplied: run.autoApplied,
    createdAt: run.createdAt,
    updatedAt: run.updatedAt,
  };
}
