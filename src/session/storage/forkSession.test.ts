import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  mkdtemp,
  rm,
  writeFile,
  readFile,
  mkdir,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { forkSession, ForkError } from "./forkSession.js";
import { sanitizeSessionIdForPath } from "./ProjectSessionStorage.js";
import { getPilotProjectChatDir } from "../../pilot/index.js";

let tmp: string;
let chatDir: string;

beforeEach(async () => {
  tmp = await mkdtemp(join(tmpdir(), "fork-test-"));
  // Pilot home and project root share the same fresh dir. The chat dir is
  // derived by getPilotProjectChatDir; we just need to ensure it exists so
  // the source JSONL can be written there.
  chatDir = getPilotProjectChatDir(tmp, tmp);
  await mkdir(chatDir, { recursive: true });
});

afterEach(async () => {
  await rm(tmp, { recursive: true, force: true });
});

function makeEntry(
  entryId: string,
  sessionId: string,
  sequence: number,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    entryId,
    sessionId,
    sequence,
    type: "session_metadata",
    turnId: `turn-${sequence}`,
    createdAt: new Date(Date.UTC(2024, 0, 1, 0, 0, sequence)).toISOString(),
    metadata: { title: `Entry ${sequence}` },
    ...extra,
  };
}

async function writeSourceJsonl(
  sessionId: string,
  entries: Record<string, unknown>[],
): Promise<string> {
  const safe = sanitizeSessionIdForPath(sessionId);
  const p = join(chatDir, `${safe}.jsonl`);
  const body = entries.map((e) => JSON.stringify(e)).join("\n") + "\n";
  await writeFile(p, body, "utf8");
  return p;
}

async function sha256(path: string): Promise<string> {
  const buf = await readFile(path);
  return createHash("sha256").update(buf).digest("hex");
}

async function readJsonl(path: string): Promise<Record<string, unknown>[]> {
  const text = await readFile(path, "utf8");
  const out: Record<string, unknown>[] = [];
  for (const line of text.split("\n")) {
    if (line.length === 0) continue;
    out.push(JSON.parse(line));
  }
  return out;
}

/**
 * Build a complete turn triple — accepted_input → assistant_message →
 * turn_result — with chained parentEntryIds. Each turn starts at `baseSeq`
 * and yields 3 sequential entries.
 */
function makeTurn(
  baseId: string,
  sessionId: string,
  baseSeq: number,
  turnId: string,
): Record<string, unknown>[] {
  return [
    makeEntry(`${baseId}-input`, sessionId, baseSeq, {
      type: "accepted_input",
      turnId,
      parentEntryId: null,
    }),
    makeEntry(`${baseId}-reply`, sessionId, baseSeq + 1, {
      type: "assistant_message",
      turnId,
      parentEntryId: `${baseId}-input`,
    }),
    makeEntry(`${baseId}-result`, sessionId, baseSeq + 2, {
      type: "turn_result",
      turnId,
      parentEntryId: `${baseId}-reply`,
    }),
  ];
}

