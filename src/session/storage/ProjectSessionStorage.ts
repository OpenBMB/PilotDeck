import { resolve } from "node:path";
import { getPilotProjectChatDir } from "../../pilot/index.js";
import { JsonlTranscriptWriter } from "../transcript/JsonlTranscriptWriter.js";

export type AgentProjectSessionStorageOptions = {
  projectRoot: string;
  pilotHome: string;
  sessionId: string;
  now?: () => Date;
};

export type AgentProjectSessionStorage = {
  chatDir: string;
  transcriptPath: string;
  toolResultsDir: string;
  /**
   * Per-session directory for file-history backups (C4 / F5). Backups land
   * at `<fileHistoryDir>/<sha16(filePath)>@v<version>` and survive process
   * restarts. The `FileHistoryStore` lazily creates the dir on first
   * `trackEdit`.
   */
  fileHistoryDir: string;
  /**
   * Per-session directory for subagent sidechain transcripts (C3 §6.3).
   * Each forked subagent gets its own `<subagentId>.jsonl` here.
   */
  subagentsDir: string;
  subagentTranscriptPath(subagentId: string): string;
  transcript: JsonlTranscriptWriter;
};

/**
 * Sanitize a sessionId for safe use as a single filename component.
 *
 * sessionKeys for non-Web channels (TUI/CLI) embed the absolute project path,
 * e.g. `tui:project=/Users/foo/work/repo:default`. Without sanitization the
 * raw `/` characters make `path.resolve()` treat the sessionId as multiple
 * path segments, burying the transcript under
 * `chats/tui:project=/Users/foo/work/repo:default.jsonl` (a deep dir tree)
 * instead of a flat file. `listProjectSessions` then can't find these
 * sessions in its flat `chats/` scan.
 *
 * We replace **only** path-separator characters (`/` and `\`) so existing
 * keys like `web:s_<uuid>` (which legitimately use `:`) keep their
 * on-disk filenames unchanged and stay backward compatible.
 */
export function sanitizeSessionIdForPath(sessionId: string): string {
  // On Windows, `:` is reserved (drive letters / ADS) and cannot appear in
  // filenames.  Strip it alongside path separators so that TUI-style session
  // keys like `tui:project=/Users/foo:default` produce a single flat file.
  const illegal = process.platform === "win32" ? /[\\/:<>"|?*]+/g : /[\\/]+/g;
  return sessionId.replace(illegal, "-").replace(/^-+|-+$/g, "") || "session";
}

export function createAgentProjectSessionStorage(
  options: AgentProjectSessionStorageOptions,
): AgentProjectSessionStorage {
  const chatDir = getPilotProjectChatDir(options.projectRoot, options.pilotHome);
  const safeId = sanitizeSessionIdForPath(options.sessionId);
  const transcriptPath = resolve(chatDir, `${safeId}.jsonl`);
  // Keep large tool-result bodies inside the workspace so the agent can read
  // them back with read_file when the inline preview is insufficient. The
  // project-local .pilotdeck directory is gitignored and already within the
  // workspace path boundary enforced by read_file.
  const toolResultsDir = resolve(options.projectRoot, ".pilotdeck", "tool-results", safeId);
  const fileHistoryDir = resolve(chatDir, safeId, "file-history");
  const subagentsDir = resolve(chatDir, safeId, "subagents");
  const subagentTranscriptPath = (subagentId: string): string =>
    resolve(subagentsDir, `${sanitizeSessionIdForPath(subagentId)}.jsonl`);
  return {
    chatDir,
    transcriptPath,
    toolResultsDir,
    fileHistoryDir,
    subagentsDir,
    subagentTranscriptPath,
    transcript: new JsonlTranscriptWriter({
      path: transcriptPath,
      now: options.now,
      subagentTranscriptPath,
    }),
  };
}
