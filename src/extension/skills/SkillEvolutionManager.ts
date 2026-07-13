import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

import { getPilotExtensionPaths } from "../../pilot/paths.js";
import { SkillManager, SkillManagerError, SkillValidationError } from "./SkillManager.js";
import type {
  SkillEvolutionApplyInput,
  SkillEvolutionApplyResult,
  SkillEvolutionEvent,
  SkillEvolutionFeedbackOutcome,
  SkillEvolutionGenerator,
  SkillEvolutionProposalSummary,
  SkillEvolutionProposeInput,
  SkillEvolutionProposeResult,
  SkillEvolutionRecordInput,
  SkillEvolutionRecordResult,
  SkillEvolutionRevisionSummary,
  SkillEvolutionRollbackInput,
  SkillEvolutionRollbackResult,
  SkillEvolutionSkillStatus,
  SkillEvolutionStats,
  SkillEvolutionStatusInput,
  SkillEvolutionStatusResult,
} from "./skillEvolutionTypes.js";
import type { SkillAddressInput } from "./types.js";

const EVO_DIR = ".evo";
const EVENT_LOG = "events.jsonl";
const DEFAULT_STATUS_LIMIT = 20;
const MAX_STATUS_LIMIT = 100;
const MAX_FEEDBACK_CHARS = 8_000;
const MAX_INSTRUCTIONS_CHARS = 8_000;
const MAX_MODEL_SKILL_CHARS = 512_000;
const STALE_LOCK_MS = 10 * 60_000;

type SkillEvolutionProposalRecord = SkillEvolutionProposalSummary & {
  candidateContent: string;
};

type SkillEvolutionRevisionRecord = SkillEvolutionRevisionSummary & {
  content: string;
};

export type SkillEvolutionManagerOptions = {
  pilotHome: string;
  skillManager: SkillManager;
  generator?: SkillEvolutionGenerator;
  now?: () => Date;
  uuid?: () => string;
};

/**
 * Hermes-inspired, consent-first skill evolution.
 *
 * Operational telemetry is kept in a sidecar JSONL log, while model-generated
 * revisions are staged as proposals. Applying a proposal always snapshots the
 * previous SKILL.md and uses an optimistic base hash so a human edit cannot be
 * overwritten silently.
 */
export class SkillEvolutionManager {
  private readonly pilotHome: string;
  private readonly skillManager: SkillManager;
  private readonly generator?: SkillEvolutionGenerator;
  private readonly now: () => Date;
  private readonly uuid: () => string;

  constructor(options: SkillEvolutionManagerOptions) {
    this.pilotHome = resolve(options.pilotHome);
    this.skillManager = options.skillManager;
    this.generator = options.generator;
    this.now = options.now ?? (() => new Date());
    this.uuid = options.uuid ?? randomUUID;
  }

  /** Best-effort callers (such as read_skill) should catch failures. */
  async recordUse(input: SkillAddressInput & { sessionKey?: string }): Promise<SkillEvolutionEvent> {
    await this.skillManager.read(input);
    const event = this.newEvent(input, "used", { sessionKey: normalizeOptionalText(input.sessionKey, 512, "sessionKey") });
    await this.appendEvent(input, event);
    return event;
  }

  async record(input: SkillEvolutionRecordInput): Promise<SkillEvolutionRecordResult> {
    await this.skillManager.read(input);
    assertOutcome(input.outcome);
    const event = this.newEvent(input, "feedback", {
      outcome: input.outcome,
      feedback: normalizeOptionalText(input.feedback, MAX_FEEDBACK_CHARS, "feedback"),
      sessionKey: normalizeOptionalText(input.sessionKey, 512, "sessionKey"),
    });
    await this.appendEvent(input, event);
    return { ok: true, event };
  }

