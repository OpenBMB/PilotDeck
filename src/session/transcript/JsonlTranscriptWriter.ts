import { randomUUID } from "node:crypto";
import { mkdir, appendFile } from "node:fs/promises";
import { basename, dirname, join, relative } from "node:path";
import type { CanonicalMessage } from "../../model/index.js";
import type { AgentTurnResult } from "../../agent/protocol/result.js";
import {
  classifyDurableMessageEntry,
  truncatePreview,
  SUBAGENT_PROMPT_PREVIEW_BYTES,
  SUBAGENT_SUMMARY_PREVIEW_BYTES,
  type AgentControlBoundaryTranscriptEntry,
  type AgentMessageTranscriptEntry,
  type AgentSubagentCompletedTranscriptEntry,
  type AgentSubagentStartedTranscriptEntry,
  type AgentTranscriptEntry,
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
  /**
   * Optional resolver mapping a subagentId → absolute sidechain path. Wired
   * by the parent session so {@link JsonlTranscriptWriter#forSubagent} can
   * derive a sidechain writer without the caller computing paths. Defaults
   * to `<dirname(path)>/<subagentId>.jsonl`.
   */
  subagentTranscriptPath?: (subagentId: string) => string;
};

export class JsonlTranscriptWriter implements AgentTranscriptWriter {
  private sequence = 0;
  private writeChain: Promise<void> = Promise.resolve();
  private lastEntryId: string | null = null;
  private readonly now: () => Date;

  constructor(private readonly options: JsonlTranscriptWriterOptions) {
    this.now = options.now ?? (() => new Date());
  }

  /**
   * Re-seed the writer's monotonic counters from a previously persisted
   * transcript so that new entries continue with unique, ascending values.
   * Called by the resume path after `readTranscript` has loaded the
   * existing entries.
   */
  restoreState(maxSequence: number, lastEntryId: string | null): void {
    this.sequence = maxSequence;
    this.lastEntryId = lastEntryId;
  }

  snapshotState(): AgentTranscriptWriterState {
    return {
      sequence: this.sequence,
      lastEntryId: this.lastEntryId,
    };
  }

  recordAcceptedInput(
    sessionId: string,
    turnId: string,
    messages: CanonicalMessage[],
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    return this.recordEntry({
      type: "accepted_input",
      ...this.baseEntry(sessionId, turnId),
      messages,
      ...(metadata && Object.keys(metadata).length > 0 ? { metadata } : {}),
    });
  }

  recordDurableMessage(sessionId: string, turnId: string, message: CanonicalMessage): Promise<void> {
    const type: AgentMessageTranscriptEntry["type"] = classifyDurableMessageEntry(message);
    return this.recordEntry({
      type,
      ...this.baseEntry(sessionId, turnId),
      message,
    });
  }

  recordAgentStatusMessage(
    sessionId: string,
    turnId: string,
    status: { event: string; kind: "status" | "error"; text: string; detail?: Record<string, unknown> },
  ): Promise<void> {
    return this.recordEntry({
      type: "agent_status_message",
      ...this.baseEntry(sessionId, turnId),
      event: status.event,
      kind: status.kind,
      text: status.text,
      ...(status.detail && Object.keys(status.detail).length > 0 ? { detail: status.detail } : {}),
    });
  }

  recordFileArtifacts(sessionId: string, turnId: string, artifacts: FileArtifact[]): Promise<void> {
    if (artifacts.length === 0) return Promise.resolve();
    return this.recordEntry({
      type: "file_artifacts",
      ...this.baseEntry(sessionId, turnId),
      artifacts,
    });
  }

  recordTurnResult(sessionId: string, turnId: string, result: AgentTurnResult): Promise<void> {
    return this.recordEntry({
      type: "turn_result",
      ...this.baseEntry(sessionId, turnId),
      result,
    });
  }

  recordSessionMetadata(sessionId: string, turnId: string, metadata: SessionMetadataValue): Promise<void> {
    return this.recordEntry({
      type: "session_metadata",
      ...this.baseEntry(sessionId, turnId),
      metadata,
    });
  }

  recordControlBoundary(
    sessionId: string,
    turnId: string,
    boundary: AgentControlBoundaryTranscriptEntry["boundary"],
  ): Promise<void> {
    return this.recordEntry({
      type: "control_boundary",
      ...this.baseEntry(sessionId, turnId),
      boundary,
    });
  }

  recordEntry(entry: AgentTranscriptEntry): Promise<void> {
    this.sequence = Math.max(this.sequence, entry.sequence);
    this.lastEntryId = entry.entryId ?? this.lastEntryId;
    this.writeChain = this.writeChain.then(async () => {
      await mkdir(dirname(this.options.path), { recursive: true, mode: 0o700 });
      await appendFile(this.options.path, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
    });
    return this.writeChain;
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
    const entry: AgentSubagentStartedTranscriptEntry = {
      type: "subagent_started",
      ...this.baseEntry(sessionId, turnId),
      subagentId: args.subagentId,
      subagentType: args.subagentType,
      promptPreview: preview,
      promptTruncated: truncated,
      transcriptRelativePath: args.transcriptRelativePath,
      subagentSessionId: args.subagentSessionId,
    };
    return this.recordEntry(entry);
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
    const entry: AgentSubagentCompletedTranscriptEntry = {
      type: "subagent_completed",
      ...this.baseEntry(sessionId, turnId),
      subagentId: args.subagentId,
      subagentType: args.subagentType,
      summaryPreview: preview,
      summaryTruncated: truncated,
      usage: args.usage,
      turns: args.turns,
      durationMs: args.durationMs,
      errored: args.errored,
    };
    return this.recordEntry(entry);
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
    const writer = new JsonlTranscriptWriter({ path, now: now ?? this.now });
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

  private baseEntry(
    sessionId: string,
    turnId: string,
  ): Pick<AgentTranscriptEntry, "sessionId" | "turnId" | "sequence" | "createdAt" | "entryId" | "parentEntryId"> {
    return {
      sessionId,
      turnId,
      sequence: ++this.sequence,
      createdAt: this.now().toISOString(),
      entryId: randomUUID(),
      parentEntryId: this.lastEntryId,
    };
  }
}

function defaultSubagentPath(parentPath: string, subagentId: string): string {
  // Default layout: <parentPath dirname>/<parentBaseStem>/subagents/<subagentId>.jsonl
  const dir = dirname(parentPath);
  const stem = basename(parentPath).replace(/\.jsonl$/i, "");
  return join(dir, stem, "subagents", `${subagentId}.jsonl`);
}
