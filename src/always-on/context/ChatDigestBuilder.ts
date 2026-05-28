import { join } from "node:path";
import { getPilotProjectChatDir } from "../../pilot/paths.js";
import { listProjectSessions, type SessionInfo } from "../../session/storage/SessionList.js";
import { readSessionLite } from "../../session/storage/SessionLiteReader.js";

export type ChatSessionDigest = {
  sessionId: string;
  alias: string;
  title: string;
  lastModified: string;
  userPrompts: string[];
};

export type ChatDigest = {
  generatedAt: string;
  sessions: ChatSessionDigest[];
  /** Short alias -> real sessionId, for tool input resolution. */
  aliasMap: Map<string, string>;
};

export type BuildChatDigestOptions = {
  projectRoot: string;
  pilotHome: string;
  maxSessions?: number;
  maxPromptsPerSession?: number;
  maxPromptLength?: number;
  /** Override for tests. */
  now?: () => Date;
};

const DEFAULT_MAX_SESSIONS = 10;
const DEFAULT_MAX_PROMPTS_PER_SESSION = 8;
const DEFAULT_MAX_PROMPT_LENGTH = 500;

const DIGEST_EXCLUDED_PREFIXES = ["always-on-execute:"];

/**
 * Build a structured digest of recent user chat sessions for injection
 * into the Always-On discovery prompt. Uses the lightweight head+tail
 * reader so it never reads more than 128 KB per session file.
 */
export async function buildChatDigest(
  options: BuildChatDigestOptions,
): Promise<ChatDigest> {
  const maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
  const maxPrompts = options.maxPromptsPerSession ?? DEFAULT_MAX_PROMPTS_PER_SESSION;
  const maxLen = options.maxPromptLength ?? DEFAULT_MAX_PROMPT_LENGTH;
  const now = (options.now ?? (() => new Date()))();

  const allSessions = await listProjectSessions({
    projectRoot: options.projectRoot,
    pilotHome: options.pilotHome,
    includeInternal: false,
  });
  const sessions = allSessions.filter(
    (s) => !DIGEST_EXCLUDED_PREFIXES.some((p) => s.sessionId.startsWith(p)),
  );

  const chatDir = getPilotProjectChatDir(options.projectRoot, options.pilotHome);
  const digests: ChatSessionDigest[] = [];
  const aliasMap = new Map<string, string>();
  let aliasCounter = 0;

  for (const session of sessions.slice(0, maxSessions)) {
    const lite = await readSessionLite(join(chatDir, `${session.sessionId}.jsonl`));
    if (!lite) continue;

    const prompts = extractAllUserPrompts(`${lite.head}\n${lite.tail}`, maxPrompts, maxLen);
    if (prompts.length === 0) continue;

    aliasCounter += 1;
    const alias = `chat_${aliasCounter}`;
    aliasMap.set(alias, session.sessionId);

    digests.push({
      sessionId: session.sessionId,
      alias,
      title: session.summary,
      lastModified: new Date(session.lastModified).toISOString(),
      userPrompts: prompts,
    });
  }

  return {
    generatedAt: now.toISOString(),
    sessions: digests,
    aliasMap,
  };
}

/**
 * Extract user prompt texts from JSONL head+tail content.
 *
 * Each accepted_input entry has the shape:
 * ```
 * { "type": "accepted_input", "messages": [{ "content": [{ "type": "text", "text": "..." }] }] }
 * ```
 *
 * We deduplicate by text identity (head and tail may overlap for small files).
 */
export function extractAllUserPrompts(
  source: string,
  maxPrompts: number,
  maxLength: number,
): string[] {
  const seen = new Set<string>();
  const prompts: string[] = [];

  for (const line of source.split(/\r?\n/)) {
    if (!line.includes('"type":"accepted_input"')) continue;
    try {
      const entry = JSON.parse(line) as {
        messages?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
      };
      const texts = entry.messages
        ?.flatMap((m) => m.content ?? [])
        .filter((b): b is { type: string; text: string } => b.type === "text" && typeof b.text === "string")
        .map((b) => b.text.trim())
        .filter((t) => t.length > 0) ?? [];

      for (const text of texts) {
        if (seen.has(text)) continue;
        seen.add(text);
        prompts.push(text.length > maxLength ? `${text.slice(0, maxLength)}...` : text);
        if (prompts.length >= maxPrompts) return prompts;
      }
    } catch {
      // malformed line — skip
    }
  }

  return prompts;
}