  async status(input: SkillEvolutionStatusInput = {}): Promise<SkillEvolutionStatusResult> {
    const limit = clampLimit(input.limit);
    const projectKey = input.projectKey ?? null;
    if (input.scope === "project" && !projectKey) {
      throw new SkillManagerError("project_required", "Project scope requires projectKey.");
    }
    const listed = await this.skillManager.list({ projectKey });
    const candidates = [
      ...listed.user.map((skill) => ({ skill, address: { scope: "user" as const, slug: skill.slug } })),
      ...listed.project.map((skill) => ({
        skill,
        address: { scope: "project" as const, slug: skill.slug, projectKey: listed.projectPath },
      })),
    ].filter(({ address }) =>
      (input.scope === undefined || address.scope === input.scope)
      && (input.slug === undefined || address.slug === input.slug));

    if (input.slug && candidates.length === 0) {
      throw new SkillManagerError(
        "not_found",
        `Skill "${input.slug}" was not found${input.scope ? ` in ${input.scope} scope` : ""}.`,
      );
    }

    const skills: SkillEvolutionSkillStatus[] = [];
    const eventCache = new Map<string, Promise<SkillEvolutionEvent[]>>();
    const proposalCache = new Map<string, Promise<SkillEvolutionProposalRecord[]>>();
    for (const { skill, address } of candidates) {
      const storeKey = this.evolutionRoot(address);
      const allEvents = eventCache.get(storeKey) ?? this.readAllEvents(address);
      const allProposals = proposalCache.get(storeKey) ?? this.readAllProposals(address);
      eventCache.set(storeKey, allEvents);
      proposalCache.set(storeKey, allProposals);
      const [storeEvents, storeProposals, revisions] = await Promise.all([
        allEvents,
        allProposals,
        this.readRevisions(address),
      ]);
      const events = storeEvents.filter(
        (event) => event.scope === address.scope && event.slug === address.slug,
      );
      const proposals = storeProposals
        .filter((proposal) => proposal.scope === address.scope && proposal.slug === address.slug)
        .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      skills.push({
        skill,
        stats: aggregateStats(events),
        recentEvents: events.slice(-limit).reverse(),
        proposals: proposals.slice(0, limit).map(toProposalSummary),
        revisions: revisions.slice(0, limit).map(toRevisionSummary),
      });
    }
    return { skills, projectPath: listed.projectPath };
  }

  async propose(input: SkillEvolutionProposeInput): Promise<SkillEvolutionProposeResult> {
    if (!this.generator) {
      throw new SkillManagerError(
        "evolution_not_configured",
        "Skill evolution requires a configured model generator.",
      );
    }
    const current = await this.skillManager.read(input);
    if (current.content.length > MAX_MODEL_SKILL_CHARS) {
      throw new SkillManagerError(
        "evolution_skill_too_large",
        `SKILL.md is too large for an evolution pass (${current.content.length} chars; max ${MAX_MODEL_SKILL_CHARS}).`,
      );
    }

    const feedback = normalizeOptionalText(input.feedback, MAX_FEEDBACK_CHARS, "feedback");
    if (feedback) {
      await this.record({
        scope: input.scope,
        slug: input.slug,
        projectKey: input.projectKey,
        outcome: input.outcome ?? "correction",
        feedback,
        sessionKey: input.sessionKey,
      });
    } else if (input.outcome !== undefined) {
      throw new SkillManagerError("invalid_input", "outcome requires feedback.");
    }

    const events = await this.readEvents(input);
    const instructions = normalizeOptionalText(
      input.instructions,
      MAX_INSTRUCTIONS_CHARS,
      "instructions",
    );
    const draft = await this.generator({
      scope: input.scope,
      slug: input.slug,
      projectKey: input.scope === "project" ? resolveProjectKey(input.projectKey) : null,
      currentContent: current.content,
      stats: aggregateStats(events),
      recentEvents: events.slice(-20),
      instructions,
    });
    const candidateContent = normalizeDraftContent(draft.content);
    if (hashContent(candidateContent) === hashContent(current.content)) {
      throw new SkillManagerError("evolution_no_change", "The evolution pass did not change SKILL.md.");
    }
    const validation = await this.skillManager.validate({
      skillMdContent: candidateContent,
      files: [{ relativePath: "SKILL.md", size: Buffer.byteLength(candidateContent) }],
    });
    if (!validation.ok) throw new SkillValidationError(validation);

    const createdAt = this.now().toISOString();
    const record: SkillEvolutionProposalRecord = {
      id: makeId("proposal", createdAt, this.uuid()),
      scope: input.scope,
      slug: input.slug,
      projectKey: input.scope === "project" ? resolveProjectKey(input.projectKey) : null,
      createdAt,
      summary: normalizeRequiredText(draft.summary, 1_000, "summary"),
      rationale: normalizeRequiredText(draft.rationale, 4_000, "rationale"),
      baseHash: hashContent(current.content),
      candidateHash: hashContent(candidateContent),
      status: "pending",
      candidateContent,
    };
    await this.writeProposal(input, record);
    return { proposal: toProposalSummary(record), candidateContent };
  }

