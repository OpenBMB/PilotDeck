import { basename, dirname, join, relative } from "node:path";
import type { CanonicalMessage } from "../../model/index.js";
import type { AgentTurnResult } from "../../agent/protocol/result.js";
import { JsonlSessionEventStore } from "../events/JsonlSessionEventStore.js";
import { SessionRuntime } from "../events/SessionRuntime.js";
import type { SessionEventDraft, SessionEventStore } from "../events/SessionEventStore.js";
import {
  classifyDurableMessageEntry,
  truncatePreview,
  SUBAGENT_PROMPT_PREVIEW_BYTES,
  SUBAGENT_SUMMARY_PREVIEW_BYTES,
  type AgentControlBoundaryTranscriptEntry,
  type AgentFileSnapshotRecordedTranscriptEntry,
  type AgentMessageTranscriptEntry,
  type AgentSubagentCompletedTranscriptEntry,
  type AgentTranscriptEntry,
  type FileHistorySnapshotRecord,
  type SessionMetadataValue,
} from "./TranscriptEntry.js";
import type { AgentTranscriptWriter, AgentTranscriptWriterState } from "./TranscriptWriter.js";
import type { FileArtifact } from "../artifacts/FileArtifact.js";

export type SubagentTranscriptHandle = {
  /** UUID v4 of the subagent (matches sidechain filename). */
  subagentId: string;
  /** The sidechain writer (independent JSONL file). */
  writer: JsonlTranscriptWriter;
  /** Absolute path of the sidechain transcript. */
  transcriptPath: string;
};

export type JsonlTranscriptWriterOptions = {
  path: string;
  now?: () => Date;
  uuid?: () => string;
  eventStore?: SessionEventStore;
  /**
   * Optional durable append sink. When supplied, entries are serialized by
   * this writer but persisted by the owning host instead of the local JSONL
   * file. The sink must provide atomic append semantics for its key.
   */
  appendEntry?: (path: string, entry: AgentTranscriptEntry) => void | Promise<void>;
  /**
   * Optional resolver mapping a subagentId → absolute sidechain path. Wired
   * by the parent session so {@link JsonlTranscriptWriter#forSubagent} can
   * derive a sidechain writer without the caller computing paths. Defaults
   * to `<dirname(path)>/<subagentId>.jsonl`.
   */
  subagentTranscriptPath?: (subagentId: string) => string;
};

export class JsonlTranscriptWriter implements AgentTranscriptWriter {
  private readonly eventStore: SessionEventStore;
  private readonly now: () => Date;
  private writeTail: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(private readonly options: JsonlTranscriptWriterOptions) {
    this.now = options.now ?? (() => new Date());
    if (options.eventStore) {
      this.eventStore = options.eventStore;
    } else if (options.appendEntry) {
      const eventStore = new SessionRuntime({ now: this.now, uuid: options.uuid });
      eventStore.subscribe(
        (entry) => options.appendEntry!(options.path, entry),
        { failureMode: "propagate" },
      );
      this.eventStore = eventStore;
    } else {
      this.eventStore = new JsonlSessionEventStore({
        path: options.path,
        now: this.now,
        uuid: options.uuid,
      });
    }
  }

  /**
   * Re-seed the writer's monotonic counters from a previously persisted
   * transcript so that new entries continue with unique, ascending values.
   * Called by the resume path after `readTranscript` has loaded the
   * existing entries.
   */
  restoreState(maxSequence: number, lastEntryId: string | null): void {
    this.eventStore.restoreState({ sequence: maxSequence, lastEntryId });
  }

  snapshotState(): AgentTranscriptWriterState {
    return this.eventStore.snapshotState();
  }

  recordSessionEvent(sessionId: string, turnId: string, event: SessionEventDraft): Promise<void> {
    return this.append(sessionId, turnId, event);
  }

  recordAcceptedInput(
    sessionId: string,
    turnId: string,
    messages: CanonicalMessage[],
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    return this.append(sessionId, turnId, {
      type: "accepted_input",
      messages,
      ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
    });
  }

  recordDurableMessage(sessionId: string, turnId: string, message: CanonicalMessage): Promise<void> {
    const type: AgentMessageTranscriptEntry["type"] = classifyDurableMessageEntry(message);
    return this.append(sessionId, turnId, {
      type,
      message,
    });
  }

  recordAgentStatusMessage(
    sessionId: string,
    turnId: string,
    status: { event: string; kind: "status" | "error"; text: string; detail?: Record<string, unknown> },
  ): Promise<void> {
    return this.append(sessionId, turnId, {
      type: "agent_status_message",
      event: status.event,
      kind: status.kind,
      text: status.text,
      ...(status.detail && Object.keys(status.detail).length > 0 ? { detail: status.detail } : {}),
    });
  }

  recordFileArtifacts(sessionId: string, turnId: string, artifacts: FileArtifact[]): Promise<void> {
    if (artifacts.length === 0) return Promise.resolve();
    return this.append(sessionId, turnId, {
      type: "file_artifacts",
      artifacts,
    });
  }

  recordFileHistorySnapshot(
    sessionId: string,
    turnId: string,
    snapshot: FileHistorySnapshotRecord,
    snapshotKind: "create" | "update",
  ): Promise<void> {
    return this.append(sessionId, turnId, {
      type: "file_snapshot_recorded",
      snapshotKind,
      ...snapshot,
    });
  }

  recordTurnResult(sessionId: string, turnId: string, result: AgentTurnResult): Promise<void> {
    return this.append(sessionId, turnId, {
      type: "turn_result",
      result,
    });
  }

