import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import type {
  StaffDeckSopBundle,
  StaffDeckSopResumeInput,
  StaffDeckSopResumeResult,
  StaffDeckSopReplyDelivery,
  StaffDeckSopState,
  StaffDeckSopSubmitResult,
  StaffDeckSopStatusSnapshot,
  StaffDeckSopWait,
} from "./types.js";

type PersistedSopState = Readonly<{
  schemaVersion: 3;
  sessionId: string;
  bundle: StaffDeckSopBundle;
  state: StaffDeckSopState;
  revision: number;
  wait?: StaffDeckSopWait;
  replyDelivery?: StaffDeckSopReplyDelivery;
  resumeRequests: Record<string, StaffDeckSopResumeResult>;
  updatedAt: string;
}>;

/** Host-owned, per-session SOP state and definition snapshot store. */
export class SopStateStore {
  private static readonly sessionLocks = new Map<string, Promise<void>>();

  constructor(private readonly root: string) {}

  async loadOrCreate(
    sessionId: string,
    bundle: StaffDeckSopBundle,
    defaultSopId: string,
  ): Promise<PersistedSopState> {
    return this.withSessionLock(sessionId, () => this.loadOrCreateUnlocked(sessionId, bundle, defaultSopId));
  }

  async replace(
    sessionId: string,
    bundle: StaffDeckSopBundle,
    state: StaffDeckSopState,
  ): Promise<PersistedSopState> {
    return this.withSessionLock(sessionId, () => this.replaceUnlocked(sessionId, bundle, state));
  }

  async commitSubmission(
    sessionId: string,
    bundle: StaffDeckSopBundle,
    state: StaffDeckSopState,
    expectedRevision: number,
    turnId: string,
    result: StaffDeckSopSubmitResult,
  ): Promise<PersistedSopState> {
    return this.withSessionLock(sessionId, async () => {
      const current = await this.read(sessionId);
      const currentRevision = current?.revision ?? 0;
      if (currentRevision !== expectedRevision) {
        throw sopStateError("SOP_REVISION_CONFLICT", `Expected SOP revision ${expectedRevision}, found ${currentRevision}.`);
      }
      const revision = currentRevision + 1;
      const now = new Date().toISOString();
      const wait = waitForState(state, current?.wait);
      const next: PersistedSopState = {
        schemaVersion: 3,
        sessionId,
        bundle: structuredClone(bundle),
        state: structuredClone(state),
        revision,
        ...(wait ? { wait } : {}),
        replyDelivery: {
          turnId,
          phase: "pending",
          result: structuredClone(result),
          committedAt: now,
        },
        resumeRequests: current?.resumeRequests ?? {},
        updatedAt: now,
      };
      await this.write(next);
      return next;
    });
  }

  async replyDelivery(sessionId: string): Promise<StaffDeckSopReplyDelivery | undefined> {
    return this.withSessionLock(sessionId, async () => {
      const current = await this.read(sessionId);
      return current?.replyDelivery ? structuredClone(current.replyDelivery) : undefined;
    });
  }

  async markReplyDurable(
    sessionId: string,
    expectedTurnId: string,
    deliveredTurnId = expectedTurnId,
  ): Promise<StaffDeckSopReplyDelivery> {
    return this.withSessionLock(sessionId, async () => {
      const current = await this.read(sessionId);
      if (!current?.replyDelivery || current.replyDelivery.turnId !== expectedTurnId) {
        throw sopStateError("SOP_REPLY_DELIVERY_NOT_FOUND", `No StaffDeck SOP reply delivery exists for turn '${expectedTurnId}'.`);
      }
      if (current.replyDelivery.phase === "durable" && expectedTurnId === deliveredTurnId) {
        return structuredClone(current.replyDelivery);
      }
      const replyDelivery: StaffDeckSopReplyDelivery = {
        ...current.replyDelivery,
        turnId: deliveredTurnId,
        phase: "durable",
        durableAt: new Date().toISOString(),
      };
      await this.write({
        ...current,
        replyDelivery,
        updatedAt: replyDelivery.durableAt!,
      });
      return structuredClone(replyDelivery);
    });
  }

  async clearReplyDelivery(sessionId: string, turnId: string): Promise<void> {
    await this.withSessionLock(sessionId, async () => {
      const current = await this.read(sessionId);
      if (!current?.replyDelivery || current.replyDelivery.turnId !== turnId) return;
      const { replyDelivery: _replyDelivery, ...next } = current;
      await this.write({ ...next, updatedAt: new Date().toISOString() });
    });
  }

  async status(sessionId: string): Promise<StaffDeckSopStatusSnapshot | undefined> {
    return this.withSessionLock(sessionId, async () => {
      const persisted = await this.read(sessionId);
      return persisted ? toStatusSnapshot(persisted) : undefined;
    });
  }