  async apply(input: SkillEvolutionApplyInput): Promise<SkillEvolutionApplyResult> {
    validateEntityId(input.proposalId, "proposalId");
    await this.skillManager.read(input);
    return this.withSkillLock(input, async () => {
      const proposal = await this.readProposal(input, input.proposalId);
      if (proposal.status !== "pending") {
        throw new SkillManagerError(
          "evolution_proposal_not_pending",
          `Proposal ${proposal.id} is ${proposal.status}, not pending.`,
        );
      }
      assertProposalAddress(proposal, input);
      const current = await this.skillManager.read(input);
      const currentHash = hashContent(current.content);
      if (!input.force && currentHash !== proposal.baseHash) {
        throw new SkillManagerError(
          "evolution_conflict",
          "SKILL.md changed after this proposal was generated. Generate a new proposal or use force=true.",
        );
      }
      const validation = await this.skillManager.validate({
        skillMdContent: proposal.candidateContent,
        files: [{ relativePath: "SKILL.md", size: Buffer.byteLength(proposal.candidateContent) }],
      });
      if (!validation.ok) throw new SkillValidationError(validation);

      const revision = await this.saveRevision(input, {
        reason: "apply",
        content: current.content,
        sourceProposalId: proposal.id,
      });
      const result = await this.skillManager.write({ ...input, content: proposal.candidateContent });
      proposal.status = "applied";
      proposal.appliedAt = this.now().toISOString();
      proposal.revisionId = revision.id;
      await this.writeProposal(input, proposal);
      await this.supersedePendingProposals(input, proposal.id);
      await this.appendEvent(
        input,
        this.newEvent(input, "applied", { proposalId: proposal.id, revisionId: revision.id }),
      );
      return {
        ok: true,
        proposal: toProposalSummary(proposal),
        revision: toRevisionSummary(revision),
        skill: result.skill,
      };
    });
  }

  async rollback(input: SkillEvolutionRollbackInput): Promise<SkillEvolutionRollbackResult> {
    if (input.revisionId) validateEntityId(input.revisionId, "revisionId");
    await this.skillManager.read(input);
    return this.withSkillLock(input, async () => {
      const current = await this.skillManager.read(input);
      const revisions = await this.readRevisions(input);
      const target = input.revisionId
        ? revisions.find((revision) => revision.id === input.revisionId)
        : revisions[0];
      if (!target) {
        throw new SkillManagerError(
          "evolution_revision_not_found",
          input.revisionId
            ? `Revision ${input.revisionId} was not found.`
            : `No evolution revisions exist for ${input.scope}/${input.slug}.`,
        );
      }

      const safetyRevision = await this.saveRevision(input, {
        reason: "rollback-safety",
        content: current.content,
      });
      const result = await this.skillManager.write({ ...input, content: target.content });
      if (target.sourceProposalId) {
        const proposal = await this.readProposal(input, target.sourceProposalId).catch(() => undefined);
        if (proposal) {
          proposal.status = "rolled_back";
          await this.writeProposal(input, proposal);
        }
      }
      await this.appendEvent(
        input,
        this.newEvent(input, "rolled_back", {
          proposalId: target.sourceProposalId,
          revisionId: target.id,
        }),
      );
      return {
        ok: true,
        rolledBackToRevisionId: target.id,
        safetyRevision: toRevisionSummary(safetyRevision),
        skill: result.skill,
      };
    });
  }