  recordSessionMetadata(sessionId: string, turnId: string, metadata: SessionMetadataValue): Promise<void> {
    return this.append(sessionId, turnId, {
      type: "session_metadata",
      metadata,
    });
  }

  recordControlBoundary(
    sessionId: string,
    turnId: string,
    boundary: AgentControlBoundaryTranscriptEntry["boundary"],
  ): Promise<void> {
    return this.append(sessionId, turnId, {
      type: "control_boundary",
      boundary,
    });
  }

  recordCompactionReplacement(
    sessionId: string,
    turnId: string,
    boundary: Extract<AgentControlBoundaryTranscriptEntry["boundary"], { kind: "compact"; subtype: "compact_boundary" }>,
    messages: CanonicalMessage[],
  ): Promise<void> {
    return this.append(sessionId, turnId, {
      type: "control_boundary",
      boundary: {
        ...boundary,
        snapshot: { version: 1, messages: messages.map((message) => structuredClone(message)) },
      },
    });
  }

  recordEntry(entry: AgentTranscriptEntry): Promise<void> {
    const stableEntry = structuredClone(entry);
    return this.enqueueWrite(() => this.eventStore.appendRecorded(stableEntry));
  }

  recordFileSnapshot(
    sessionId: string,
    turnId: string,
    snapshot: Omit<AgentFileSnapshotRecordedTranscriptEntry, "type" | "sessionId" | "turnId" | "sequence" | "createdAt" | "entryId" | "parentEntryId">,
  ): Promise<void> {
    return this.append(sessionId, turnId, { type: "file_snapshot_recorded", ...snapshot });
  }

  async close(): Promise<void> {
    this.closed = true;
    await this.writeTail.catch(() => undefined);
    await this.eventStore.flush();
  }

  /**
   * C3.S1 — record the parent-side `subagent_started` reference. The full
   * directive lives in the sidechain transcript; we keep only a truncated
   * preview to bound the parent transcript size.
   */
  async recordSubagentStarted(
    sessionId: string,
    turnId: string,
    args: {
      subagentId: string;
      subagentType: string;
      prompt: string;
      transcriptRelativePath: string;
      subagentSessionId?: string;
    },
  ): Promise<void> {
    const { preview, truncated } = truncatePreview(args.prompt, SUBAGENT_PROMPT_PREVIEW_BYTES);
    return this.append(sessionId, turnId, {
      type: "subagent_started",
      subagentId: args.subagentId,
      subagentType: args.subagentType,
      promptPreview: preview,
      promptTruncated: truncated,
      transcriptRelativePath: args.transcriptRelativePath,
      subagentSessionId: args.subagentSessionId,
    });
  }

  /** C3.S1 — record the parent-side `subagent_completed` reference. */
  async recordSubagentCompleted(
    sessionId: string,
    turnId: string,
    args: {
      subagentId: string;
      subagentType: string;
      summary: string;
      usage?: AgentSubagentCompletedTranscriptEntry["usage"];
      turns: number;
      durationMs: number;
      errored?: boolean;
    },
  ): Promise<void> {
    const { preview, truncated } = truncatePreview(args.summary, SUBAGENT_SUMMARY_PREVIEW_BYTES);
    return this.append(sessionId, turnId, {
      type: "subagent_completed",
      subagentId: args.subagentId,
      subagentType: args.subagentType,
      summaryPreview: preview,
      summaryTruncated: truncated,
      usage: args.usage,
      turns: args.turns,
      durationMs: args.durationMs,
      errored: args.errored,
    });
  }

  /**
   * C3.S2 — derive a sidechain writer for a forked subagent. The new writer
   * is independent (its own sequence counter, its own file path) so the
   * subagent's turn-by-turn entries do not interleave with the parent.
   */
  forSubagent(subagentId: string, now?: () => Date): SubagentTranscriptHandle {
    const path =
      this.options.subagentTranscriptPath?.(subagentId) ??
      defaultSubagentPath(this.options.path, subagentId);
    const writer = new JsonlTranscriptWriter({
      path,
      now: now ?? this.now,
      uuid: this.options.uuid,
      ...(this.options.appendEntry ? { appendEntry: this.options.appendEntry } : {}),
    });
    return { subagentId, writer, transcriptPath: path };
  }

  /**
   * Helper for emitting the relative path to the sidechain that goes into
   * `subagent_started.transcriptRelativePath`. Computed against the parent
   * transcript's directory.
   */
  relativeSubagentPath(subagentId: string): string {
    const sidechain =
      this.options.subagentTranscriptPath?.(subagentId) ??
      defaultSubagentPath(this.options.path, subagentId);
    return relative(dirname(this.options.path), sidechain);
  }

  private append(sessionId: string, turnId: string, event: SessionEventDraft): Promise<void> {
    // Capture before queuing IO. Compaction callers can release or reuse the
    // source message array as soon as this method returns.
    const stableEvent = structuredClone(event);
    return this.enqueueWrite(() => this.eventStore.append(sessionId, turnId, stableEvent).then(() => undefined));
  }

  private enqueueWrite(operation: () => Promise<void>): Promise<void> {
    if (this.closed) return Promise.resolve();
    const write = this.writeTail.then(() => this.closed ? undefined : operation());
    this.writeTail = write.then(() => undefined, () => undefined);
    return write;
  }
}

function defaultSubagentPath(parentPath: string, subagentId: string): string {
  // Default layout: <parentPath dirname>/<parentBaseStem>/subagents/<subagentId>.jsonl
  const dir = dirname(parentPath);
  const stem = basename(parentPath).replace(/\.jsonl$/i, "");
  return join(dir, stem, "subagents", `${subagentId}.jsonl`);
}