  async resume(input: StaffDeckSopResumeInput): Promise<StaffDeckSopResumeResult> {
    return this.withSessionLock(input.sessionId, async () => {
      const current = await this.read(input.sessionId);
      if (!current) throw sopStateError("SOP_SESSION_NOT_FOUND", `No StaffDeck SOP state exists for '${input.sessionId}'.`);
      const duplicate = current.resumeRequests[input.requestId];
      if (duplicate) return { ...duplicate, duplicate: true };
      if (!current.wait) throw sopStateError("SOP_NOT_WAITING", "The StaffDeck SOP session is not waiting for a resumable result.");
      if (current.wait.id !== input.waitId) throw sopStateError("SOP_WAIT_STALE", "The StaffDeck SOP wait identifier is no longer active.");
      const expectedSource = current.wait.kind === "handoff" ? "human" : "external_task";
      if (input.source !== expectedSource) throw sopStateError("SOP_RESUME_SOURCE_INVALID", `This wait requires source '${expectedSource}'.`);
      if (input.expectedRevision !== undefined && input.expectedRevision !== current.revision) {
        throw sopStateError("SOP_REVISION_CONFLICT", `Expected SOP revision ${input.expectedRevision}, found ${current.revision}.`);
      }
      const revision = current.revision + 1;
      const result: StaffDeckSopResumeResult = {
        accepted: true,
        duplicate: false,
        sessionId: input.sessionId,
        requestId: input.requestId,
        revision,
        message: input.message,
      };
      await this.write({
        ...current,
        state: {
          ...current.state,
          status: "active",
          awaiting_input_json: null,
          slots_json: {
            ...(isRecord(current.state.slots_json) ? current.state.slots_json : {}),
            ...(input.slotUpdates ?? {}),
          },
        },
        revision,
        wait: undefined,
        resumeRequests: { ...current.resumeRequests, [input.requestId]: result },
        updatedAt: new Date().toISOString(),
      });
      return result;
    });
  }

  async recordSuccessfulTools(
    sessionId: string,
    bundle: StaffDeckSopBundle,
    defaultSopId: string,
    toolNames: readonly string[],
  ): Promise<PersistedSopState> {
    return this.withSessionLock(sessionId, async () => {
      const current = await this.loadOrCreateUnlocked(sessionId, bundle, defaultSopId);
      const existing = Array.isArray(current.state.successful_tool_names)
        ? current.state.successful_tool_names.filter((name): name is string => typeof name === "string" && name.length > 0)
        : [];
      const successful = [...new Set([...existing, ...toolNames.filter((name) => name.length > 0)])];
      return this.replaceUnlocked(sessionId, current.bundle, {
        ...current.state,
        successful_tool_names: successful,
      });
    });
  }

  private async loadOrCreateUnlocked(
    sessionId: string,
    bundle: StaffDeckSopBundle,
    defaultSopId: string,
  ): Promise<PersistedSopState> {
    const existing = await this.read(sessionId);
    if (existing) return existing;
    const created: PersistedSopState = {
      schemaVersion: 3,
      sessionId,
      bundle: structuredClone(bundle),
      state: {
        version: 1,
        selected_skill_id: defaultSopId,
        slots_json: {},
        skill_stack_json: [],
        successful_tool_names: [],
      },
      revision: 1,
      resumeRequests: {},
      updatedAt: new Date().toISOString(),
    };
    await this.write(created);
    return created;
  }

  private async replaceUnlocked(
    sessionId: string,
    bundle: StaffDeckSopBundle,
    state: StaffDeckSopState,
  ): Promise<PersistedSopState> {
    const current = await this.read(sessionId);
    const revision = (current?.revision ?? 0) + 1;
    const wait = waitForState(state, current?.wait);
    const next: PersistedSopState = {
      schemaVersion: 3,
      sessionId,
      bundle: structuredClone(bundle),
      state: structuredClone(state),
      revision,
      ...(wait ? { wait } : {}),
      ...(current?.replyDelivery ? { replyDelivery: current.replyDelivery } : {}),
      resumeRequests: current?.resumeRequests ?? {},
      updatedAt: new Date().toISOString(),
    };
    await this.write(next);
    return next;
  }