  private newEvent(
    input: SkillAddressInput,
    type: SkillEvolutionEvent["type"],
    extra: Partial<SkillEvolutionEvent>,
  ): SkillEvolutionEvent {
    return {
      id: this.uuid(),
      type,
      at: this.now().toISOString(),
      scope: input.scope,
      slug: input.slug,
      ...extra,
    };
  }

  private evolutionRoot(input: Pick<SkillAddressInput, "scope" | "projectKey">): string {
    if (input.scope === "project") {
      const projectKey = resolveProjectKey(input.projectKey);
      return join(getPilotExtensionPaths(projectKey, this.pilotHome).projectSkillsDir, EVO_DIR);
    }
    return join(getPilotExtensionPaths(this.pilotHome, this.pilotHome).globalSkillsDir, EVO_DIR);
  }

  private async appendEvent(input: SkillAddressInput, event: SkillEvolutionEvent): Promise<void> {
    const root = this.evolutionRoot(input);
    await fs.mkdir(root, { recursive: true });
    await fs.appendFile(join(root, EVENT_LOG), `${JSON.stringify(event)}\n`, "utf8");
  }

  private async readEvents(input: SkillAddressInput): Promise<SkillEvolutionEvent[]> {
    return (await this.readAllEvents(input)).filter(
      (event) => event.scope === input.scope && event.slug === input.slug,
    );
  }

