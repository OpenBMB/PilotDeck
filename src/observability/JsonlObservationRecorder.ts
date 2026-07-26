import { randomUUID } from "node:crypto";
import { appendFile, chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type {
  ObservationBundlePaths,
  ObservationEvent,
  ObservationEventDraft,
  ObservationPriority,
  ObservationRecorder,
  ObservationRecorderStats,
} from "./protocol.js";
import { OBSERVATION_SCHEMA_VERSION } from "./protocol.js";
import { buildObservationTrajectory } from "./trajectory.js";
import { verifyObservationEvents } from "./verifier.js";

export type JsonlObservationRecorderOptions = {
  directory: string;
  campaignId?: string;
  variant?: string;
  producerVersion?: string;
  queueCapacity?: number;
  now?: () => Date;
  uuid?: () => string;
};

export class JsonlObservationRecorder implements ObservationRecorder {
  readonly paths: ObservationBundlePaths;
  private readonly queue: ObservationEvent[] = [];
  private readonly queueCapacity: number;
  private readonly now: () => Date;
  private readonly uuid: () => string;
  private sequence: number;
  private writeChain: Promise<void> = Promise.resolve();
  private drainScheduled = false;
  private gapPending = false;
  private readonly stats: ObservationRecorderStats = {
    acceptedEvents: 0,
    droppedEvents: 0,
    droppedByPriority: {},
    queueHighWatermark: 0,
    bytesWritten: 0,
    writeBatches: 0,
    writeErrors: [],
  };

  constructor(private readonly options: JsonlObservationRecorderOptions) {
    this.paths = {
      directory: options.directory,
      observations: join(options.directory, "observations.jsonl"),
      trajectory: join(options.directory, "trajectory.json"),
      integrity: join(options.directory, "integrity.json"),
    };
    this.queueCapacity = Math.max(64, options.queueCapacity ?? 4096);
    this.now = options.now ?? (() => new Date());
    this.uuid = options.uuid ?? randomUUID;
    this.sequence = readLastSequence(this.paths.observations);
  }

  emit(draft: ObservationEventDraft): ObservationEvent | undefined {
    const priority = draft.priority ?? "important";
    if (this.queue.length >= this.queueCapacity) {
      this.stats.droppedEvents += 1;
      this.stats.droppedByPriority[priority] = (this.stats.droppedByPriority[priority] ?? 0) + 1;
      this.gapPending = true;
      return undefined;
    }

    const event: ObservationEvent = {
      schemaVersion: OBSERVATION_SCHEMA_VERSION,
      eventId: this.uuid(),
      sequence: ++this.sequence,
      timestamp: this.now().toISOString(),
      ...(this.options.campaignId ? { campaignId: this.options.campaignId } : {}),
      ...(this.options.variant ? { variant: this.options.variant } : {}),
      ...(draft.runId ?? draft.turnId ? { runId: draft.runId ?? draft.turnId } : {}),
      sessionId: draft.sessionId,
      ...(draft.turnId ? { turnId: draft.turnId } : {}),
      ...(draft.spanId ? { spanId: draft.spanId } : {}),
      ...(draft.parentSpanId ? { parentSpanId: draft.parentSpanId } : {}),
      producer: {
        component: "pilotdeck-core",
        version: this.options.producerVersion ?? "unknown",
      },
      type: draft.type,
      priority,
      payload: draft.payload ?? {},
      security: {
        classification: draft.security?.classification ?? "internal",
        contentAvailable: draft.security?.contentAvailable ?? false,
        redactions: draft.security?.redactions ?? [],
      },
    };
    this.queue.push(event);
    this.stats.acceptedEvents += 1;
    this.stats.queueHighWatermark = Math.max(this.stats.queueHighWatermark, this.queue.length);
    this.scheduleDrain();
    return event;
  }

  async flush(): Promise<ObservationRecorderStats> {
    this.enqueueGapIfNeeded();
    while (this.queue.length > 0 || this.drainScheduled) {
      this.scheduleDrain();
      await this.writeChain;
    }
    return this.snapshotStats();
  }

  async finalize(): Promise<ObservationRecorderStats> {
    const stats = await this.flush();
    const events = await readObservationEvents(this.paths.observations);
    const trajectory = buildObservationTrajectory(events);
    const integrity = verifyObservationEvents(events, stats);
    await ensureObservationDirectory(this.paths.directory);
    await Promise.all([
      writeJsonAtomic(this.paths.trajectory, trajectory),
      writeJsonAtomic(this.paths.integrity, integrity),
    ]);
    return stats;
  }

  snapshotStats(): ObservationRecorderStats {
    return {
      ...this.stats,
      droppedByPriority: { ...this.stats.droppedByPriority },
      writeErrors: [...this.stats.writeErrors],
    };
  }

  private scheduleDrain(): void {
    if (this.drainScheduled || this.queue.length === 0) return;
    this.drainScheduled = true;
    this.writeChain = this.writeChain
      .then(async () => {
        await Promise.resolve();
        const batch = this.queue.splice(0);
        if (batch.length === 0) return;
        const body = `${batch.map((event) => JSON.stringify(event)).join("\n")}\n`;
        await ensureObservationDirectory(dirname(this.paths.observations));
        await appendFile(this.paths.observations, body, { encoding: "utf8", mode: 0o600 });
        await chmod(this.paths.observations, 0o600);
        this.stats.bytesWritten += Buffer.byteLength(body, "utf8");
        this.stats.writeBatches += 1;
      })
      .catch((error) => {
        this.stats.writeErrors.push(error instanceof Error ? error.message : String(error));
      })
      .finally(() => {
        this.drainScheduled = false;
        if (this.queue.length > 0) this.scheduleDrain();
      });
  }

  private enqueueGapIfNeeded(): void {
    if (!this.gapPending) return;
    this.gapPending = false;
    const event: ObservationEvent = {
      schemaVersion: OBSERVATION_SCHEMA_VERSION,
      eventId: this.uuid(),
      sequence: ++this.sequence,
      timestamp: this.now().toISOString(),
      ...(this.options.campaignId ? { campaignId: this.options.campaignId } : {}),
      ...(this.options.variant ? { variant: this.options.variant } : {}),
      sessionId: "recorder",
      producer: { component: "pilotdeck-core", version: this.options.producerVersion ?? "unknown" },
      type: "observation.gap",
      priority: "critical",
      payload: {
        droppedEvents: this.stats.droppedEvents,
        droppedByPriority: { ...this.stats.droppedByPriority },
      },
      security: { classification: "internal", contentAvailable: false, redactions: [] },
    };
    this.queue.push(event);
    this.stats.acceptedEvents += 1;
    this.stats.queueHighWatermark = Math.max(this.stats.queueHighWatermark, this.queue.length);
  }
}

export async function readObservationEvents(path: string): Promise<ObservationEvent[]> {
  if (!existsSync(path)) return [];
  const text = await readFile(path, "utf8");
  return text.split(/\r?\n/u).filter(Boolean).map((line) => JSON.parse(line) as ObservationEvent);
}

function readLastSequence(path: string): number {
  if (!existsSync(path)) return 0;
  try {
    const lines = readFileSync(path, "utf8").trim().split(/\r?\n/u);
    const last = lines.at(-1);
    if (!last) return 0;
    const parsed = JSON.parse(last) as { sequence?: unknown };
    return typeof parsed.sequence === "number" && Number.isSafeInteger(parsed.sequence) ? parsed.sequence : 0;
  } catch {
    return 0;
  }
}

async function writeJsonAtomic(path: string, value: unknown): Promise<void> {
  const temporary = `${path}.tmp`;
  await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
  await rename(temporary, path);
}

async function ensureObservationDirectory(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

export function countDroppedByPriority(
  stats: ObservationRecorderStats,
  priority: ObservationPriority,
): number {
  return stats.droppedByPriority[priority] ?? 0;
}