describe("forkSession", () => {
  it("happy path: forks one-turn source at the assistant_message keeps the full turn", async () => {
    const entries = makeTurn("e", "src", 1, "turn-1");
    await writeSourceJsonl("src", entries);

    const result = await forkSession({
      pilotHome: tmp,
      projectRoot: tmp,
      sourceSessionId: "src",
      upToEntryId: "e-reply",
    });

    // Forking inside a turn keeps the whole turn triple.
    expect(result.entryCount).toBe(3);
    expect(result.forkedFromEntryId).toBe("e-reply");
    expect(result.newSessionId).toMatch(/^[0-9a-f-]{36}$/i);
    expect(result.newSafeId).toBe(sanitizeSessionIdForPath(result.newSessionId));

    const fileStat = await stat(result.newJsonlPath);
    expect(fileStat.isFile()).toBe(true);
    const lines = await readJsonl(result.newJsonlPath);
    expect(lines).toHaveLength(3);

    for (const line of lines) {
      expect(line.sessionId).toBe(result.newSessionId);
      expect(typeof line.entryId).toBe("string");
      expect((line.entryId as string).includes("__fork_")).toBe(true);
    }

    // Order preserved + ids deterministic from root (no stacking).
    const short = result.newSafeId.slice(0, 8).toLowerCase();
    expect(lines[0].entryId).toBe(`e-input__fork_${short}`);
    expect(lines[1].entryId).toBe(`e-reply__fork_${short}`);
    expect(lines[2].entryId).toBe(`e-result__fork_${short}`);

    // Non-touched fields preserved verbatim.
    expect(lines[0].type).toBe("accepted_input");
    expect(lines[0].sequence).toBe(1);
    expect(lines[0].turnId).toBe("turn-1");
  });

  it("fork at the first entry (accepted_input) keeps the full turn", async () => {
    const entries = makeTurn("e", "src", 1, "turn-1");
    await writeSourceJsonl("src", entries);

    const result = await forkSession({
      pilotHome: tmp,
      projectRoot: tmp,
      sourceSessionId: "src",
      upToEntryId: "e-input",
    });

    expect(result.entryCount).toBe(3);
    const lines = await readJsonl(result.newJsonlPath);
    expect(lines).toHaveLength(3);
    for (const l of lines) {
      expect((l.entryId as string).includes("__fork_")).toBe(true);
    }
  });

  it("fork at the last entry (turn_result) keeps the full transcript", async () => {
    // Two turns: fork at the last turn's turn_result → all 6 entries.
    const entries = [
      ...makeTurn("a", "src", 1, "turn-1"),
      ...makeTurn("b", "src", 4, "turn-2"),
    ];
    await writeSourceJsonl("src", entries);

    const result = await forkSession({
      pilotHome: tmp,
      projectRoot: tmp,
      sourceSessionId: "src",
      upToEntryId: "b-result",
    });

    expect(result.entryCount).toBe(6);
    const lines = await readJsonl(result.newJsonlPath);
    expect(lines).toHaveLength(6);
    expect(lines.map((l) => l.sequence)).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it("throws ForkError when upToEntryId is not in the source", async () => {
    const entries = [
      makeEntry("e1", "src", 1),
      makeEntry("e2", "src", 2),
    ];
    await writeSourceJsonl("src", entries);

    let caught: unknown;
    try {
      await forkSession({
        pilotHome: tmp,
        projectRoot: tmp,
        sourceSessionId: "src",
        upToEntryId: "missing",
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ForkError);
    expect((caught as Error).message).toContain("not found");
    expect((caught as Error).message).toContain("missing");
  });

  it("throws ForkError when the source file does not exist", async () => {
    let caught: unknown;
    try {
      await forkSession({
        pilotHome: tmp,
        projectRoot: tmp,
        sourceSessionId: "nope",
        upToEntryId: "e1",
      });
    } catch (e) {
      caught = e;
    }
    expect(caught).toBeInstanceOf(ForkError);
    expect((caught as Error).message).toContain("source session not found");
    expect((caught as Error).message).toContain("nope");
  });

  it("writes a sidecar meta.json with correct fork metadata", async () => {
    const entries = [
      makeEntry("e1", "src", 1),
      makeEntry("e2", "src", 2),
    ];
    await writeSourceJsonl("src", entries);

    const result = await forkSession({
      pilotHome: tmp,
      projectRoot: tmp,
      sourceSessionId: "src",
      upToEntryId: "e1",
      sourceSummary: "Hello world",
    });

    const metaStat = await stat(result.metaPath);
    expect(metaStat.isFile()).toBe(true);

    const meta = JSON.parse(await readFile(result.metaPath, "utf8"));
    expect(meta.forkedFrom.sessionId).toBe("src");
    expect(meta.forkedFrom.entryId).toBe("e1");
    expect(typeof meta.forkedFrom.forkedAt).toBe("string");
    expect(meta.customTitle.startsWith("Fork of ")).toBe(true);
    expect(meta.customTitle).toContain("Hello world");
  });

  it("falls back to a sourceSafeId-based customTitle when no sourceSummary is provided", async () => {
    const entries = [makeEntry("e1", "src", 1)];
    await writeSourceJsonl("src", entries);

    const result = await forkSession({
      pilotHome: tmp,
      projectRoot: tmp,
      sourceSessionId: "src",
      upToEntryId: "e1",
    });
    const meta = JSON.parse(await readFile(result.metaPath, "utf8"));
    expect(meta.customTitle.startsWith("Fork of ")).toBe(true);
    // Should not be the sourceSummary-derived "Fork of <text>" since none was given.
    expect(meta.customTitle).toBe("Fork of " + sanitizeSessionIdForPath("src").slice(0, 16));
  });

  it("leaves the source file unmodified after a fork", async () => {
    const entries = [
      makeEntry("e1", "src", 1),
      makeEntry("e2", "src", 2),
      makeEntry("e3", "src", 3),
    ];
    const sourcePath = await writeSourceJsonl("src", entries);
    const before = await sha256(sourcePath);

    await forkSession({
      pilotHome: tmp,
      projectRoot: tmp,
      sourceSessionId: "src",
      upToEntryId: "e2",
    });

    const after = await sha256(sourcePath);
    expect(after).toBe(before);
  });

  it("remaps parentEntryId chains correctly within a forked turn", async () => {
    // One full turn with proper parentEntryId chain input→reply→result.
    const entries = makeTurn("e", "src", 1, "turn-1");
    await writeSourceJsonl("src", entries);

    const result = await forkSession({
      pilotHome: tmp,
      projectRoot: tmp,
      sourceSessionId: "src",
      upToEntryId: "e-reply",
    });

    const lines = await readJsonl(result.newJsonlPath);
    expect(lines).toHaveLength(3);

    // accepted_input: parentEntryId was null in source → kept as null.
    const first = lines[0];
    const firstParent = first.parentEntryId;
    expect(firstParent === null || firstParent === undefined).toBe(true);

    // assistant_message: parent should be the new id of the accepted_input.
    expect(lines[1].parentEntryId).toBe(first.entryId);

    // turn_result: parent should be the new id of the assistant_message.
    expect(lines[2].parentEntryId).toBe(lines[1].entryId);
  });

  it("handles 1000 entries in under 5 seconds", async () => {
    // Every entry is a turn_result so each entry ends its own (degenerate)
    // turn. Forking at e500 stops right after copying that single entry.
    const N = 1000;
    const entries: Record<string, unknown>[] = [];
    for (let i = 1; i <= N; i++) {
      entries.push(makeEntry(`e${i}`, "src", i, { type: "turn_result" }));
    }
    await writeSourceJsonl("src", entries);

    const t0 = Date.now();
    const result = await forkSession({
      pilotHome: tmp,
      projectRoot: tmp,
      sourceSessionId: "src",
      upToEntryId: "e500",
    });
    const elapsed = Date.now() - t0;

    expect(result.entryCount).toBe(500);
    expect(elapsed).toBeLessThan(5000);

    const lines = await readJsonl(result.newJsonlPath);
    expect(lines).toHaveLength(500);
  });

  it("chain-fork: forks a fork and rewrites entryIds to use the new fork suffix", async () => {
    // First fork: original (one turn, 3 entries).
    const original = makeTurn("e", "orig", 1, "turn-1");
    await writeSourceJsonl("orig", original);

    const first = await forkSession({
      pilotHome: tmp,
      projectRoot: tmp,
      sourceSessionId: "orig",
      upToEntryId: "e-reply",
    });

    // Verify the first fork has __fork_ on every entryId.
    const firstLines = await readJsonl(first.newJsonlPath);
    expect(firstLines).toHaveLength(3);
    for (const l of firstLines) {
      expect((l.entryId as string).includes("__fork_")).toBe(true);
    }
    const firstShort = first.newSafeId.slice(0, 8).toLowerCase();
    expect(firstLines[1].entryId).toBe(`e-reply__fork_${firstShort}`);

    // Chain-fork: fork the fork using the entryId from the first fork.
    // The new file must use the *root* entryId "e-reply" + a fresh
    // __fork_<secondShortTag> suffix — NOT stack another suffix.
    const second = await forkSession({
      pilotHome: tmp,
      projectRoot: tmp,
      sourceSessionId: first.newSessionId,
      upToEntryId: `e-reply__fork_${firstShort}`,
    });

    expect(second.entryCount).toBe(3);
    const secondLines = await readJsonl(second.newJsonlPath);
    const secondShort = second.newSafeId.slice(0, 8).toLowerCase();
    expect(secondShort).not.toBe(firstShort);

    // The chain-fork's entryIds are rooted at the original "e-…" base, not
    // stacked with firstShort.
    expect(secondLines[0].entryId).toBe(`e-input__fork_${secondShort}`);
    expect(secondLines[1].entryId).toBe(`e-reply__fork_${secondShort}`);
    expect(secondLines[2].entryId).toBe(`e-result__fork_${secondShort}`);

    // Source fork is unchanged (sha256 before/after the chain-fork).
    const before = await sha256(first.newJsonlPath);
    const after = await sha256(first.newJsonlPath);
    expect(after).toBe(before);
  });

  it("chain-fork: rootEntryIdOf strips every nested __fork_ suffix", async () => {
    // Imported here so tests don't depend on each other's imports.
    const { rootEntryIdOf } = await import("./forkSession.js");
    expect(rootEntryIdOf("abc")).toBe("abc");
    expect(rootEntryIdOf("abc__fork_def456")).toBe("abc");
    expect(rootEntryIdOf("abc__fork_def456__fork_123abc")).toBe("abc");
    expect(rootEntryIdOf("abc__fork_DEADBE")).toBe("abc"); // case-insensitive

    // Suffix with non-hex chars (e.g. user content that happens to contain
    // "__fork_") is NOT treated as a fork suffix — leaves it intact.
    expect(rootEntryIdOf("abc__fork_xyz789")).toBe("abc__fork_xyz789");
  });

  it("chain-fork: parentEntryId pointing into a previous fork is remapped to the new fork", async () => {
    // Source is a fork whose turn_result's parentEntryId still carries the
    // previous fork's suffix. The chain-fork should strip the suffix to look
    // up the root, then write the new suffix into the cloned parent.
    const original = makeTurn("e", "orig", 1, "turn-1");
    await writeSourceJsonl("orig", original);

    const first = await forkSession({
      pilotHome: tmp,
      projectRoot: tmp,
      sourceSessionId: "orig",
      upToEntryId: "e-reply",
    });

    // Verify the first fork's turn_result.parentEntryId has the first
    // fork's suffix.
    const firstLines = await readJsonl(first.newJsonlPath);
    const firstShort = first.newSafeId.slice(0, 8).toLowerCase();
    expect(firstLines[2].parentEntryId).toBe(`e-reply__fork_${firstShort}`);

    // Chain-fork the entire first fork (no upToEntryId).
    const second = await forkSession({
      pilotHome: tmp,
      projectRoot: tmp,
      sourceSessionId: first.newSessionId,
    });

    const secondLines = await readJsonl(second.newJsonlPath);
    const secondShort = second.newSafeId.slice(0, 8).toLowerCase();

    // Every parentEntryId in the chain-fork now uses secondShort — never
    // firstShort. The chain-fork's parent chain is rooted at the new fork.
    expect(secondLines[0].parentEntryId === null || secondLines[0].parentEntryId === undefined).toBe(true);
    expect(secondLines[1].parentEntryId).toBe(`e-input__fork_${secondShort}`);
    expect(secondLines[2].parentEntryId).toBe(`e-reply__fork_${secondShort}`);

    // Sanity: no leaked firstShort anywhere in the chain-fork's entryIds.
    for (const l of secondLines) {
      expect((l.entryId as string).includes(`__fork_${firstShort}`)).toBe(false);
    }
  });
});