  private async readAllEvents(input: Pick<SkillAddressInput, "scope" | "projectKey">): Promise<SkillEvolutionEvent[]> {
    let raw: string;
    try {
      raw = await fs.readFile(join(this.evolutionRoot(input), EVENT_LOG), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw error;
    }
    const events: SkillEvolutionEvent[] = [];
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line) as SkillEvolutionEvent;
        if (typeof event.scope === "string" && typeof event.slug === "string" && typeof event.at === "string") {
          events.push(event);
        }
      } catch {
        // A partial/corrupt line must not make the skill unusable.
      }
    }
    events.sort((a, b) => a.at.localeCompare(b.at));
    return events;
  }

  private proposalPath(input: SkillAddressInput, proposalId: string): string {
    return join(this.evolutionRoot(input), "proposals", `${proposalId}.json`);
  }

  private async writeProposal(input: SkillAddressInput, proposal: SkillEvolutionProposalRecord): Promise<void> {
    await atomicWriteJson(this.proposalPath(input, proposal.id), proposal);
  }

  private async readProposal(input: SkillAddressInput, proposalId: string): Promise<SkillEvolutionProposalRecord> {
    try {
      return JSON.parse(await fs.readFile(this.proposalPath(input, proposalId), "utf8")) as SkillEvolutionProposalRecord;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new SkillManagerError("evolution_proposal_not_found", `Proposal ${proposalId} was not found.`);
      }
      throw error;
    }
  }

  private async readProposals(input: SkillAddressInput): Promise<SkillEvolutionProposalRecord[]> {
    return (await this.readAllProposals(input))
      .filter((record) => record.scope === input.scope && record.slug === input.slug)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  private async readAllProposals(
    input: Pick<SkillAddressInput, "scope" | "projectKey">,
  ): Promise<SkillEvolutionProposalRecord[]> {
    const dir = join(this.evolutionRoot(input), "proposals");
    return readJsonDirectory<SkillEvolutionProposalRecord>(dir);
  }

  private async supersedePendingProposals(input: SkillAddressInput, appliedId: string): Promise<void> {
    const proposals = await this.readProposals(input);
    await Promise.all(proposals.map(async (proposal) => {
      if (proposal.id === appliedId || proposal.status !== "pending") return;
      proposal.status = "superseded";
      await this.writeProposal(input, proposal);
    }));
  }

  private async saveRevision(
    input: SkillAddressInput,
    value: Pick<SkillEvolutionRevisionRecord, "reason" | "content" | "sourceProposalId">,
  ): Promise<SkillEvolutionRevisionRecord> {
    const createdAt = this.now().toISOString();
    const revision: SkillEvolutionRevisionRecord = {
      id: makeId("revision", createdAt, this.uuid()),
      scope: input.scope,
      slug: input.slug,
      createdAt,
      reason: value.reason,
      contentHash: hashContent(value.content),
      content: value.content,
      ...(value.sourceProposalId ? { sourceProposalId: value.sourceProposalId } : {}),
    };
    const path = join(this.evolutionRoot(input), "revisions", input.slug, `${revision.id}.json`);
    await atomicWriteJson(path, revision);
    return revision;
  }

  private async readRevisions(input: SkillAddressInput): Promise<SkillEvolutionRevisionRecord[]> {
    const dir = join(this.evolutionRoot(input), "revisions", input.slug);
    const records = await readJsonDirectory<SkillEvolutionRevisionRecord>(dir);
    return records
      .filter((record) => record.scope === input.scope && record.slug === input.slug)
      .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  private async withSkillLock<T>(input: SkillAddressInput, work: () => Promise<T>): Promise<T> {
    const lockPath = join(this.evolutionRoot(input), "locks", `${input.slug}.lock`);
    await fs.mkdir(dirname(lockPath), { recursive: true });
    let handle: Awaited<ReturnType<typeof fs.open>> | undefined;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        handle = await fs.open(lockPath, "wx");
        await handle.writeFile(JSON.stringify({ pid: process.pid, at: this.now().toISOString() }));
        break;
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        const stale = await isStaleLock(lockPath, this.now().getTime());
        if (stale && attempt === 0) {
          await fs.rm(lockPath, { force: true });
          continue;
        }
        throw new SkillManagerError(
          "evolution_busy",
          `Another evolution operation is already running for ${input.scope}/${input.slug}.`,
        );
      }
    }
    if (!handle) throw new SkillManagerError("evolution_busy", "Could not acquire the skill evolution lock.");
    try {
      return await work();
    } finally {
      await handle.close().catch(() => undefined);
      await fs.rm(lockPath, { force: true }).catch(() => undefined);
    }
  }
}

function aggregateStats(events: SkillEvolutionEvent[]): SkillEvolutionStats {
  const stats: SkillEvolutionStats = {
    useCount: 0,
    successCount: 0,
    failureCount: 0,
    correctionCount: 0,
    applyCount: 0,
    rollbackCount: 0,
    lastUsedAt: null,
    lastFeedbackAt: null,
    lastEvolvedAt: null,
  };
  for (const event of events) {
    if (event.type === "used") {
      stats.useCount += 1;
      stats.lastUsedAt = newer(stats.lastUsedAt, event.at);
    } else if (event.type === "feedback") {
      if (event.outcome === "success") stats.successCount += 1;
      if (event.outcome === "failure") stats.failureCount += 1;
      if (event.outcome === "correction") stats.correctionCount += 1;
      stats.lastFeedbackAt = newer(stats.lastFeedbackAt, event.at);
    } else if (event.type === "applied") {
      stats.applyCount += 1;
      stats.lastEvolvedAt = newer(stats.lastEvolvedAt, event.at);
    } else if (event.type === "rolled_back") {
      stats.rollbackCount += 1;
      stats.lastEvolvedAt = newer(stats.lastEvolvedAt, event.at);
    }
  }
  return stats;
}

function newer(current: string | null, candidate: string): string {
  return current === null || candidate > current ? candidate : current;
}

