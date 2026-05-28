/**
 * C3.S5 — explicit replay entry-point for a forked subagent's sidechain
 * transcript. Lazy-loaded by callers (UI / SDK) when they want to show the
 * subagent's turn-by-turn history alongside the parent.
 *
 * Behavior:
 *   - Missing file → returns empty messages + a `transcript_missing` warning
 *     (old session compat).
 *   - File exists → returns the same `AgentTranscriptReplayResult` shape as
 *     the parent replay so callers can render uniformly.
 */

import { readTranscript } from "./TranscriptReader.js";
import {
  replayTranscriptEntries,
  type AgentTranscriptReplayResult,
} from "./TranscriptReplay.js";

export async function replaySubagentTranscript(
  path: string,
): Promise<AgentTranscriptReplayResult> {
  const { entries, diagnostics } = await readTranscript(path);
  const replay = replayTranscriptEntries(entries);
  return { ...replay, diagnostics: [...diagnostics, ...replay.diagnostics] };
}