  private async withSessionLock<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    const lockKey = `${this.root}\u0000${sessionId}`;
    const previous = SopStateStore.sessionLocks.get(lockKey) ?? Promise.resolve();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const tail = previous.catch(() => undefined).then(() => gate);
    SopStateStore.sessionLocks.set(lockKey, tail);
    await previous.catch(() => undefined);
    try {
      return await operation();
    } finally {
      release?.();
      if (SopStateStore.sessionLocks.get(lockKey) === tail) SopStateStore.sessionLocks.delete(lockKey);
    }
  }

  private async read(sessionId: string): Promise<PersistedSopState | undefined> {
    const path = this.pathFor(sessionId);
    let content: string;
    try {
      content = await readFile(path, "utf8");
    } catch (error: unknown) {
      if (isErrno(error, "ENOENT")) return undefined;
      throw new Error(`Failed to read StaffDeck SOP state for '${sessionId}': ${messageOf(error)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (error) {
      throw new Error(`StaffDeck SOP state for '${sessionId}' is invalid JSON: ${messageOf(error)}`);
    }
    if (!isPersistedState(parsed) || parsed.sessionId !== sessionId) {
      throw new Error(`StaffDeck SOP state for '${sessionId}' has an invalid schema.`);
    }
    return migratePersistedState(parsed);
  }

  private async write(value: PersistedSopState): Promise<void> {
    await mkdir(this.root, { recursive: true });
    const target = this.pathFor(value.sessionId);
    const temporary = `${target}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(value)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
      await rename(temporary, target);
    } catch (error) {
      throw new Error(`Failed to persist StaffDeck SOP state for '${value.sessionId}': ${messageOf(error)}`);
    }
  }

  private pathFor(sessionId: string): string {
    // Transcript filenames intentionally coalesce punctuation for readability.
    // SOP snapshots need a one-to-one session key to avoid cross-session state.
    return join(this.root, `${Buffer.from(sessionId, "utf8").toString("base64url")}.json`);
  }
}

function isPersistedState(value: unknown): value is Record<string, unknown> & {
  schemaVersion: 1 | 2 | 3;
  sessionId: string;
  bundle: StaffDeckSopBundle;
  state: StaffDeckSopState;
} {
  if (!isRecord(value) || ![1, 2, 3].includes(value.schemaVersion as number) || typeof value.sessionId !== "string") return false;
  return isRecord(value.bundle) && Array.isArray(value.bundle.sops) && isRecord(value.state);
}

function migratePersistedState(value: ReturnType<typeof persistedStateShape>): PersistedSopState {
  const revision = typeof value.revision === "number" && Number.isInteger(value.revision) && value.revision > 0
    ? value.revision
    : 1;
  return {
    schemaVersion: 3,
    sessionId: value.sessionId,
    bundle: value.bundle,
    state: value.state,
    revision,
    ...(isWait(value.wait) ? { wait: value.wait } : {}),
    ...(isReplyDelivery(value.replyDelivery) ? { replyDelivery: value.replyDelivery } : {}),
    resumeRequests: isRecord(value.resumeRequests)
      ? Object.fromEntries(Object.entries(value.resumeRequests).filter((entry): entry is [string, StaffDeckSopResumeResult] => isResumeResult(entry[1])))
      : {},
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : new Date(0).toISOString(),
  };
}

function persistedStateShape(value: unknown) {
  return value as Record<string, unknown> & {
    schemaVersion: 1 | 2 | 3;
    sessionId: string;
    bundle: StaffDeckSopBundle;
    state: StaffDeckSopState;
  };
}

function waitForState(state: StaffDeckSopState, existing?: StaffDeckSopWait): StaffDeckSopWait | undefined {
  const status = state.status;
  const kind = status === "handoff" ? "handoff" : status === "waiting_external_task" ? "external_task" : undefined;
  if (!kind) return undefined;
  if (existing?.kind === kind) return existing;
  const awaiting = isRecord(state.awaiting_input_json) ? state.awaiting_input_json : {};
  return {
    id: randomUUID(),
    kind,
    ...(typeof state.active_skill_id === "string" ? { skillId: state.active_skill_id } : {}),
    ...(typeof state.active_step_id === "string" ? { stepId: state.active_step_id } : {}),
    createdAt: new Date().toISOString(),
    ...(typeof awaiting.wait_id === "string" ? { id: awaiting.wait_id } : {}),
  };
}

function toStatusSnapshot(value: PersistedSopState): StaffDeckSopStatusSnapshot {
  return {
    sessionId: value.sessionId,
    revision: value.revision,
    state: structuredClone(value.state),
    ...(value.wait ? { wait: structuredClone(value.wait) } : {}),
  };
}

function isWait(value: unknown): value is StaffDeckSopWait {
  return isRecord(value) && typeof value.id === "string"
    && (value.kind === "handoff" || value.kind === "external_task")
    && typeof value.createdAt === "string";
}

function isResumeResult(value: unknown): value is StaffDeckSopResumeResult {
  return isRecord(value) && value.accepted === true && typeof value.sessionId === "string"
    && typeof value.requestId === "string" && typeof value.revision === "number" && typeof value.message === "string";
}

function isReplyDelivery(value: unknown): value is StaffDeckSopReplyDelivery {
  return isRecord(value)
    && typeof value.turnId === "string"
    && (value.phase === "pending" || value.phase === "durable")
    && isRecord(value.result)
    && typeof value.result.status === "string"
    && typeof value.result.replyFragment === "string"
    && isRecord(value.result.slotUpdates)
    && Array.isArray(value.result.events)
    && typeof value.committedAt === "string"
    && (value.durableAt === undefined || typeof value.durableAt === "string");
}

function sopStateError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isErrno(error: unknown, code: string): boolean {
  return isRecord(error) && error.code === code;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