function toProposalSummary(record: SkillEvolutionProposalRecord): SkillEvolutionProposalSummary {
  const { candidateContent: _candidateContent, ...summary } = record;
  return summary;
}

function toRevisionSummary(record: SkillEvolutionRevisionRecord): SkillEvolutionRevisionSummary {
  const { content: _content, ...summary } = record;
  return summary;
}

function assertOutcome(value: unknown): asserts value is SkillEvolutionFeedbackOutcome {
  if (value !== "success" && value !== "failure" && value !== "correction") {
    throw new SkillManagerError(
      "invalid_input",
      "outcome must be success, failure, or correction.",
    );
  }
}

function assertProposalAddress(record: SkillEvolutionProposalRecord, input: SkillAddressInput): void {
  const projectKey = input.scope === "project" ? resolveProjectKey(input.projectKey) : null;
  if (record.scope !== input.scope || record.slug !== input.slug || record.projectKey !== projectKey) {
    throw new SkillManagerError(
      "evolution_address_mismatch",
      `Proposal ${record.id} does not belong to ${input.scope}/${input.slug}.`,
    );
  }
}

function resolveProjectKey(projectKey: string | null | undefined): string {
  if (!projectKey) {
    throw new SkillManagerError("project_required", "Project scope requires projectKey.");
  }
  return resolve(projectKey);
}

function normalizeDraftContent(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new SkillManagerError("evolution_invalid_output", "The proposal did not contain SKILL.md content.");
  }
  return value.endsWith("\n") ? value : `${value}\n`;
}

function normalizeRequiredText(value: unknown, max: number, field: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new SkillManagerError("evolution_invalid_output", `${field} is required.`);
  }
  const normalized = value.trim();
  return normalized.length > max ? normalized.slice(0, max) : normalized;
}

function normalizeOptionalText(
  value: unknown,
  max: number,
  field: string,
): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") {
    throw new SkillManagerError("invalid_input", `${field} must be a string.`);
  }
  const normalized = value.trim();
  if (!normalized) return undefined;
  if (normalized.length > max) {
    throw new SkillManagerError("invalid_input", `${field} exceeds ${max} characters.`);
  }
  return normalized;
}

function validateEntityId(value: string, field: string): void {
  if (!/^[A-Za-z0-9_-]{1,160}$/u.test(value)) {
    throw new SkillManagerError("invalid_input", `${field} is invalid.`);
  }
}

function clampLimit(value: number | undefined): number {
  if (value === undefined) return DEFAULT_STATUS_LIMIT;
  if (!Number.isInteger(value) || value <= 0) {
    throw new SkillManagerError("invalid_input", "limit must be a positive integer.");
  }
  return Math.min(value, MAX_STATUS_LIMIT);
}

function makeId(kind: "proposal" | "revision", at: string, uuid: string): string {
  return `${kind}_${at.replace(/[-:.TZ]/gu, "").slice(0, 17)}_${uuid.replace(/-/gu, "").slice(0, 12)}`;
}

function hashContent(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await fs.mkdir(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  try {
    await fs.writeFile(tmp, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    await fs.rename(tmp, path);
  } finally {
    await fs.rm(tmp, { force: true }).catch(() => undefined);
  }
}

async function readJsonDirectory<T>(dir: string): Promise<T[]> {
  let names: string[];
  try {
    names = await fs.readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const records: T[] = [];
  for (const name of names) {
    if (!name.endsWith(".json")) continue;
    try {
      records.push(JSON.parse(await fs.readFile(join(dir, name), "utf8")) as T);
    } catch {
      // Ignore incomplete/corrupt metadata; SKILL.md remains authoritative.
    }
  }
  return records;
}

async function isStaleLock(path: string, nowMs: number): Promise<boolean> {
  try {
    return nowMs - (await fs.stat(path)).mtimeMs > STALE_LOCK_MS;
  } catch {
    return true;
  }
}
